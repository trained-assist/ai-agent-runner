#!/usr/bin/env python3
"""Prepare only the fixed fresh sandbox3 namespace; never start a service."""
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import time
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


def proxy_inspect():
    result = subprocess.run(['nginx', '-T'], capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise ValueError('sandbox3_proxy_config_unavailable')
    # Never return nginx config, certificate/key paths or configured header values.
    text = result.stdout
    host = bool(re.search(r'server_name\s+[^;]*\b169-58-15-230\.sslip\.io\b', text))
    tls = bool(re.search(r'listen\s+[^;]*443[^;]*ssl', text))
    legacy_location = bool(re.search(r'location[^\{]*?/runner-mcp-test', text))
    new_location = bool(re.search(r'location[^\{]*?/runner-sandbox3', text))
    return {'schemaVersion': 1, 'target': TARGET, 'hostMentioned': host, 'tlsMentioned': tls,
            'legacyPathMentioned': legacy_location, 'sandbox3PathMentioned': new_location,
            'sandbox3UpstreamMentioned': '127.0.0.1:18883' in text,
            'publicRouteVerified': False}


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
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch('sandbox3_(prepare|probe|proxy)_[a-z_]+', str(error)) else 'sandbox3_prepare_failed'
        print(json.dumps({'schemaVersion': 1, 'target': TARGET, 'reasonCode': reason})); return 1


if __name__ == '__main__':
    sys.exit(main())
