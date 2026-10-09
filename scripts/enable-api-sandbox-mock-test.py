#!/usr/bin/env python3
import os
import pathlib
import stat
import sys
import tempfile

ENV_PATH = '/etc/agent-runner/agent-runner-api-mcp-test.env'
UPDATES = {'AGENT_API_ENVIRONMENT': 'sandbox', 'AGENT_API_ENABLE_MOCK_TEST': 'true'}


def enable_mock_test(path: pathlib.Path) -> bool:
    if path.is_symlink() or not path.is_file():
        raise ValueError('sandbox_environment_not_regular_file')
    before = path.stat()
    if stat.S_IMODE(before.st_mode) & 0o077:
        raise ValueError('sandbox_environment_permissions_too_open')
    lines = path.read_text(encoding='utf-8').splitlines()
    values = {}
    for line in lines:
        if '=' in line and not line.lstrip().startswith('#'):
            name, value = line.split('=', 1)
            values[name] = value
    node_env = values.get('NODE_ENV', '').strip()
    if len(node_env) >= 2 and node_env[0] == node_env[-1] and node_env[0] in "\"'":
        node_env = node_env[1:-1]
    if node_env == 'production':
        raise ValueError('mock_test_forbidden_in_production')

    seen = set()
    output = []
    for line in lines:
        if '=' in line and not line.lstrip().startswith('#'):
            name, _ = line.split('=', 1)
            if name in UPDATES:
                if name not in seen:
                    output.append(f'{name}={UPDATES[name]}')
                    seen.add(name)
                continue
        output.append(line)
    for name, value in UPDATES.items():
        if name not in seen:
            output.append(f'{name}={value}')
    content = '\n'.join(output) + '\n'
    if path.read_text(encoding='utf-8') == content:
        return False

    fd, temp = tempfile.mkstemp(prefix='.runner-api-mcp-test.', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temp, before.st_uid, before.st_gid)
        os.chmod(temp, stat.S_IMODE(before.st_mode))
        os.replace(temp, path)
        dirfd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return True


def main() -> None:
    if os.geteuid() != 0 or len(sys.argv) != 2 or sys.argv[1] != ENV_PATH:
        raise ValueError('sandbox_environment_target_or_permission_invalid')
    changed = enable_mock_test(pathlib.Path(ENV_PATH))
    print('mock_test_sandbox_mode_enabled' if changed else 'mock_test_sandbox_mode_already_enabled')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) else 'sandbox_environment_update_failed'
        print(code, file=sys.stderr)
        raise SystemExit(1)
