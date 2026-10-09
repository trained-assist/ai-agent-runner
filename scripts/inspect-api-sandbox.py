#!/usr/bin/env python3
"""Read-only metadata for the declared MCP test API; never emits stored values."""
import json
import os
from pathlib import Path
import re
import shlex
import socket
import stat
import subprocess
import sys

TARGET = 'agent-runner-api-mcp-test'
ENV_FILE = Path('/etc/agent-runner/agent-runner-api-mcp-test.env')
JOURNAL = Path('/var/lib/agent-runner/mcp-test/admissions.jsonl')
MANIFEST = Path('/opt/sb/ai-agent-runner-api-mcp-test/current/candidate-manifest.json')
TERMINAL = {'succeeded', 'failed', 'cancelled'}
BINDINGS = (
    'AGENT_API_WORKERS', 'EXTERNAL_WORKER_URL', 'EXTERNAL_WORKER_TOKEN',
    'AGENT_API_PROFILE_WORKSPACE_ROOT', 'AGENT_API_PROFILE_OWNER',
    'AGENT_API_PROFILE_GITHUB_TOKEN', 'AGENT_API_PROFILE_TENANT_ROUTES_JSON',
    'AGENT_API_PROFILE_DELEGATION_SECRET', 'AGENT_API_PUBLIC_URL',
    'GCS_BUCKET', 'GOOGLE_APPLICATION_CREDENTIALS',
)


def read_regular(path, limit, private=True):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise ValueError('sandbox_inventory_file_unavailable') from None
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError('sandbox_inventory_not_regular_file')
        if private and stat.S_IMODE(metadata.st_mode) not in (0o600, 0o640):
            raise ValueError('sandbox_inventory_permissions_too_open')
        if metadata.st_size > limit:
            raise ValueError('sandbox_inventory_file_too_large')
        with os.fdopen(fd, encoding='utf-8') as handle:
            fd = None
            text = handle.read(limit + 1)
        if len(text.encode('utf-8')) > limit:
            raise ValueError('sandbox_inventory_file_too_large')
        return text
    except UnicodeError:
        raise ValueError('sandbox_inventory_invalid_encoding') from None
    finally:
        if fd is not None:
            os.close(fd)


def environment_metadata(text):
    values = {}
    try:
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            name, separator, value = line.partition('=')
            if not separator or not re.fullmatch(r'[A-Z][A-Z0-9_]*', name.strip()):
                raise ValueError()
            tokens = shlex.split(value, comments=False)
            # Unquoted JSON is retained verbatim; quoted systemd values are unwrapped.
            values[name.strip()] = tokens[0] if value.strip().startswith(('"', "'")) and len(tokens) == 1 else value.strip()
        workers = json.loads(values.get('AGENT_API_WORKERS', '[]'))
        pool = json.loads(values.get('AGENT_API_ENV', '{}'))
        if not isinstance(workers, list) or not isinstance(pool, dict):
            raise ValueError()
        engines = [entry.get('engine') for entry in workers if isinstance(entry, dict)]
        if len(engines) != len(workers) or any(engine not in {
            'dynamic-ip-azure-agent-run', 'azure-dynamic-ip-agent-run', 'eu-vm-agent-run',
            'ru-vm-agent-run', 'mock-test',
        } for engine in engines):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError('sandbox_inventory_environment_invalid') from None
    return {
        'bindingPresence': {name: bool(values.get(name)) for name in BINDINGS},
        'workerEngines': sorted(set(engines)),
        'ladderCredentialConfigured': bool(pool.get('LLM_LADDER_TOKEN')),
        'sandboxMode': values.get('AGENT_API_ENVIRONMENT') == 'sandbox',
        'mockTestEnabled': values.get('AGENT_API_ENABLE_MOCK_TEST') == 'true',
        'journalTargetMatches': values.get('AGENT_API_ADMISSION_LOG') == str(JOURNAL),
        'registryTargetMatches': values.get('AGENT_API_KEY_REGISTRY') == '/etc/agent-runner/key-registry-mcp-test.json',
        'portMatches': values.get('AGENT_API_PORT') == '18882',
        'profileOwnerIsSandbox': values.get('AGENT_API_PROFILE_OWNER') == 'profile-artifacts-sandbox',
    }


def journal_metadata(text):
    states = {}
    launched = set()
    try:
        for line in text.splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            if not isinstance(entry, dict):
                raise ValueError()
            kind = entry.get('kind')
            if kind == 'admission':
                record = entry.get('record')
                if not isinstance(record, dict) or record.get('schemaVersion') != 2:
                    raise ValueError()
                run = record.get('runId')
                if not isinstance(run, str) or not run or run in states:
                    raise ValueError()
                states[run] = 'queued'
            elif kind in {'prepared', 'launch_intent', 'dispatched', 'worker_log_cursor', 'completed'}:
                run = entry.get('runId')
                if not isinstance(run, str) or run not in states:
                    raise ValueError()
                if kind in {'launch_intent', 'dispatched'}:
                    launched.add(run)
                if kind == 'completed':
                    patch = entry.get('patch')
                    if not isinstance(patch, dict) or patch.get('state') not in TERMINAL | {'unknown'}:
                        raise ValueError()
                    states[run] = patch['state']
            else:
                raise ValueError()
    except (ValueError, TypeError):
        raise ValueError('sandbox_inventory_journal_invalid') from None
    unresolved = sum(state not in TERMINAL for state in states.values())
    return {
        'admissionCount': len(states), 'nonterminalAdmissionCount': unresolved,
        'unknownOutcomeCount': sum(state == 'unknown' for state in states.values()),
        'launchRecordedCount': len(launched), 'journalTerminalOnly': unresolved == 0,
    }


def inventory():
    if socket.gethostname().split('.')[0] != 'vmi3617957':
        raise ValueError('sandbox_inventory_host_mismatch')
    if os.geteuid() != 0:
        raise ValueError('sandbox_inventory_requires_root')
    env = environment_metadata(read_regular(ENV_FILE, 1024 * 1024))
    if not all(env[name] for name in ('journalTargetMatches', 'registryTargetMatches', 'portMatches', 'sandboxMode')):
        raise ValueError('sandbox_inventory_target_mismatch')
    journal = journal_metadata(read_regular(JOURNAL, 8 * 1024 * 1024))
    try:
        manifest = json.loads(read_regular(MANIFEST, 64 * 1024, private=False))
        sha = manifest.get('sourceSha')
        if manifest.get('target') != TARGET or not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{40}', sha):
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError('sandbox_inventory_manifest_invalid') from None
    active = subprocess.run(['systemctl', 'is-active', TARGET + '.service'], capture_output=True, timeout=10)
    return {'schemaVersion': 1, 'target': TARGET, 'sourceSha': sha,
            'serviceActive': active.returncode == 0, **env, **journal}


def main():
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in {'--inventory', '--require-terminal-journal'}:
            raise ValueError('sandbox_inventory_mode_invalid')
        result = inventory()
        print(json.dumps(result, sort_keys=True))
        if sys.argv[1] == '--require-terminal-journal' and not result['journalTerminalOnly']:
            return 1
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch('sandbox_inventory_[a-z_]+', str(error)) else 'sandbox_inventory_failed'
        print(json.dumps({'schemaVersion': 1, 'target': TARGET, 'reasonCode': reason, 'journalTerminalOnly': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
