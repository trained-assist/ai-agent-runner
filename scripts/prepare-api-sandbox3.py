#!/usr/bin/env python3
"""Prepare only the fixed fresh sandbox3 namespace; never start a service."""
import json
import fcntl
import importlib.util
import os
from pathlib import Path
import pwd
import re
import socket
import shlex
import stat
import subprocess
import time
import tempfile
import urllib.error
import urllib.request
import sys

TARGET = 'agent-runner-api-sandbox3'
ACCOUNT = 'sandbox3-api'
ENV = Path('/etc/agent-runner/agent-runner-api-sandbox3.env')
REGISTRY = Path('/etc/agent-runner/key-registry-sandbox3.json')
UNIT = Path('/etc/systemd/system/agent-runner-api-sandbox3.service')
STATE = Path('/var/lib/agent-runner/sandbox3')
ROOT = Path('/opt/sb/ai-agent-runner-api-sandbox3')
PATHS = {'environment': ENV, 'registry': REGISTRY, 'unit': UNIT, 'state': STATE, 'runtime': ROOT}
NATIVE_URL = 'https://trained-assist-native-worker-sandbox3.skillset-apply.workers.dev'
STORAGE_CREDENTIALS = Path('/etc/agent-runner/profile-storage-sandbox3.json')
NATIVE_ENGINE = 'dynamic-ip-azure-agent-run'


def validate_request(value):
    if not isinstance(value, dict) or set(value) != {'schemaVersion', 'target', 'keyHash', 'delegationSecret'}:
        raise ValueError('sandbox3_prepare_request_invalid')
    if value['schemaVersion'] != 1 or value['target'] != TARGET:
        raise ValueError('sandbox3_prepare_target_invalid')
    if not isinstance(value['keyHash'], str) or not re.fullmatch('[a-f0-9]{64}', value['keyHash']):
        raise ValueError('sandbox3_prepare_key_hash_invalid')
    if not isinstance(value['delegationSecret'], str) or not re.fullmatch('[A-Za-z0-9_-]{32,128}', value['delegationSecret']):
        raise ValueError('sandbox3_prepare_delegation_invalid')
    return value


def require_fresh(paths):
    for path in paths.values():
        path = Path(path)
        if os.path.lexists(path):
            raise ValueError('sandbox3_prepare_namespace_exists')
        if path.parent.resolve(strict=True) != path.parent:
            raise ValueError('sandbox3_prepare_parent_not_canonical')


def write_exclusive(path, content, mode, uid=0, gid=0):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            fd = None
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        if fd is not None:
            os.close(fd)


def write_namespace(request, paths, uid, gid, operator_uid=0, operator_gid=0):
    require_fresh(paths)
    state, root = Path(paths['state']), Path(paths['runtime'])
    state.mkdir(mode=0o700); os.chown(state, uid, gid)
    root.mkdir(mode=0o755); os.chown(root, operator_uid, operator_gid)
    journal = state / 'admissions.jsonl'
    write_exclusive(journal, '', 0o600, uid, gid)
    registry = {'schemaVersion': 1, 'principals': [{'keyHash': request['keyHash'],
        'principalId': 'sandbox3-agent-api-principal', 'tenantId': 'sandbox3-acceptance-a-20261008',
        'profileId': 'integration-sandbox3-v1', 'scopes': ['runs:read', 'runs:write'], 'engines': ['mock-test']}]}
    write_exclusive(paths['registry'], json.dumps(registry) + '\n', 0o640, operator_uid, gid)
    environment = {'AGENT_API_HOST': '127.0.0.1', 'AGENT_API_PORT': '18883',
        'AGENT_API_KEY_REGISTRY': str(paths['registry']), 'AGENT_API_ADMISSION_LOG': str(journal),
        'AGENT_API_ENVIRONMENT': 'sandbox', 'AGENT_API_ENABLE_MOCK_TEST': 'true',
        'AGENT_API_PROFILE_DELEGATION_SECRET': request['delegationSecret']}
    write_exclusive(paths['environment'], ''.join(f'{key}={value}\n' for key, value in environment.items()),
                    0o600, operator_uid, operator_gid)
    current = root / 'current'
    unit = f"""[Unit]
Description=Isolated Sandbox3 Runner API
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User={ACCOUNT}
Group={ACCOUNT}
WorkingDirectory={current}
EnvironmentFile={paths['environment']}
ExecStart=/usr/local/bin/node {current}/dist/api/main.js
Restart=no
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths={state}
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
"""
    write_exclusive(paths['unit'], unit, 0o644, operator_uid, operator_gid)


def runtime_proof(root=ROOT):
    try:
        release = (root / 'current').resolve(strict=True)
        if root.resolve(strict=True) != root or release.parent != root / 'releases':
            return None, False
        manifest_path = release / 'candidate-manifest.json'
        if manifest_path.is_symlink() or manifest_path.stat().st_size > 65536:
            return None, False
        manifest = json.loads(manifest_path.read_text())
        source = manifest.get('sourceSha')
        if manifest.get('target') not in {'agent-runner-api-mcp-test', 'agent-runner-api-sandbox'} \
                or not isinstance(source, str) or not re.fullmatch('[a-f0-9]{40}', source) or release.name != source:
            return None, False
        process = subprocess.run(['systemctl', 'show', TARGET + '.service', '-p', 'MainPID', '--value'],
                                 capture_output=True, text=True, timeout=10)
        if process.returncode != 0 or not re.fullmatch('[1-9][0-9]{0,8}', process.stdout.strip()):
            return source, False
        pid = process.stdout.strip()
        args = Path('/proc/' + pid + '/cmdline').read_bytes().split(b'\0')
        expected = ['/usr/local/bin/node'.encode(), str(root / 'current/dist/api/main.js').encode(), b'']
        return source, args == expected and Path('/proc/' + pid + '/cwd').resolve(strict=True) == release
    except Exception:
        return None, False


def inspect():
    active = subprocess.run(['systemctl', 'is-active', TARGET + '.service'], capture_output=True, timeout=10)
    proxies = {}
    for name in ['caddy', 'nginx']:
        result = subprocess.run(['systemctl', 'is-active', name + '.service'], capture_output=True, timeout=10)
        proxies[name] = result.returncode == 0
    source, execution_verified = runtime_proof()
    failure = subprocess.run(['systemctl', 'show', TARGET + '.service', '-p', 'Result', '-p', 'ExecMainStatus'],
                             capture_output=True, text=True, timeout=10)
    details = dict(line.split('=', 1) for line in failure.stdout.splitlines() if '=' in line)
    known_results = {'success', 'exit-code', 'signal', 'timeout', 'resources', 'start-limit-hit'}
    failure_result = details.get('Result') if details.get('Result') in known_results else 'unknown'
    raw_status = details.get('ExecMainStatus', '')
    exit_status = int(raw_status) if raw_status.isdecimal() and 0 <= int(raw_status) <= 255 else None
    return {'schemaVersion': 1, 'target': TARGET, 'serviceActive': active.returncode == 0,
            'runtimeSourceSha': source, 'serviceExecSourceVerified': execution_verified,
            'serviceFailureResult': failure_result, 'serviceExitStatus': exit_status,
            'componentsExist': {name: os.path.lexists(path) for name, path in PATHS.items()},
            'proxyServicesActive': proxies, 'realExecutionVerified': False}


def nginx_tokens(text):
    """Parse only configuration grammar; never interpret variables or execute content."""
    tokens = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isspace():
            index += 1; continue
        if char == '#':
            end = text.find('\n', index); index = len(text) if end < 0 else end + 1; continue
        start = index
        if char in '{};':
            tokens.append((char, start, index + 1)); index += 1; continue
        if char in "\"'":
            quote = char; index += 1; value = ''
            while index < len(text) and text[index] != quote:
                if text[index] == '\\':
                    index += 1
                    if index >= len(text): raise ValueError('sandbox3_proxy_quote_incomplete')
                    escaped = text[index]
                    value += {'t': '\t', 'r': '\r', 'n': '\n', '\\': '\\', '"': '"', "'": "'"}.get(escaped, '\\' + escaped)
                    index += 1; continue
                value += text[index]; index += 1
            if index >= len(text): raise ValueError('sandbox3_proxy_quote_incomplete')
            index += 1; tokens.append((value, start, index)); continue
        value = ''; variable = False
        while index < len(text) and not text[index].isspace():
            char = text[index]
            if char == '\\':
                index += 1
                if index >= len(text): raise ValueError('sandbox3_proxy_token_escape_incomplete')
                escaped = text[index]
                value += {'t': '\t', 'r': '\r', 'n': '\n', '\\': '\\', '"': '"', "'": "'"}.get(escaped, '\\' + escaped)
                index += 1; continue
            if char == '{' and value.endswith('$'):
                variable = True
            elif char == '}' and variable:
                variable = False
            elif char in ';{}':
                break
            value += char; index += 1
        if variable: raise ValueError('sandbox3_proxy_variable_incomplete')
        tokens.append((value, start, index))
    return tokens


def nginx_nodes(text):
    tokens = nginx_tokens(text)
    def parse(index, nested=False):
        nodes = []; words = []; start = None
        while index < len(tokens):
            value, begin, end = tokens[index]; index += 1
            if value == '}':
                if not nested or words: raise ValueError('sandbox3_proxy_block_end_unexpected')
                return nodes, index, end
            if value in (';', '{'):
                if not words: raise ValueError('sandbox3_proxy_directive_missing')
                children = None
                if value == '{': children, index, end = parse(index, True)
                nodes.append({'name': words[0], 'args': words[1:], 'start': start, 'end': end, 'children': children})
                words = []; start = None
            else:
                if start is None: start = begin
                words.append(value)
        if nested or words: raise ValueError('sandbox3_proxy_directive_incomplete')
        return nodes, index, len(text)
    return parse(0)[0]


def nginx_route_targets(text):
    # nginx -T emits exact source boundaries. Raw content stays in memory.
    sources = re.split(r'^# configuration file ([^\n:]+):\n', text, flags=re.M)
    if len(sources) < 3 or len(sources) > 401: raise ValueError('sandbox3_proxy_source_boundaries_invalid')
    targets = []
    for index in range(1, len(sources), 2):
        path, content = sources[index:index + 2]
        def visit(nodes, parent=None):
            for node in nodes:
                children = node['children'] or []
                if node['name'] == 'server' and parent in (None, 'http'):
                    host = any(item['name'] == 'server_name' and '169-58-15-230.sslip.io' in item['args'] for item in children)
                    tls = any(item['name'] == 'listen' and 'ssl' in item['args']
                        and any(re.fullmatch(r'(?:[^:]+:)?443', arg) for arg in item['args']) for item in children)
                    legacy = any(item['name'] == 'location' and any(arg.startswith('/runner-mcp-test') for arg in item['args'])
                        and any(sub['name'] == 'proxy_pass' and sub['args'] in (['http://127.0.0.1:18882/'], ['http://127.0.0.1:18882'])
                            for sub in item['children'] or []) for item in children)
                    if host and tls:
                        targets.append({'path': path, 'content': content, 'server': node, 'legacyUpstreamMatched': legacy})
                if children: visit(children, node['name'])
        visit(nginx_nodes(content))
    return targets


def proxy_inspect():
    result = subprocess.run(['nginx', '-T'], capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise ValueError('sandbox3_proxy_config_unavailable')
    text = result.stdout
    if len(text.encode('utf-8')) > 2 * 1024 * 1024: raise ValueError('sandbox3_proxy_config_too_large')
    targets = nginx_route_targets(text)
    host = bool(re.search(r'server_name\s+[^;]*\b169-58-15-230\.sslip\.io\b', text))
    tls = bool(re.search(r'listen\s+[^;]*443[^;]*ssl', text))
    legacy_location = bool(re.search(r'location[^\{]*?/runner-mcp-test', text))
    new_location = bool(re.search(r'location[^\{]*?/runner-sandbox3', text))
    return {'schemaVersion': 1, 'target': TARGET, 'hostMentioned': host, 'tlsMentioned': tls,
            'legacyPathMentioned': legacy_location, 'sandbox3PathMentioned': new_location,
            'sandbox3UpstreamMentioned': '127.0.0.1:18883' in text,
            'qualifiedRouteTargetCount': min(len(targets), 100), 'publicRouteVerified': False}


PROXY_MARKER = '# trained-assist sandbox3 isolated route v1'
PROXY_BLOCK = """
    # trained-assist sandbox3 isolated route v1
    location = /runner-sandbox3 { return 308 /runner-sandbox3/; }
    location ^~ /runner-sandbox3/ {
        proxy_pass http://127.0.0.1:18883/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
"""


def proxy_updates(dump, originals):
    targets = nginx_route_targets(dump)
    if not 1 <= len(targets) <= 2: raise ValueError('sandbox3_proxy_target_ambiguous')
    if '/runner-sandbox3' in dump or any(PROXY_MARKER in original for original in originals.values()):
        raise ValueError('sandbox3_proxy_route_already_present')
    offsets = {}
    for target in targets:
        original = originals.get(target['path'])
        if original is None or target['content'].rstrip('\n') != original.rstrip('\n'):
            raise ValueError('sandbox3_proxy_source_changed')
        offset = target['server']['end'] - 1
        if offset >= len(original) or original[offset] != '}': raise ValueError('sandbox3_proxy_source_changed')
        offsets.setdefault(target['path'], []).append(offset)
    updates = {}
    for path, positions in offsets.items():
        if len(set(positions)) != len(positions): raise ValueError('sandbox3_proxy_target_ambiguous')
        updated = originals[path]
        for offset in sorted(positions, reverse=True):
            updated = updated[:offset] + PROXY_BLOCK + updated[offset:]
        nginx_nodes(updated)
        updates[path] = updated
    return updates


def proxy_update(dump, original):
    targets = nginx_route_targets(dump)
    if not targets or len(set(target['path'] for target in targets)) != 1:
        raise ValueError('sandbox3_proxy_target_ambiguous')
    path = targets[0]['path']
    return path, proxy_updates(dump, {path: original})[path]


def atomic_proxy_config(path, content, metadata):
    fd, temporary = tempfile.mkstemp(prefix='.sandbox3-route-', dir=str(path.parent))
    try:
        os.fchmod(fd, stat.S_IMODE(metadata.st_mode)); os.fchown(fd, metadata.st_uid, metadata.st_gid)
        with os.fdopen(fd, 'w') as handle:
            fd = None; handle.write(content); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if fd is not None: os.close(fd)
        if os.path.lexists(temporary): os.unlink(temporary)


def apply_proxy_configs(configs):
    for path, original, updated, metadata in configs:
        if path.read_bytes().decode('utf-8') != original: raise ValueError('sandbox3_proxy_source_changed')
    written = []
    try:
        for path, original, updated, metadata in configs:
            if path.read_bytes().decode('utf-8') != original: raise ValueError('sandbox3_proxy_source_changed')
            atomic_proxy_config(path, updated, metadata)
            written.append((path, original, updated, metadata))
        check = subprocess.run(['nginx', '-t'], capture_output=True, timeout=10)
        if check.returncode != 0: raise ValueError('sandbox3_proxy_validation_failed')
        reload = subprocess.run(['systemctl', 'reload', 'nginx.service'], capture_output=True, timeout=15)
        if reload.returncode != 0: raise ValueError('sandbox3_proxy_reload_failed')
    except Exception:
        # Restore the original config only if this operation's bytes still own the file.
        conflict = False
        for path, original, updated, metadata in reversed(written):
            if path.read_bytes().decode('utf-8') != updated:
                conflict = True
                continue
            atomic_proxy_config(path, original, metadata)
        if conflict: raise ValueError('sandbox3_proxy_rollback_conflict') from None
        check = subprocess.run(['nginx', '-t'], capture_output=True, timeout=10)
        if check.returncode == 0:
            subprocess.run(['systemctl', 'reload', 'nginx.service'], capture_output=True, timeout=15)
        raise


def apply_proxy_config(path, original, updated, metadata):
    apply_proxy_configs([(path, original, updated, metadata)])


def read_proxy_source(source):
    path = Path(source).resolve(strict=True)
    if not str(path).startswith('/etc/nginx/') or path.parent.resolve(strict=True) != path.parent:
        raise ValueError('sandbox3_proxy_config_path_unsafe')
    for parent in [path.parent, *path.parent.parents]:
        metadata = parent.stat()
        if metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError('sandbox3_proxy_config_path_unsafe')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, newline='') as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_nlink != 1 \
                or metadata.st_mode & 0o022 or metadata.st_size > 1024 * 1024:
            raise ValueError('sandbox3_proxy_config_path_unsafe')
        return path, handle.read(), metadata

def configure_proxy():
    source, verified = runtime_proof()
    if not verified or source != 'ab8e7a3da4efa45c2154d67423542a6974576f22':
        raise ValueError('sandbox3_proxy_runtime_not_verified')
    active = subprocess.run(['systemctl', 'is-active', 'nginx.service'], capture_output=True, timeout=10)
    if active.returncode != 0: raise ValueError('sandbox3_proxy_service_inactive')
    dump = subprocess.run(['nginx', '-T'], capture_output=True, text=True, timeout=10)
    if dump.returncode != 0 or len(dump.stdout.encode('utf-8')) > 2 * 1024 * 1024:
        raise ValueError('sandbox3_proxy_config_unavailable')
    targets = nginx_route_targets(dump.stdout)
    if not 1 <= len(targets) <= 2: raise ValueError('sandbox3_proxy_target_ambiguous')
    sources = {target['path']: read_proxy_source(target['path']) for target in targets}
    if len({value[0] for value in sources.values()}) != len(sources):
        raise ValueError('sandbox3_proxy_target_ambiguous')
    updates = proxy_updates(dump.stdout, {key: value[1] for key, value in sources.items()})
    # Unique root-only backups support two files without overwriting earlier evidence.
    backup = Path(tempfile.mkdtemp(prefix='sandbox3-proxy-backup-', dir='/etc/agent-runner'))
    configs = []
    for index, (key, updated) in enumerate(updates.items()):
        path, original, metadata = sources[key]
        write_exclusive(backup / (str(index) + '.conf'), original, 0o600, 0, 0)
        configs.append((path, original, updated, metadata))
    write_exclusive(backup / 'paths.json', json.dumps([str(config[0]) for config in configs]), 0o600, 0, 0)
    apply_proxy_configs(configs)
    return {'schemaVersion': 1, 'target': TARGET, 'proxyConfigured': True,
            'matchedServerCount': len(targets), 'changedFileCount': len(configs),
            'legacyConfigPreserved': True, 'serviceRestarted': False, 'publicRouteVerified': False}


def validate_native_request(value):
    keys = {'schemaVersion', 'target', 'workerToken', 'workerSha', 'profileGitHubToken',
            'storageBucket', 'storageCredentials'}
    if not isinstance(value, dict) or set(value) != keys or value.get('schemaVersion') != 1 or value.get('target') != TARGET:
        raise ValueError('sandbox3_native_request_invalid')
    for key in ['workerToken', 'profileGitHubToken']:
        if not isinstance(value[key], str) or not re.fullmatch('[A-Za-z0-9_.-]{32,300}', value[key]):
            raise ValueError('sandbox3_native_credential_invalid')
    if not isinstance(value['workerSha'], str) or not re.fullmatch('[a-f0-9]{40}', value['workerSha']):
        raise ValueError('sandbox3_native_source_invalid')
    bucket = value['storageBucket']
    if not isinstance(bucket, str) or not re.fullmatch('[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]', bucket) or '..' in bucket:
        raise ValueError('sandbox3_native_storage_target_invalid')
    credential = value['storageCredentials']
    if not isinstance(credential, dict) or credential.get('type') != 'service_account' \
            or not re.fullmatch('[a-z][a-z0-9-]{4,61}[a-z0-9]', str(credential.get('project_id', ''))) \
            or not re.fullmatch('[a-z0-9-]+@' + re.escape(credential['project_id']) + r'\.iam\.gserviceaccount\.com', str(credential.get('client_email', ''))) \
            or credential.get('token_uri') != 'https://oauth2.googleapis.com/token' \
            or not re.fullmatch(r'-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n?', str(credential.get('private_key', ''))):
        raise ValueError('sandbox3_native_storage_credential_invalid')
    return value


def private_text(path, expected_uid=0, mode=0o600):
    if path.parent.resolve(strict=True) != path.parent:
        raise ValueError('sandbox3_native_path_invalid')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, encoding='utf-8') as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != expected_uid \
                or stat.S_IMODE(metadata.st_mode) != mode or metadata.st_nlink != 1 or metadata.st_size > 65536:
            raise ValueError('sandbox3_native_file_invalid')
        return handle.read(), metadata


def parse_environment(text):
    values = {}
    for line in text.splitlines():
        if not line.strip() or line.startswith('#'): continue
        key, separator, value = line.partition('=')
        if not separator or not re.fullmatch('[A-Z][A-Z0-9_]*', key) or key in values:
            raise ValueError('sandbox3_native_environment_invalid')
        quoted = value.strip().startswith(('"', "'"))
        tokens = shlex.split(value) if quoted else []
        if quoted and len(tokens) != 1: raise ValueError('sandbox3_native_environment_invalid')
        values[key] = tokens[0] if quoted else value.strip()
    return values


def native_configuration(request, current_env, current_registry, ladder_token):
    required = {'AGENT_API_HOST': '127.0.0.1', 'AGENT_API_PORT': '18883',
        'AGENT_API_KEY_REGISTRY': str(REGISTRY), 'AGENT_API_ADMISSION_LOG': str(STATE / 'admissions.jsonl'),
        'AGENT_API_ENVIRONMENT': 'sandbox', 'AGENT_API_ENABLE_MOCK_TEST': 'true'}
    if any(current_env.get(key) != value for key, value in required.items()) \
            or set(current_env) != set(required) | {'AGENT_API_PROFILE_DELEGATION_SECRET'} \
            or not re.fullmatch('[A-Za-z0-9_-]{32,128}', current_env.get('AGENT_API_PROFILE_DELEGATION_SECRET', '')):
        raise ValueError('sandbox3_native_existing_environment_mismatch')
    if not re.fullmatch('[A-Za-z0-9_.-]{32,500}', ladder_token):
        raise ValueError('sandbox3_native_ladder_credential_invalid')
    principals = current_registry.get('principals') if isinstance(current_registry, dict) else None
    if not isinstance(current_registry, dict) or current_registry.get('schemaVersion') != 1 or not isinstance(principals, list) or len(principals) != 1:
        raise ValueError('sandbox3_native_registry_mismatch')
    principal = principals[0]
    if not isinstance(principal, dict) or principal.get('principalId') != 'sandbox3-agent-api-principal' \
            or principal.get('tenantId') != 'sandbox3-acceptance-a-20261008' \
            or principal.get('profileId') != 'integration-sandbox3-v1' \
            or principal.get('engines') != ['mock-test'] \
            or principal.get('scopes') != ['runs:read', 'runs:write'] \
            or not re.fullmatch('[a-f0-9]{64}', str(principal.get('keyHash', ''))):
        raise ValueError('sandbox3_native_registry_mismatch')
    registry = {**current_registry, 'principals': [{**principal,
        'engines': ['mock-test', NATIVE_ENGINE], 'scopes': ['runs:read', 'runs:write', 'profiles:provision']}]}
    values = {**current_env,
        'AGENT_API_WORKERS': json.dumps([{'engine': NATIVE_ENGINE, 'baseUrl': NATIVE_URL, 'token': request['workerToken']}]),
        'AGENT_API_ENGINE_CHAIN': NATIVE_ENGINE,
        'AGENT_API_PUBLIC_URL': 'https://169-58-15-230.sslip.io/runner-sandbox3',
        'AGENT_API_ENV': json.dumps({'LLM_LADDER_TOKEN': ladder_token}),
        'AGENT_API_PROFILE_WORKSPACE_ROOT': str(STATE / 'profiles'),
        'AGENT_API_PROFILE_OBJECT_BACKEND': 'gcs',
        'AGENT_API_PROFILE_REQUIRE_TENANT_ROUTE': 'true',
        'AGENT_API_PROFILE_TENANT_ROUTES_JSON': json.dumps({'sandbox3-acceptance-a-20261008': {
            'owner': 'trained-assist', 'tokenEnv': 'AGENT_API_PROFILE_GITHUB_TOKEN'}}),
        'AGENT_API_PROFILE_GITHUB_TOKEN': request['profileGitHubToken'],
        'GCS_BUCKET': request['storageBucket'], 'GOOGLE_APPLICATION_CREDENTIALS': str(STORAGE_CREDENTIALS)}
    return ''.join(key + "='" + value + "'\n" for key, value in values.items()), json.dumps(registry) + '\n'


FENCE_BLOCK = """
    # trained-assist sandbox3 isolated route v1
    location = /runner-sandbox3 { return 503; }
    location ^~ /runner-sandbox3/ { return 503; }
"""


def native_fence_updates(dump, originals):
    targets = nginx_route_targets(dump)
    if not 1 <= len(targets) <= 2: raise ValueError('sandbox3_native_proxy_target_ambiguous')
    counts = {}
    for target in targets:
        original = originals.get(target['path'])
        if original is None or target['content'].rstrip('\n') != original.rstrip('\n') \
                or PROXY_BLOCK not in original[target['server']['start']:target['server']['end']]:
            raise ValueError('sandbox3_native_proxy_source_mismatch')
        counts[target['path']] = counts.get(target['path'], 0) + 1
    if set(counts) != set(originals) or any(originals[path].count(PROXY_BLOCK) != count for path, count in counts.items()):
        raise ValueError('sandbox3_native_proxy_source_mismatch')
    return {path: original.replace(PROXY_BLOCK, FENCE_BLOCK) for path, original in originals.items()}


def require_terminal_journal():
    # Import the reviewed checker beside this operator; never restart unknown runs.
    spec = importlib.util.spec_from_file_location('sandbox3_journal', Path(__file__).with_name('check-api-sandbox-journal.py'))
    checker = importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)
    journal = STATE / 'admissions.jsonl'
    account = pwd.getpwnam(ACCOUNT)
    private_text(journal, account.pw_uid)
    if checker.unfinished_runs(journal): raise ValueError('sandbox3_native_admissions_unresolved')


def nginx_workers():
    result = subprocess.run(['systemctl', 'show', 'nginx.service', '-p', 'MainPID', '--value'], capture_output=True, text=True, timeout=10)
    if result.returncode != 0 or not re.fullmatch('[1-9][0-9]*', result.stdout.strip()):
        raise ValueError('sandbox3_native_proxy_process_invalid')
    master = result.stdout.strip()
    children = Path('/proc/' + master + '/task/' + master + '/children').read_text().split()
    workers = set()
    for pid in children:
        try:
            if Path('/proc/' + pid + '/cmdline').read_bytes().startswith(b'nginx: worker process'):
                workers.add(pid)
        except FileNotFoundError: pass
    if not workers: raise ValueError('sandbox3_native_proxy_process_invalid')
    return workers


def wait_for_nginx_drain(workers):
    deadline = time.monotonic() + 30
    while any(Path('/proc/' + pid).exists() for pid in workers):
        if time.monotonic() > deadline: raise ValueError('sandbox3_native_proxy_drain_timeout')
        time.sleep(0.2)


def verify_native_worker(request):
    # Node uses the same bounded Worker transport as our live probes. Secrets
    # travel only in the child environment, never argv or returned metadata.
    script = """const base='https://trained-assist-native-worker-sandbox3.skillset-apply.workers.dev';
try {
  const healthResponse=await fetch(base+'/healthz',{signal:AbortSignal.timeout(8000)});
  const h=await healthResponse.json();
  if(healthResponse.status!==200 || h.buildSha!==process.env.EXPECTED_WORKER_SHA || h.sandboxPolicy!=='free-only-v1'
      || h.configured!==true || h.repo!=='kobzevvv/opencode-gha-runner' || h.workflow!=='run-agent-sandbox3.yml') process.exit(1);
  const path='/v1/runs/run_sandbox3_auth_probe/status';
  const response=await fetch(base+path,{headers:{authorization:'Bearer '+process.env.NATIVE_WORKER_TOKEN},signal:AbortSignal.timeout(8000)});
  const status=await response.json();
  if(response.status!==200 || status.status!=='unknown') process.exit(1);
} catch {process.exit(1);}
"""
    result = subprocess.run(['/usr/local/bin/node', '--input-type=module', '-e', script],
        env={'EXPECTED_WORKER_SHA': request['workerSha'], 'NATIVE_WORKER_TOKEN': request['workerToken']},
        capture_output=True, timeout=20)
    if result.returncode != 0: raise ValueError('sandbox3_native_worker_source_or_auth_mismatch')


def configure_native(request):
    validate_native_request(request)
    source, verified = runtime_proof()
    if not verified or source != 'ab8e7a3da4efa45c2154d67423542a6974576f22':
        raise ValueError('sandbox3_native_runtime_not_verified')
    verify_native_worker(request)
    account = pwd.getpwnam(ACCOUNT)
    old_env, env_metadata = private_text(ENV)
    old_registry, registry_metadata = private_text(REGISTRY, mode=0o640)
    source_env, _ = private_text(Path('/etc/agent-runner/agent-runner-api-mcp-test.env'))
    source_pool = json.loads(parse_environment(source_env).get('AGENT_API_ENV', '{}'))
    new_env, new_registry = native_configuration(request, parse_environment(old_env), json.loads(old_registry), source_pool.get('LLM_LADDER_TOKEN', ''))
    if os.path.lexists(STORAGE_CREDENTIALS): raise ValueError('sandbox3_native_storage_credential_exists')
    require_terminal_journal()
    dump = subprocess.run(['nginx', '-T'], capture_output=True, text=True, timeout=10)
    if dump.returncode != 0 or len(dump.stdout.encode()) > 2 * 1024 * 1024:
        raise ValueError('sandbox3_native_proxy_config_unavailable')
    targets = nginx_route_targets(dump.stdout)
    sources = {target['path']: read_proxy_source(target['path']) for target in targets}
    if len({item[0] for item in sources.values()}) != len(sources):
        raise ValueError('sandbox3_native_proxy_target_ambiguous')
    updates = native_fence_updates(dump.stdout, {key: item[1] for key, item in sources.items()})
    configs = [(sources[key][0], sources[key][1], value, sources[key][2]) for key, value in updates.items()]
    backup = Path(tempfile.mkdtemp(prefix='sandbox3-native-backup-', dir='/etc/agent-runner'))
    write_exclusive(backup / 'environment', old_env, 0o600)
    write_exclusive(backup / 'registry', old_registry, 0o600)
    for index, config in enumerate(configs): write_exclusive(backup / (str(index) + '.conf'), config[1], 0o600)
    write_exclusive(backup / 'paths.json', json.dumps([str(config[0]) for config in configs]), 0o600)
    workers = nginx_workers()
    apply_proxy_configs(configs)
    # A pre-fence request can still be admitted by an old nginx worker. Hold the
    # fence until those workers exit, then inspect the durable journal again.
    wait_for_nginx_drain(workers)
    require_terminal_journal()
    subprocess.run(['systemctl', 'stop', TARGET + '.service'], check=True, capture_output=True, timeout=30)
    if subprocess.run(['systemctl', 'is-active', TARGET + '.service'], capture_output=True, timeout=10).returncode == 0:
        raise ValueError('sandbox3_native_service_still_active')
    require_terminal_journal()
    # No automatic rollback/restart: a failure keeps the public admission fence
    # and backups for an explicit operator repair; old shared services are untouched.
    with socket.socket() as listener: listener.bind(('127.0.0.1', 18883))
    if ENV.read_text() != old_env or REGISTRY.read_text() != old_registry:
        raise ValueError('sandbox3_native_config_changed')
    write_exclusive(STORAGE_CREDENTIALS, json.dumps(request['storageCredentials']) + '\n', 0o640, 0, account.pw_gid)
    atomic_proxy_config(ENV, new_env, env_metadata)
    atomic_proxy_config(REGISTRY, new_registry, registry_metadata)
    subprocess.run(['systemctl', 'start', TARGET + '.service'], check=True, capture_output=True, timeout=20)
    deadline = time.monotonic() + 15
    while True:
        source, verified = runtime_proof()
        healthy = False
        if verified and source == 'ab8e7a3da4efa45c2154d67423542a6974576f22':
            try:
                with urllib.request.urlopen('http://127.0.0.1:18883/healthz', timeout=2) as response:
                    healthy = response.status == 200
            except (OSError, urllib.error.URLError): pass
        if healthy: break
        if time.monotonic() > deadline: raise ValueError('sandbox3_native_started_source_or_health_failed')
        time.sleep(0.2)
    apply_proxy_configs([(path, fenced, original, metadata) for path, original, fenced, metadata in configs])
    return {'schemaVersion': 1, 'target': TARGET, 'nativeConfigured': True, 'runtimeSourceSha': source,
            'workerSourceSha': request['workerSha'], 'admissionFenceDrained': True,
            'oldSharedServiceChanged': False, 'modelCalled': False, 'realTelegramE2E': False}


def api_request(method, path, key, body=None, idempotency=None):
    headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
    if idempotency:
        headers['Idempotency-Key'] = idempotency
    request = urllib.request.Request('http://127.0.0.1:18883' + path,
        data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except Exception:
            raise ValueError('sandbox3_probe_response_invalid') from None
    except Exception:
        raise ValueError('sandbox3_probe_api_unreachable') from None


def mock_probe(key, client=api_request):
    tag = 'sandbox3-api-contract-probe-v1'
    status, _ = client('GET', '/v1/capabilities', 'synthetic-invalid-key')
    if status != 401:
        raise ValueError('sandbox3_probe_auth_refusal_missing')
    body = {'userTaskId': tag, 'conversationId': tag, 'engine': {'name': 'mock-test', 'adapterVersion': '1'},
            'envAllowlist': [], 'limits': {'timeoutMs': 5000}, 'input': {'inlinePrompt': 'Return exactly pong.'}}
    status, receipt = client('POST', '/v1/runs', key, body, tag)
    if status not in (200, 202) or not isinstance(receipt, dict) or receipt.get('userTaskId') != tag:
        raise ValueError('sandbox3_probe_receipt_invalid')
    run_id, request_id = receipt.get('runId'), receipt.get('requestId')
    if not isinstance(run_id, str) or not re.fullmatch('run_[a-f0-9-]{36}', run_id) \
            or not isinstance(request_id, str) or not re.fullmatch('req_[a-f0-9-]{36}', request_id):
        raise ValueError('sandbox3_probe_receipt_invalid')
    for _ in range(20):
        status, progress = client('GET', '/v1/runs/' + run_id + '/status', key)
        if status != 200:
            raise ValueError('sandbox3_probe_status_unavailable')
        if progress.get('state') in {'succeeded', 'failed', 'cancelled', 'unknown'}:
            break
        time.sleep(0.1)
    if progress.get('runId') != run_id or progress.get('userTaskId') != tag or progress.get('engine') != 'mock-test' \
            or progress.get('state') != 'succeeded' or progress.get('answer') != 'pong':
        raise ValueError('sandbox3_probe_not_terminal_pong')
    status, result = client('GET', '/v1/runs/' + run_id + '/result', key)
    if status != 200 or result.get('runId') != run_id or result.get('userTaskId') != tag \
            or result.get('outcome') != 'succeeded' or result.get('text') != 'pong' \
            or result.get('persistence') != 'not_required' or result.get('cleanup') != 'completed':
        raise ValueError('sandbox3_probe_result_contract_mismatch')
    status, replay = client('POST', '/v1/runs', key, body, tag)
    if status != 200 or replay.get('runId') != run_id or replay.get('requestId') != request_id or replay.get('deduplicated') is not True:
        raise ValueError('sandbox3_probe_replay_mismatch')
    status, events = client('GET', '/v1/runs/' + run_id + '/events', key)
    if status != 200 or events.get('runId') != run_id or not isinstance(events.get('events'), list):
        raise ValueError('sandbox3_probe_events_contract_mismatch')
    return {'schemaVersion': 1, 'target': TARGET, 'runId': run_id, 'requestId': request_id,
            'mockTerminalPong': True, 'idempotentReceipt': True, 'eventsReadable': True,
            'authRefusal': True, 'workerOrModelCalled': False, 'realTelegramE2E': False}


def main():
    try:
        if os.geteuid() != 0 or socket.gethostname().split('.')[0] != 'vmi3617957':
            raise ValueError('sandbox3_prepare_operator_target_invalid')
        if sys.argv[1:] in (['--prepare'], ['--configure-proxy'], ['--configure-native'], ['--mock-probe']):
            raise ValueError('sandbox3_prepare_retired_cloudflare_runner_api')
        if sys.argv[1:] == ['--configure-native']:
            text = sys.stdin.read(65537)
            if len(text.encode()) > 65536: raise ValueError('sandbox3_native_request_too_large')
            lock = os.open('/etc/agent-runner/.sandbox3-native-config.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(lock, 'w') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                print(json.dumps(configure_native(json.loads(text)))); return 0
        if sys.argv[1:] == ['--configure-proxy']:
            print(json.dumps(configure_proxy())); return 0
        if sys.argv[1:] == ['--proxy-inspect']:
            print(json.dumps(proxy_inspect())); return 0
        if sys.argv[1:] == ['--mock-probe']:
            source, running = runtime_proof()
            if source != 'ab8e7a3da4efa45c2154d67423542a6974576f22' or not running:
                raise ValueError('sandbox3_probe_runtime_not_verified')
            request = json.loads(sys.stdin.read(4097))
            if not isinstance(request, dict) or set(request) != {'schemaVersion', 'target', 'apiKey'} \
                    or request['schemaVersion'] != 1 or request['target'] != TARGET \
                    or not isinstance(request['apiKey'], str) or not re.fullmatch('ta_sb3_[A-Za-z0-9_-]{43}', request['apiKey']):
                raise ValueError('sandbox3_probe_request_invalid')
            print(json.dumps(mock_probe(request['apiKey']))); return 0
        if sys.argv[1:] == ['--inspect']:
            print(json.dumps(inspect())); return 0
        if sys.argv[1:] != ['--prepare']:
            raise ValueError('sandbox3_prepare_mode_invalid')
        text = sys.stdin.read(4097)
        if len(text.encode('utf-8')) > 4096:
            raise ValueError('sandbox3_prepare_request_too_large')
        request = validate_request(json.loads(text))
        require_fresh(PATHS)
        loaded = subprocess.run(['systemctl', 'show', TARGET + '.service', '-p', 'FragmentPath', '--value'],
                                capture_output=True, text=True, timeout=10)
        if loaded.stdout.strip():
            raise ValueError('sandbox3_prepare_service_exists')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 18883))
            try:
                account = pwd.getpwnam(ACCOUNT)
            except KeyError:
                subprocess.run(['useradd', '--system', '--user-group', '--home-dir', str(STATE),
                                '--shell', '/usr/sbin/nologin', ACCOUNT], check=True, capture_output=True, timeout=10)
                account = pwd.getpwnam(ACCOUNT)
            if account.pw_uid in (0, pwd.getpwnam('sandbox').pw_uid) or account.pw_gid == 0 \
                    or account.pw_dir != str(STATE) or account.pw_shell != '/usr/sbin/nologin':
                raise ValueError('sandbox3_prepare_service_account_mismatch')
            write_namespace(request, PATHS, account.pw_uid, account.pw_gid)
        subprocess.run(['systemctl', 'daemon-reload'], check=True, capture_output=True, timeout=10)
        print(json.dumps({'schemaVersion': 1, 'target': TARGET, 'namespacePrepared': True,
                          'serviceStarted': False, 'realExecutionEnabled': False}))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch('sandbox3_(prepare|probe|proxy|native)_[a-z_]+', str(error)) else 'sandbox3_prepare_failed'
        print(json.dumps({'schemaVersion': 1, 'target': TARGET, 'reasonCode': reason})); return 1


if __name__ == '__main__':
    sys.exit(main())
