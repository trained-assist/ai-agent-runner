#!/usr/bin/env python3
"""Reject a sandbox API restart while its admission journal has unfinished runs."""

import json
import pathlib
import sys


def unfinished_runs(path: pathlib.Path) -> set[str]:
    if path.is_symlink() or not path.is_file():
        raise ValueError('journal is not a regular file')
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('journal exceeds inspection limit')
    states = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if not isinstance(entry, dict):
            raise ValueError('invalid journal entry')
        kind = entry.get('kind')
        if kind == 'admission':
            record = entry.get('record')
            if not isinstance(record, dict) or record.get('schemaVersion') != 2:
                raise ValueError('unsupported admission schema')
            run = record.get('runId')
            if not isinstance(run, str) or not run or run in states:
                raise ValueError('invalid or duplicate admission')
            states[run] = 'queued'
        elif kind in {'prepared', 'launch_intent', 'dispatched', 'worker_log_cursor', 'completed'}:
            run = entry.get('runId')
            if not isinstance(run, str) or run not in states:
                raise ValueError('orphan journal update')
            if kind == 'completed':
                patch = entry.get('patch')
                if not isinstance(patch, dict) or patch.get('state') not in {'succeeded', 'failed', 'cancelled', 'unknown'}:
                    raise ValueError('invalid completion')
                states[run] = patch['state']
        else:
            raise ValueError('unsupported journal entry')
    return {run for run, state in states.items() if state not in {'succeeded', 'failed', 'cancelled'}}


if __name__ == "__main__":
    try:
        unfinished = unfinished_runs(pathlib.Path(sys.argv[1]))
    except (IndexError, KeyError, TypeError, ValueError, OSError):
        raise SystemExit("invalid sandbox admission journal") from None
    if unfinished:
        raise SystemExit(f"sandbox admission journal has {len(unfinished)} unfinished runs")
