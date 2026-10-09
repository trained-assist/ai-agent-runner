import importlib.util
import json
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "check-api-sandbox-journal.py"
SPEC = importlib.util.spec_from_file_location("check_api_sandbox_journal", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SandboxLaneJournalTest(unittest.TestCase):
    def test_terminal_history_allows_update(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = pathlib.Path(directory) / "admissions.jsonl"
            journal.write_text("\n".join(json.dumps(entry) for entry in [
                {"kind": "admission", "record": {"schemaVersion": 2, "runId": "run-1"}},
                {"kind": "completed", "runId": "run-1", "patch": {"state": "succeeded"}},
            ]) + "\n")
            self.assertEqual(MODULE.unfinished_runs(journal), set())

    def test_accepted_run_blocks_update(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = pathlib.Path(directory) / "admissions.jsonl"
            journal.write_text(json.dumps({"kind": "admission", "record": {"schemaVersion": 2, "runId": "run-2"}}) + "\n")
            self.assertEqual(MODULE.unfinished_runs(journal), {"run-2"})

    def test_corrupt_journal_blocks_update(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = pathlib.Path(directory) / "admissions.jsonl"
            journal.write_text("{broken\n")
            with self.assertRaises(ValueError):
                MODULE.unfinished_runs(journal)

    def test_unknown_future_duplicate_orphan_and_missing_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = pathlib.Path(directory) / 'admissions.jsonl'
            with self.assertRaises(ValueError):
                MODULE.unfinished_runs(journal)
            admission = {'kind': 'admission', 'record': {'schemaVersion': 2, 'runId': 'a'}}
            for entries in [[{'kind': 'future', 'secret': 'private'}], [admission, admission],
                            [{'kind': 'completed', 'runId': 'missing', 'patch': {'state': 'succeeded'}}],
                            [{'kind': 'admission', 'record': {'schemaVersion': 3, 'runId': 'a'}}]]:
                journal.write_text('\n'.join(json.dumps(entry) for entry in entries))
                with self.assertRaises(ValueError):
                    MODULE.unfinished_runs(journal)
            journal.write_text('\n'.join(json.dumps(entry) for entry in [admission,
                {'kind': 'completed', 'runId': 'a', 'patch': {'state': 'succeeded'}},
                {'kind': 'completed', 'runId': 'a', 'patch': {'state': 'unknown'}}]))
            self.assertEqual(MODULE.unfinished_runs(journal), {'a'})


if __name__ == "__main__":
    unittest.main()
