import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('permissions', Path(__file__).parents[1] / 'scripts/restrict-api-sandbox-permissions.py')
permissions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(permissions)
CONFIG = '''AGENT_API_ENVIRONMENT=sandbox
AGENT_API_PORT=18882
AGENT_API_ADMISSION_LOG=/var/lib/agent-runner/mcp-test/admissions.jsonl
AGENT_API_KEY_REGISTRY=/etc/agent-runner/key-registry-mcp-test.json
PRIVATE_CREDENTIAL=private-secret
'''


class PermissionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name).resolve()
        self.env = root / 'service.env'; self.env.write_text(CONFIG); self.env.chmod(0o644)
        self.journal = root / 'journal'; self.journal.write_text('private-user-content\n'); self.journal.chmod(0o644)

    def tearDown(self):
        self.directory.cleanup()

    def run_repair(self, journal_uid=None):
        return permissions.restrict_files(self.env, self.journal, os.getuid(),
                                          os.getuid() if journal_uid is None else journal_uid, {os.getgid()})

    def test_preserves_bytes_owners_and_private_modes_idempotently(self):
        before = (self.env.read_bytes(), self.journal.read_bytes())
        result = self.run_repair()
        self.assertEqual(result, {'environment': 'restricted', 'journal': 'restricted'})
        self.assertEqual((self.env.stat().st_mode & 0o777, self.journal.stat().st_mode & 0o777), (0o600, 0o600))
        self.assertEqual(before, (self.env.read_bytes(), self.journal.read_bytes()))
        self.assertEqual(self.env.stat().st_uid, os.getuid())
        self.assertEqual(self.run_repair(), {'environment': 'already_private', 'journal': 'already_private'})
        self.env.chmod(0o640)
        self.assertEqual(self.run_repair()['environment'], 'already_private')
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o640)

    def test_foreign_owner_or_target_refuses_before_any_chmod(self):
        with self.assertRaisesRegex(ValueError, 'sandbox_permissions_journal_owner_mismatch'):
            self.run_repair(os.getuid() + 1)
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o644)
        self.env.write_text(CONFIG.replace('sandbox\n', 'production\n'))
        with self.assertRaisesRegex(ValueError, 'sandbox_permissions_target_mismatch'):
            self.run_repair()
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o644)

    def test_symlinks_and_hardlinks_refuse_before_mutation(self):
        other = self.journal.with_name('other'); self.journal.rename(other); self.journal.symlink_to(other)
        with self.assertRaisesRegex(ValueError, 'sandbox_permissions_journal_not_canonical'):
            self.run_repair()
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o644)
        self.journal.unlink(); os.link(other, self.journal)
        with self.assertRaisesRegex(ValueError, 'sandbox_permissions_journal_not_unique_regular_file'):
            self.run_repair()
        self.assertEqual(other.stat().st_mode & 0o777, 0o644)

    def test_cli_exceptions_never_print_private_values(self):
        output = io.StringIO()
        with patch.object(permissions.sys, 'argv', ['helper', '--restrict']), \
                patch.object(permissions.os, 'geteuid', side_effect=RuntimeError('private-secret')), \
                contextlib.redirect_stdout(output):
            self.assertEqual(permissions.main(), 1)
        self.assertEqual(json.loads(output.getvalue())['reasonCode'], 'sandbox_permissions_failed')
        self.assertNotIn('private-secret', output.getvalue())


if __name__ == '__main__':
    unittest.main()
