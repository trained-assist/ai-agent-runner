import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).parents[1] / 'scripts/inspect-api-sandbox.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def journal(*entries):
    return '\n'.join(json.dumps(entry) for entry in entries)


def admission(run):
    return {'kind': 'admission', 'record': {'schemaVersion': 2, 'runId': run, 'spec': {'prompt': 'private-user-content'}}}


class InventoryTests(unittest.TestCase):
    def test_cli_errors_and_invalid_modes_never_expose_exception_values(self):
        output = io.StringIO()
        with patch.object(inventory.sys, 'argv', ['inspector', '--inventory']), \
                patch.object(inventory, 'inventory', side_effect=PermissionError('private-secret-content')), \
                contextlib.redirect_stdout(output):
            self.assertEqual(inventory.main(), 1)
        self.assertNotIn('private-secret-content', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['reasonCode'], 'sandbox_inventory_failed')
        with patch.object(inventory.sys, 'argv', ['inspector', '--other']), \
                patch.object(inventory, 'inventory') as probe, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(inventory.main(), 1)
            probe.assert_not_called()

    def test_inventory_can_observe_unknown_but_terminal_guard_blocks_it(self):
        for mode, expected in [('--inventory', 0), ('--require-terminal-journal', 1)]:
            with patch.object(inventory.sys, 'argv', ['inspector', mode]), \
                    patch.object(inventory, 'inventory', return_value={'journalTerminalOnly': False}), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(inventory.main(), expected)

    def test_terminal_records_and_unresolved_launches(self):
        result = inventory.journal_metadata(journal(
            admission('a'), {'kind': 'launch_intent', 'runId': 'a'},
            {'kind': 'completed', 'runId': 'a', 'patch': {'state': 'succeeded', 'answer': 'private-answer'}},
            admission('b'), {'kind': 'dispatched', 'runId': 'b'}))
        self.assertEqual(result['admissionCount'], 2)
        self.assertEqual(result['nonterminalAdmissionCount'], 1)
        self.assertFalse(result['journalTerminalOnly'])
        self.assertNotIn('private-', json.dumps(result))

    def test_unknown_completion_remains_unresolved(self):
        result = inventory.journal_metadata(journal(admission('a'), {'kind': 'completed', 'runId': 'a', 'patch': {'state': 'unknown'}}))
        self.assertEqual(result['unknownOutcomeCount'], 1)
        self.assertEqual(result['nonterminalAdmissionCount'], 1)

    def test_terminal_failure_and_empty_journal(self):
        for state in inventory.TERMINAL:
            result = inventory.journal_metadata(journal(admission('a'), {'kind': 'completed', 'runId': 'a', 'patch': {'state': state}}))
            self.assertTrue(result['journalTerminalOnly'])
        self.assertEqual(inventory.journal_metadata('')['admissionCount'], 0)

    def test_corrupt_tail_future_schema_duplicate_and_orphan_refuse(self):
        invalid = [journal(admission('a')) + '\n{"secret":',
                   journal({'kind': 'admission', 'record': {'schemaVersion': 3, 'runId': 'a'}}),
                   journal(admission('a'), admission('a')),
                   journal({'kind': 'completed', 'runId': 'missing', 'patch': {'state': 'failed'}}),
                   journal({'kind': 'future_kind', 'raw': 'private-user-content'})]
        for text in invalid:
            with self.assertRaisesRegex(ValueError, '^sandbox_inventory_journal_invalid$'):
                inventory.journal_metadata(text)

    def test_environment_outputs_only_whitelisted_metadata(self):
        text = '''AGENT_API_ENVIRONMENT=sandbox
AGENT_API_PORT=18882
AGENT_API_ADMISSION_LOG=/var/lib/agent-runner/mcp-test/admissions.jsonl
AGENT_API_KEY_REGISTRY=/etc/agent-runner/key-registry-mcp-test.json
AGENT_API_WORKERS='[{"engine":"dynamic-ip-azure-agent-run","baseUrl":"https://private.example","token":"private-token"}]'
AGENT_API_ENV='{"LLM_LADDER_TOKEN":"private-ladder-token"}'
AGENT_API_PROFILE_GITHUB_TOKEN=private-github-token
'''
        result = inventory.environment_metadata(text)
        self.assertTrue(result['ladderCredentialConfigured'])
        self.assertTrue(result['journalTargetMatches'])
        self.assertEqual(result['workerEngines'], ['dynamic-ip-azure-agent-run'])
        self.assertNotIn('private-', json.dumps(result))
        self.assertNotIn('private.example', json.dumps(result))
        with self.assertRaisesRegex(ValueError, '^sandbox_inventory_environment_invalid$'):
            inventory.environment_metadata('AGENT_API_WORKERS=[{"engine":"private-secret-name"}]')

    def test_private_regular_bounded_reads_and_missing_journal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'journal'
            with self.assertRaisesRegex(ValueError, '^sandbox_inventory_file_unavailable$'):
                inventory.read_regular(path, 16)
            path.write_text('safe'); path.chmod(0o600)
            self.assertEqual(inventory.read_regular(path, 16), 'safe')
            with self.assertRaisesRegex(ValueError, '^sandbox_inventory_file_too_large$'):
                inventory.read_regular(path, 2)
            link = Path(directory) / 'link'; link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, '^sandbox_inventory_file_unavailable$'):
                inventory.read_regular(link, 16)
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, '^sandbox_inventory_permissions_too_open$'):
                inventory.read_regular(path, 16)


if __name__ == '__main__':
    unittest.main()
