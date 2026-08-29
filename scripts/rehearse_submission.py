#!/usr/bin/env python3
"""Run the clean-workbook demonstration twice and require Demo-ready evidence."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.submission_qualification import qualify_rehearsals, repository_snapshot, write_evidence


def _read_evidence(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _run_rehearsal(repo_root: Path, evidence_path: Path, args: argparse.Namespace) -> int:
    command = [
        sys.executable,
        str(repo_root / "scripts" / "live_clean_workbook.py"),
        "--repo-root",
        str(repo_root),
        "--evidence-file",
        str(evidence_path),
        "--daemon-port",
        str(args.daemon_port),
        "--model",
        args.model,
        "--trueforge-url",
        args.trueforge_url,
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=args.timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 2
    return completed.returncode


def run_rehearsals(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root).resolve()
    evidence_dir = Path(args.evidence_dir).resolve()
    output_path = Path(args.evidence_file).resolve()
    if evidence_dir == repo_root or repo_root in evidence_dir.parents or output_path == repo_root or repo_root in output_path.parents:
        evidence = {
            "schema_version": "1",
            "probe": "submission_rehearsal",
            "status": "blocked",
            "rehearsals_completed": 0,
            "code_unchanged": False,
            "configuration_unchanged": False,
            "failure_code": "qualification_output_must_be_outside_repository",
        }
        write_evidence(output_path, evidence)
        print(json.dumps(evidence, sort_keys=True))
        return 2

    baseline = repository_snapshot(repo_root)
    if baseline.status != "":
        evidence = {
            "schema_version": "1",
            "probe": "submission_rehearsal",
            "status": "blocked",
            "rehearsals_completed": 0,
            "code_unchanged": False,
            "configuration_unchanged": False,
            "failure_code": "qualification_requires_clean_worktree",
        }
        write_evidence(output_path, evidence)
        print(json.dumps(evidence, sort_keys=True))
        return 2

    snapshots = [baseline]
    records: list[dict[str, Any]] = []
    for index in (1, 2):
        evidence_path = evidence_dir / f"rehearsal-{index}.json"
        return_code = _run_rehearsal(repo_root, evidence_path, args)
        record = _read_evidence(evidence_path)
        records.append(record)
        snapshots.append(repository_snapshot(repo_root))
        if return_code != 0:
            failure_code = record.get("failure_code")
            result = {
                "schema_version": "1",
                "probe": "submission_rehearsal",
                "status": "blocked",
                "rehearsals_completed": 0,
                "code_unchanged": False,
                "configuration_unchanged": False,
                "failure_code": failure_code if isinstance(failure_code, str) and failure_code else "live_rehearsal_failed",
            }
            write_evidence(output_path, result)
            print(json.dumps(result, sort_keys=True))
            return 2
        if snapshots[-1] != snapshots[0]:
            break

    result = qualify_rehearsals(records, snapshots if len(snapshots) == 3 else [])
    write_evidence(output_path, result)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "demo_ready" else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--evidence-dir", default="/tmp/peel-rehearsals")
    parser.add_argument("--evidence-file", default="/tmp/peel-submission-rehearsal-evidence.json")
    parser.add_argument("--model", default=os.environ.get("PEEL_TRUEFORGE_MODEL", "gemma-4-31b"))
    parser.add_argument("--trueforge-url", default=os.environ.get("PEEL_TRUEFORGE_URL", "http://localhost:8790"))
    parser.add_argument("--daemon-port", default=int(os.environ.get("PEEL_LIVE_DAEMON_PORT", "8787")), type=int)
    parser.add_argument("--timeout", default=900, type=int)
    return run_rehearsals(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
