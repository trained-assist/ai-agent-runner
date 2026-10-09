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
                {"kind": "admission", "record": {"runId": "run-1"}},
                {"kind": "completed", "runId": "run-1", "patch": {"state": "succeeded"}},
            ]) + "\n")
            self.assertEqual(MODULE.unfinished_runs(journal), set())

    def test_accepted_run_blocks_update(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = pathlib.Path(directory) / "admissions.jsonl"
            journal.write_text(json.dumps({"kind": "admission", "record": {"runId": "run-2"}}) + "\n")
            self.assertEqual(MODULE.unfinished_runs(journal), {"run-2"})

    def test_corrupt_journal_blocks_update(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = pathlib.Path(directory) / "admissions.jsonl"
            journal.write_text("{broken\n")
            with self.assertRaises(ValueError):
                MODULE.unfinished_runs(journal)


if __name__ == "__main__":
    unittest.main()
