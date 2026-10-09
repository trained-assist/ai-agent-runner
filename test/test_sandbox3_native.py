import contextlib
import importlib.util
import io
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_prepare', Path(__file__).parents[1] / 'scripts/prepare-api-sandbox3.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
SOURCE = 'ab8e7a3da4efa45c2154d67423542a6974576f22'
REQUEST = {'schemaVersion': 1, 'target': p.TARGET, 'workerToken': 'a' * 64,
    'workerSha': 'b' * 40, 'profileGitHubToken': 'c' * 64, 'storageBucket': 'existing-test-bucket',
    'storageCredentials': {'type': 'service_account', 'project_id': 'test-project',
        'client_email': 'fixture@test-project.iam.gserviceaccount.com',
        'token_uri': 'https://oauth2.googleapis.com/token',
        'private_key': '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'}}
ENV = {'AGENT_API_HOST': '127.0.0.1', 'AGENT_API_PORT': '18883',
    'AGENT_API_KEY_REGISTRY': str(p.REGISTRY), 'AGENT_API_ADMISSION_LOG': str(p.STATE / 'admissions.jsonl'),
    'AGENT_API_ENVIRONMENT': 'sandbox', 'AGENT_API_ENABLE_MOCK_TEST': 'true',
    'AGENT_API_PROFILE_DELEGATION_SECRET': 'd' * 64}
REGISTRY = {'schemaVersion': 1, 'principals': [{'keyHash': 'e' * 64,
    'principalId': 'sandbox3-agent-api-principal', 'tenantId': 'sandbox3-acceptance-a-20261008',
    'profileId': 'integration-sandbox3-v1', 'scopes': ['runs:read', 'runs:write'], 'engines': ['mock-test']}]}
CONFIG = 'server { listen 443 ssl; server_name 169-58-15-230.sslip.io;' + p.PROXY_BLOCK + '\nlocation /runner-mcp-test/ { proxy_pass http://127.0.0.1:18882/; } }\n'
PATH = '/etc/nginx/sites-enabled/runner'
DUMP = '# configuration file ' + PATH + ':\n' + CONFIG


class NativeConfigTests(unittest.TestCase):
    def test_worker_transport_keeps_credentials_out_of_argv_and_errors(self):
        result = type('Process', (), {'returncode': 0})()
        with patch.object(p.subprocess, 'run', return_value=result) as run:
            p.verify_native_worker(REQUEST)
            args = run.call_args.args[0]
            self.assertNotIn(REQUEST['workerToken'], json.dumps(args))
            self.assertEqual(set(run.call_args.kwargs['env']), {'EXPECTED_WORKER_SHA', 'NATIVE_WORKER_TOKEN'})
            script = args[-1]
        syntax = subprocess.run(['node', '--check', '--input-type=module'], input=script, capture_output=True, text=True)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        with patch.object(p.subprocess, 'run', return_value=type('Process', (), {'returncode': 1})()):
            with self.assertRaisesRegex(ValueError, '^sandbox3_native_worker_source_or_auth_mismatch$'):
                p.verify_native_worker(REQUEST)

    def test_fixed_target_and_storage_identity_validation(self):
        self.assertEqual(p.validate_native_request(REQUEST), REQUEST)
        for change in [{'target': 'agent-runner-api-mcp-test'}, {'workerToken': "x\nINJECT=value"},
                       {'storageBucket': 'invalid..bucket'}, {'storageCredentials': {
                           **REQUEST['storageCredentials'], 'token_uri': 'https://another.invalid/token'}}]:
            with self.assertRaisesRegex(ValueError, 'sandbox3_native_'):
                p.validate_native_request({**REQUEST, **change})

    def test_preserves_intake_key_and_delegation_and_separates_host_credentials(self):
        text, registry = p.native_configuration(REQUEST, ENV, REGISTRY, 'ladder_fixture_' + 'f' * 48)
        values = p.parse_environment(text)
        self.assertEqual(values['AGENT_API_PROFILE_DELEGATION_SECRET'], ENV['AGENT_API_PROFILE_DELEGATION_SECRET'])
        self.assertEqual(json.loads(registry)['principals'][0]['keyHash'], REGISTRY['principals'][0]['keyHash'])
        pool = json.loads(values['AGENT_API_ENV'])
        self.assertEqual(set(pool), {'LLM_LADDER_TOKEN'})
        self.assertNotIn(REQUEST['profileGitHubToken'], json.dumps(pool))
        self.assertNotIn(REQUEST['workerToken'], json.dumps(pool))
        self.assertEqual(values['AGENT_API_ENGINE_CHAIN'], p.NATIVE_ENGINE)
        self.assertEqual(json.loads(values['AGENT_API_WORKERS'])[0]['baseUrl'], p.NATIVE_URL)
        for change in [{'AGENT_API_PORT': '18882'}, {'AGENT_API_PROFILE_WORKSPACE_ROOT': '/shared'}]:
            with self.assertRaisesRegex(ValueError, 'existing_environment_mismatch'):
                p.native_configuration(REQUEST, {**ENV, **change}, REGISTRY, 'f' * 48)

    def test_fence_changes_only_the_existing_sandbox3_blocks(self):
        updates = p.native_fence_updates(DUMP, {PATH: CONFIG})
        self.assertEqual(updates[PATH].replace(p.FENCE_BLOCK, p.PROXY_BLOCK), CONFIG)
        self.assertIn('http://127.0.0.1:18882/', updates[PATH])
        for dump, original in [(DUMP, CONFIG + '# concurrent change'),
                               (DUMP.replace(p.PROXY_BLOCK, ''), CONFIG.replace(p.PROXY_BLOCK, ''))]:
            with self.assertRaisesRegex(ValueError, 'sandbox3_native_proxy_'):
                p.native_fence_updates(dump, {PATH: original})

    def test_drain_timeout_fails_with_no_service_operation(self):
        with patch.object(p.Path, 'exists', return_value=True), \
                patch.object(p.time, 'monotonic', side_effect=[0, 31]), \
                patch.object(p.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'proxy_drain_timeout'):
                p.wait_for_nginx_drain({'123'})
            run.assert_not_called()

    def test_admission_during_proxy_drain_refuses_stop_and_keeps_the_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root / 'nginx.conf'; config.write_text(CONFIG)
            backup = root / 'backup'; backup.mkdir()
            old_env = ''.join(k + '=' + v + '\n' for k, v in ENV.items())
            old_registry = json.dumps(REGISTRY)
            process = type('Process', (), {'returncode': 0, 'stdout': DUMP})()
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(p, 'runtime_proof', return_value=(SOURCE, True)))
                stack.enter_context(patch.object(p, 'verify_native_worker'))
                stack.enter_context(patch.object(p, 'private_text', side_effect=[(old_env, config.stat()),
                    (old_registry, config.stat()), ('AGENT_API_ENV=\'{"LLM_LADDER_TOKEN":"' + 'f' * 48 + '"}\'\n', config.stat())]))
                stack.enter_context(patch.object(p.pwd, 'getpwnam', return_value=type('Account', (), {'pw_gid': 123})()))
                run = stack.enter_context(patch.object(p.subprocess, 'run', return_value=process))
                stack.enter_context(patch.object(p, 'read_proxy_source', return_value=(config, CONFIG, config.stat())))
                stack.enter_context(patch.object(p.tempfile, 'mkdtemp', return_value=str(backup)))
                stack.enter_context(patch.object(p, 'write_exclusive'))
                stack.enter_context(patch.object(p.os.path, 'lexists', return_value=False))
                fence = stack.enter_context(patch.object(p, 'apply_proxy_configs'))
                stack.enter_context(patch.object(p, 'nginx_workers', return_value={'123'}))
                stack.enter_context(patch.object(p, 'wait_for_nginx_drain'))
                journal = stack.enter_context(patch.object(p, 'require_terminal_journal',
                    side_effect=[None, ValueError('sandbox3_native_admissions_unresolved')]))
                with self.assertRaisesRegex(ValueError, 'admissions_unresolved'):
                    p.configure_native(REQUEST)
                self.assertEqual(journal.call_count, 2)
                self.assertEqual(fence.call_count, 1)
                self.assertIn(p.FENCE_BLOCK, fence.call_args.args[0][0][2])
                self.assertEqual([call.args[0] for call in run.call_args_list], [['nginx', '-T']])
