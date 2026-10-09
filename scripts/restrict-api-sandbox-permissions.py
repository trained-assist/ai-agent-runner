#!/usr/bin/env python3
"""Explicit mode-only repair for two declared sandbox files; no service actions."""
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys

ENV_FILE = Path('/etc/agent-runner/agent-runner-api-mcp-test.env')
JOURNAL = Path('/var/lib/agent-runner/mcp-test/admissions.jsonl')


@contextmanager
def validated_file(path, expected_uids, component):
    fd = None
    try:
        path = Path(path)
        if path.resolve(strict=True) != path:
            raise ValueError(f'sandbox_permissions_{component}_not_canonical')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError(f'sandbox_permissions_{component}_not_unique_regular_file')
        if metadata.st_uid not in expected_uids:
            raise ValueError(f'sandbox_permissions_{component}_owner_mismatch')
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ValueError('sandbox_permissions_target_changed')
        yield fd, metadata
    except OSError:
        raise ValueError(f'sandbox_permissions_{component}_file_unavailable') from None
    finally:
        if fd is not None:
            os.close(fd)


def validate_environment(fd):
    with os.fdopen(os.dup(fd), encoding='utf-8') as handle:
        text = handle.read(1024 * 1024 + 1)
    if len(text.encode('utf-8')) > 1024 * 1024:
        raise ValueError('sandbox_permissions_environment_too_large')
    values = {}
    for line in text.splitlines():
        name, separator, value = line.partition('=')
        if separator:
            values[name.strip()] = value.strip().strip('\"\'')
    expected = {
        'AGENT_API_ENVIRONMENT': 'sandbox', 'AGENT_API_PORT': '18882',
        'AGENT_API_ADMISSION_LOG': str(JOURNAL),
        'AGENT_API_KEY_REGISTRY': '/etc/agent-runner/key-registry-mcp-test.json',
    }
    if values.get('NODE_ENV') == 'production' or any(values.get(name) != value for name, value in expected.items()):
        raise ValueError('sandbox_permissions_target_mismatch')


def restrict_files(env_path, journal_path, env_uids, journal_uid, trusted_groups):
    with ExitStack() as stack:
        # Validate both before changing either; root/service-owned env stays owned.
        env = stack.enter_context(validated_file(env_path, env_uids, 'environment'))
        journal = stack.enter_context(validated_file(journal_path, {journal_uid}, 'journal'))
        validate_environment(env[0])
        result = {}
        for component, path, (fd, metadata) in [('environment', Path(env_path), env), ('journal', Path(journal_path), journal)]:
            mode = stat.S_IMODE(metadata.st_mode)
            private = mode == 0o600 or (mode == 0o640 and metadata.st_gid in trusted_groups)
            if not private:
                os.fchmod(fd, 0o600)
            current = os.stat(path, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                raise ValueError('sandbox_permissions_target_changed')
            result[component] = 'already_private' if private else 'restricted'
        return result


def main():
    try:
        if sys.argv[1:] != ['--restrict']:
            raise ValueError('sandbox_permissions_mode_invalid')
        if os.geteuid() != 0 or socket.gethostname().split('.')[0] != 'vmi3617957':
            raise ValueError('sandbox_permissions_operator_target_mismatch')
        sandbox = pwd.getpwnam('sandbox')
        owner = subprocess.run(['systemctl', 'show', 'agent-runner-api-mcp-test.service',
                                '-p', 'User', '--value'], capture_output=True, text=True, timeout=10)
        if owner.returncode != 0 or owner.stdout.strip() != 'sandbox':
            raise ValueError('sandbox_permissions_service_owner_mismatch')
        result = restrict_files(ENV_FILE, JOURNAL, {0, sandbox.pw_uid}, sandbox.pw_uid, {0, sandbox.pw_gid})
        print(json.dumps({'schemaVersion': 1, 'target': 'agent-runner-api-mcp-test', 'components': result}))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch('sandbox_permissions_[a-z_]+', str(error)) else 'sandbox_permissions_failed'
        print(json.dumps({'schemaVersion': 1, 'target': 'agent-runner-api-mcp-test', 'reasonCode': reason}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
