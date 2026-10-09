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
        result = type('Process', (), {'returncode': 0, 'stdout': '# configuration file /etc/nginx/nginx.conf:\nserver_name 169-58-15-230.sslip.io; listen 443 ssl; proxy_set_header Authorization private-secret; location /runner-mcp-test/ {}'})()
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


class ProxyGrammarTests(unittest.TestCase):
    def dump(self, config):
        return '# configuration file /etc/nginx/sites-enabled/runner:\n' + config

    def test_exact_host_and_tls_must_share_one_server(self):
        valid = "server { listen 443 ssl; server_name 169-58-15-230.sslip.io; location /runner-mcp-test/ { proxy_pass http://127.0.0.1:18882/; } }"
        targets = prepare.nginx_route_targets(self.dump(valid))
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0]['content'][targets[0]['server']['end'] - 1], '}')
        split = "server { listen 443 ssl; server_name other.invalid; location /runner-mcp-test/ { proxy_pass http://127.0.0.1:18882/; } } server { listen 80; server_name 169-58-15-230.sslip.io; }"
        self.assertEqual(prepare.nginx_route_targets(self.dump(split)), [])
        self.assertEqual(len(prepare.nginx_route_targets(self.dump(valid.replace('18882', '9999')))), 1)
        self.assertFalse(prepare.nginx_route_targets(self.dump(valid.replace('18882', '9999')))[0]['legacyUpstreamMatched'])
        self.assertEqual(len(prepare.nginx_route_targets(self.dump(valid + valid))), 2)

    def test_comments_and_quoted_braces_do_not_change_structure(self):
        valid = "# server { listen 443 ssl; }\nserver { listen 443 ssl; server_name '169-58-15-230.sslip.io'; add_header X-Test \"text with } # {\"; location /runner-mcp-test { proxy_pass http://127.0.0.1:18882; } }"
        self.assertEqual(len(prepare.nginx_route_targets(self.dump(valid))), 1)
        for invalid in ['server {', 'server { add_header X \"unfinished; }', 'server { listen 443 }']:
            with self.assertRaisesRegex(ValueError, 'sandbox3_proxy_'):
                prepare.nginx_route_targets(self.dump(invalid))

    def test_quoted_unknown_escape_cannot_forge_exact_hostname(self):
        config = r"server { listen 443 ssl; server_name '169\-58-15-230.sslip.io'; location /runner-mcp-test { proxy_pass http://127.0.0.1:18882; } }"
        self.assertEqual(prepare.nginx_route_targets(self.dump(config)), [])


class ProxyUpdateTests(unittest.TestCase):
    CONFIG = "server { listen 443 ssl; server_name 169-58-15-230.sslip.io; location /runner-mcp-test/ { proxy_pass http://127.0.0.1:18882/; } }\nserver { listen 80; server_name other.invalid; return 404; }\n"
    def dump(self, text):
        return '# configuration file /etc/nginx/sites-enabled/runner:\n' + text + '\n'

    def test_one_insertion_preserves_all_original_routes_and_bytes(self):
        path, updated = prepare.proxy_update(self.dump(self.CONFIG), self.CONFIG)
        self.assertEqual(path, '/etc/nginx/sites-enabled/runner')
        self.assertEqual(updated.replace(prepare.PROXY_BLOCK, '', 1), self.CONFIG)
        self.assertIn('proxy_pass http://127.0.0.1:18883/;', updated)
        self.assertEqual(len(prepare.nginx_nodes(updated)), 2)

    def test_conflict_ambiguity_and_changed_source_refuse(self):
        for dump, original in [(self.dump(self.CONFIG * 2), self.CONFIG * 2),
                               (self.dump(self.CONFIG), self.CONFIG + '# changed'),
                               (self.dump(self.CONFIG + '# /runner-sandbox3'), self.CONFIG + '# /runner-sandbox3')]:
            with self.assertRaisesRegex(ValueError, 'sandbox3_proxy_'):
                prepare.proxy_update(dump, original)

    def test_atomic_write_preserves_mode_and_replaces_only_target(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'nginx.conf'; path.write_text(self.CONFIG); path.chmod(0o600)
            other = Path(directory) / 'other'; other.write_text('unchanged')
            metadata = path.stat()
            prepare.atomic_proxy_config(path, 'updated', metadata)
            self.assertEqual(path.read_text(), 'updated')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(other.read_text(), 'unchanged')
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ['nginx.conf', 'other'])

    def test_failed_validation_restores_exact_original_before_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'nginx.conf'; path.write_text(self.CONFIG)
            process = lambda code: type('Process', (), {'returncode': code})()
            with patch.object(prepare.subprocess, 'run', side_effect=[process(1), process(0), process(0)]) as run:
                with self.assertRaisesRegex(ValueError, 'sandbox3_proxy_validation_failed'):
                    prepare.apply_proxy_config(path, self.CONFIG, 'server { listen 80; }', path.stat())
            self.assertEqual(path.read_text(), self.CONFIG)
            self.assertEqual(run.call_args_list[0].args[0], ['nginx', '-t'])
            self.assertEqual(run.call_args_list[-1].args[0], ['systemctl', 'reload', 'nginx.service'])

    def test_rollback_never_overwrites_another_operator_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'nginx.conf'; path.write_text(self.CONFIG)
            def changed(*args, **kwargs):
                path.write_text('another-operator-content')
                return type('Process', (), {'returncode': 1})()
            with patch.object(prepare.subprocess, 'run', side_effect=changed):
                with self.assertRaisesRegex(ValueError, 'sandbox3_proxy_rollback_conflict'):
                    prepare.apply_proxy_config(path, self.CONFIG, 'server { listen 80; }', path.stat())
            self.assertEqual(path.read_text(), 'another-operator-content')


class ProxyRealisticLexingTests(unittest.TestCase):
    def test_common_regex_and_braced_variables_preserve_server_scope(self):
        config = r"""# configuration file /etc/nginx/nginx.conf:
http { log_format main '$remote_addr - ${status}'; include /etc/nginx/sites-enabled/*; }
# configuration file /etc/nginx/sites-enabled/runner:
server { listen 443 ssl; server_name 169-58-15-230.sslip.io;
location ~ /\.ht { deny all; }
location /runner-mcp-test/ { proxy_pass http://127.0.0.1:18882/; proxy_set_header Host ${host}; }
} """
        self.assertEqual(len(prepare.nginx_route_targets(config)), 1)
        tokens = prepare.nginx_tokens(r'location ~ /\.ht { return 403; }')
        self.assertIn(r'/\.ht', [token[0] for token in tokens])
        self.assertIn('${host}', [token[0] for token in prepare.nginx_tokens('proxy_set_header Host ${host};')])
        for invalid in ['listen 443' + chr(92), 'proxy_set_header Host ${host;', 'server { listen 443 }']:
            with self.assertRaisesRegex(ValueError, 'sandbox3_proxy_'):
                prepare.nginx_nodes(invalid)


class ProxyIndependentLegacyTests(unittest.TestCase):
    def test_other_legacy_upstream_and_no_legacy_route_are_preserved(self):
        for location in ['location /runner-mcp-test/ { proxy_pass http://127.0.0.1:18880/; }', 'location / { return 404; }']:
            config = 'server { listen 443 ssl; server_name 169-58-15-230.sslip.io; ' + location + ' }\n'
            dump = '# configuration file /etc/nginx/sites-enabled/runner:\n' + config
            _, updated = prepare.proxy_update(dump, config)
            self.assertEqual(updated.replace(prepare.PROXY_BLOCK, '', 1), config)
        for server in ['server { listen 80; server_name 169-58-15-230.sslip.io; }',
                       'server { listen 443 ssl; server_name foreign.invalid; }']:
            with self.assertRaisesRegex(ValueError, 'sandbox3_proxy_target_ambiguous'):
                prepare.proxy_update('# configuration file /etc/nginx/sites-enabled/runner:\n' + server, server)
