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


def inspect():
    active = subprocess.run(['systemctl', 'is-active', TARGET + '.service'], capture_output=True, timeout=10)
    proxies = {}
    for name in ['caddy', 'nginx']:
        result = subprocess.run(['systemctl', 'is-active', name + '.service'], capture_output=True, timeout=10)
        proxies[name] = result.returncode == 0
    return {'schemaVersion': 1, 'target': TARGET, 'serviceActive': active.returncode == 0,
            'componentsExist': {name: os.path.lexists(path) for name, path in PATHS.items()},
            'proxyServicesActive': proxies, 'realExecutionVerified': False}


def main():
    try:
        if os.geteuid() != 0 or socket.gethostname().split('.')[0] != 'vmi3617957':
            raise ValueError('sandbox3_prepare_operator_target_invalid')
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
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch('sandbox3_prepare_[a-z_]+', str(error)) else 'sandbox3_prepare_failed'
        print(json.dumps({'schemaVersion': 1, 'target': TARGET, 'reasonCode': reason})); return 1


if __name__ == '__main__':
    sys.exit(main())
