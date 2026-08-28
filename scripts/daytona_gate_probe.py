#!/usr/bin/env python3
"""Exercise Daytona file custody with a fresh sandbox and bounded evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1"
DEFAULT_EVIDENCE_FILE = "/tmp/peel-daytona-evidence.json"


def _load_dotenv(path: Path = Path(".env")) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("export "):
            line = line[7:].lstrip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        value = value.strip()
        for escaped_line_end in (r"\r", r"\n"):
            if value.endswith(escaped_line_end):
                value = value[: -len(escaped_line_end)].rstrip()
        os.environ.setdefault(name, value)


def _write_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main() -> int:
    _load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-file", default=os.environ.get("PEEL_DAYTONA_EVIDENCE_FILE", DEFAULT_EVIDENCE_FILE))
    args = parser.parse_args()
    evidence: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "probe": "daytona",
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sandbox_created": False,
        "attachment_uploaded": False,
        "declared_command_executed": False,
        "artifact_hash_verified": False,
        "sandbox_destroyed": False,
    }
    sandbox = None
    client = None
    try:
        from daytona import CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig

        api_key = os.environ.get("DAYTONA_API_KEY", "")
        if not api_key:
            raise RuntimeError("missing Daytona API key")
        config = DaytonaConfig(
            api_key=api_key,
            api_url=os.environ.get("DAYTONA_API_URL"),
            target=os.environ.get("DAYTONA_TARGET"),
        )
        client = Daytona(config)
        params = CreateSandboxFromSnapshotParams(
            name=f"peel-gate-{uuid.uuid4().hex[:12]}",
            language="python",
            snapshot=os.environ.get("DAYTONA_SNAPSHOT") or None,
            auto_delete_interval=30,
        )
        sandbox = client.create(params, timeout=120)
        evidence["sandbox_created"] = True

        payload = b"peel-daytona-gate\n"
        local_hash = hashlib.sha256(payload).hexdigest()
        remote_path = "/tmp/peel-daytona-gate.txt"
        sandbox.fs.upload_file(payload, remote_path)
        evidence["attachment_uploaded"] = True

        command = f"sha256sum {remote_path}"
        result = sandbox.process.exec(command, timeout=30)
        evidence["declared_command_executed"] = result.exit_code == 0
        remote_hash = (result.result or "").strip().split(maxsplit=1)[0]
        if remote_hash == local_hash:
            downloaded = sandbox.fs.download_file(remote_path)
            evidence["artifact_hash_verified"] = (
                isinstance(downloaded, bytes) and hashlib.sha256(downloaded).hexdigest() == local_hash
            )
    except Exception:
        pass
    finally:
        if client is not None and sandbox is not None:
            try:
                client.delete(sandbox, timeout=120, wait=True)
                evidence["sandbox_destroyed"] = True
            except Exception:
                pass

    output = Path(args.evidence_file)
    _write_evidence(output, evidence)
    print(json.dumps({key: value for key, value in evidence.items() if key != "observed_at"}, sort_keys=True))
    return 0 if all(evidence[key] for key in (
        "sandbox_created",
        "attachment_uploaded",
        "declared_command_executed",
        "artifact_hash_verified",
        "sandbox_destroyed",
    )) else 2


if __name__ == "__main__":
    raise SystemExit(main())
