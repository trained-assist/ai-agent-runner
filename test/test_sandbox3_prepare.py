import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).parents[1] / 'scripts/prepare-api-sandbox3.py')
prepare = importlib.util.module_from_spec(spec); spec.loader.exec_module(prepare)
REQUEST = {'schemaVersion': 1, 'target': 'agent-runner-api-sandbox3',
           'keyHash': 'a' * 64, 'delegationSecret': 'synthetic_private_delegation_secret_0123456789'}


class PrepareTests(unittest.TestCase):
    def test_fresh_namespace_is_private_and_no_existing_resource_is_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = {name: root / name for name in prepare.PATHS}
            old = root / 'old-shared'; old.write_text('preserve-old-state')
            prepare.write_namespace(REQUEST, paths, os.getuid(), os.getgid(), os.getuid(), os.getgid())
            self.assertEqual(old.read_text(), 'preserve-old-state')
            self.assertEqual(paths['environment'].stat().st_mode & 0o777, 0o600)
            self.assertEqual(paths['registry'].stat().st_mode & 0o777, 0o640)
            self.assertEqual((paths['state'] / 'admissions.jsonl').read_bytes(), b'')
            self.assertEqual((paths['state'] / 'admissions.jsonl').stat().st_mode & 0o777, 0o600)
            records = json.loads(paths['registry'].read_text())['principals']
            self.assertEqual(records[0]['engines'], ['mock-test'])
            self.assertNotIn('EXTERNAL_WORKER_TOKEN', paths['environment'].read_text())
            before = paths['environment'].read_bytes()
            with self.assertRaisesRegex(ValueError, 'sandbox3_prepare_namespace_exists'):
                prepare.write_namespace(REQUEST, paths, os.getuid(), os.getgid(), os.getuid(), os.getgid())
            self.assertEqual(paths['environment'].read_bytes(), before)

    def test_links_and_any_preexisting_component_refuse_before_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); paths = {name: root / name for name in prepare.PATHS}
            paths['registry'].symlink_to(root / 'missing-shared-registry')
            with self.assertRaisesRegex(ValueError, 'sandbox3_prepare_namespace_exists'):
                prepare.write_namespace(REQUEST, paths, os.getuid(), os.getgid())
            self.assertFalse(paths['state'].exists())
            self.assertFalse(paths['environment'].exists())

    def test_request_is_fixed_target_and_does_not_accept_raw_api_key_or_paths(self):
        for changes in [{'target': 'production'}, {'keyHash': 'raw-private-key'},
                        {'path': '/shared'}, {'delegationSecret': 'too-short'}]:
            with self.assertRaisesRegex(ValueError, 'sandbox3_prepare_'):
                prepare.validate_request({**REQUEST, **changes})
        self.assertEqual(prepare.validate_request(REQUEST), REQUEST)

    def test_runtime_source_proof_refuses_alias_and_foreign_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            outside = root / 'outside'; outside.mkdir(); (root / 'current').symlink_to(outside)
            self.assertEqual(prepare.runtime_proof(root), (None, False))
            (root / 'current').unlink()
            release = root / 'releases' / ('a' * 40); release.mkdir(parents=True)
            (root / 'current').symlink_to(release)
            manifest = release / 'candidate-manifest.json'
            manifest.write_text(json.dumps({'target': 'production', 'sourceSha': 'a' * 40}))
            self.assertEqual(prepare.runtime_proof(root), (None, False))
            manifest.write_text(json.dumps({'target': 'agent-runner-api-mcp-test', 'sourceSha': 'a' * 40}))
            result = type('Process', (), {'returncode': 0, 'stdout': '0'})()
            with patch.object(prepare.subprocess, 'run', return_value=result):
                self.assertEqual(prepare.runtime_proof(root), ('a' * 40, False))

    def test_mock_probe_uses_one_receipt_and_refuses_unknown_without_replay(self):
        tag = 'sandbox3-api-contract-probe-v1'
        run = 'run_' + 'a' * 8 + '-aaaa-aaaa-aaaa-' + 'a' * 12
        request = 'req_' + 'b' * 8 + '-bbbb-bbbb-bbbb-' + 'b' * 12
        for state in ['succeeded', 'unknown']:
            calls = []
            def client(method, path, key, body=None, idempotency=None):
                calls.append((method, path))
                if key == 'synthetic-invalid-key': return 401, {}
                if method == 'POST':
                    return (202 if calls.count((method, path)) == 1 else 200), {
                        'runId': run, 'requestId': request, 'userTaskId': tag,
                        'deduplicated': calls.count((method, path)) > 1}
                if path.endswith('/status'): return 200, {'runId': run, 'userTaskId': tag,
                    'engine': 'mock-test', 'state': state, 'answer': 'pong'}
                if path.endswith('/result'): return 200, {'runId': run, 'userTaskId': tag,
                    'outcome': 'succeeded', 'text': 'pong', 'persistence': 'not_required', 'cleanup': 'completed'}
                return 200, {'runId': run, 'events': []}
            if state == 'unknown':
                with self.assertRaisesRegex(ValueError, 'sandbox3_probe_not_terminal_pong'):
                    prepare.mock_probe('synthetic-key', client)
                self.assertEqual(sum(method == 'POST' for method, _ in calls), 1)
            else:
                result = prepare.mock_probe('synthetic-key', client)
                self.assertTrue(result['idempotentReceipt'])
                self.assertFalse(result['workerOrModelCalled'])
                self.assertFalse(result['realTelegramE2E'])
                self.assertNotIn('synthetic-key', json.dumps(result))

    def test_proxy_inspect_emits_only_markers_without_config_or_secrets(self):
        result = type('Process', (), {'returncode': 0, 'stdout': 'server_name 169-58-15-230.sslip.io; listen 443 ssl; proxy_set_header Authorization private-secret; location /runner-mcp-test/ {}'})()
        with patch.object(prepare.subprocess, 'run', return_value=result):
            report = prepare.proxy_inspect()
        self.assertTrue(report['hostMentioned'])
        self.assertTrue(report['legacyPathMentioned'])
        self.assertFalse(report['publicRouteVerified'])
        self.assertNotIn('private-secret', json.dumps(report))

    def test_cli_errors_never_emit_secret_exception_text(self):
        output = io.StringIO()
        with patch.object(prepare.os, 'geteuid', side_effect=RuntimeError(REQUEST['delegationSecret'])), \
                contextlib.redirect_stdout(output):
            self.assertEqual(prepare.main(), 1)
        self.assertEqual(json.loads(output.getvalue())['reasonCode'], 'sandbox3_prepare_failed')
        self.assertNotIn(REQUEST['delegationSecret'], output.getvalue())


if __name__ == '__main__':
    unittest.main()
