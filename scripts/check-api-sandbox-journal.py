#!/usr/bin/env python3
"""Reject a sandbox API restart while its admission journal has unfinished runs."""

import json
import pathlib
import sys


def unfinished_runs(path: pathlib.Path) -> set[str]:
    if not path.exists():
        return set()
    admitted: set[str] = set()
    terminal: set[str] = set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid admission journal JSON at line {number}") from exc
        if entry.get("kind") == "admission":
            admitted.add(entry["record"]["runId"])
        elif entry.get("kind") == "completed":
            if entry.get("patch", {}).get("state") in {"succeeded", "failed", "cancelled"}:
                terminal.add(entry["runId"])
    return admitted - terminal


if __name__ == "__main__":
    try:
        unfinished = unfinished_runs(pathlib.Path(sys.argv[1]))
    except (IndexError, KeyError, TypeError, ValueError) as exc:
        raise SystemExit(f"invalid sandbox admission journal: {exc}") from exc
    if unfinished:
        raise SystemExit(f"sandbox admission journal has {len(unfinished)} unfinished runs")
