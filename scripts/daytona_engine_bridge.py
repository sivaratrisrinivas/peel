#!/usr/bin/env python3
"""Keep the production engine boundary in a fresh Daytona sandbox."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import shlex
import sys
import uuid
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
ENGINE_SCRIPT = REPO_ROOT / "scripts" / "daytona_engine.py"
INPUT_PATH = "/tmp/peel-input.xlsx"
OUTPUT_PATH = "/tmp/peel-verified.xlsx"
REPAIR_OUTPUT_PATH = "/tmp/peel-repaired.xlsx"
MAX_ARTIFACT_BYTES = 10 * 1024 * 1024


def _request() -> dict[str, Any]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    operation = value.get("operation")
    artifact = value.get("artifact")
    encoded = value.get("bytes_base64")
    if operation not in {"scan", "repair", "verify"} or not isinstance(artifact, dict) or not isinstance(encoded, str):
        raise ValueError("invalid Daytona engine request")
    if not isinstance(artifact.get("filename"), str) or not artifact["filename"].lower().endswith(".xlsx"):
        raise ValueError("invalid artifact filename")
    if not isinstance(artifact.get("sha256"), str) or not isinstance(artifact.get("byte_size"), int):
        raise ValueError("invalid artifact identity")
    if artifact["byte_size"] < 0 or artifact["byte_size"] > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact is outside the supported size limit")
    if operation == "verify" and not isinstance(value.get("original_artifact_sha256"), str):
        raise ValueError("verify requires the original artifact identity")
    if operation == "repair" and not isinstance(value.get("repair_plan"), dict):
        raise ValueError("repair requires the complete Repair Plan")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("artifact is not valid base64") from error
    if len(payload) != artifact["byte_size"] or hashlib.sha256(payload).hexdigest() != artifact["sha256"]:
        raise ValueError("artifact identity failed before Daytona upload")
    original_payload = None
    if isinstance(value.get("original_bytes_base64"), str):
        try:
            original_payload = base64.b64decode(value["original_bytes_base64"], validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError("original artifact is not valid base64") from error
        if not isinstance(value.get("original_artifact_sha256"), str) or hashlib.sha256(original_payload).hexdigest() != value["original_artifact_sha256"]:
            raise ValueError("original artifact identity failed before Daytona upload")
    return {**value, "payload": payload, "original_payload": original_payload}


def _command(request: dict[str, Any]) -> str:
    operation = request["operation"]
    command = [
        "python3",
        "/tmp/peel-engine.py",
        "--operation",
        operation,
        "--input",
        INPUT_PATH,
        "--artifact-sha256",
        request["artifact"]["sha256"],
    ]
    if operation == "repair":
        command.extend(["--repair-plan", "/tmp/peel-repair-plan.json"])
    elif operation == "verify":
        command.extend(["--original-artifact-sha256", request["original_artifact_sha256"]])
        if request.get("original_payload") is not None:
            command.extend(["--original-input", "/tmp/peel-original.xlsx"])
        if isinstance(request.get("repair_plan"), dict):
            command.extend(["--repair-plan", "/tmp/peel-repair-plan.json"])
    return " ".join(shlex.quote(part) for part in command)


def run(request: dict[str, Any]) -> dict[str, Any]:
    from daytona import CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig

    api_key = os.environ.get("DAYTONA_API_KEY", "")
    if not api_key:
        raise RuntimeError("missing Daytona API key")
    if not ENGINE_SCRIPT.is_file():
        raise RuntimeError("production engine script is missing")
    client = Daytona(
        DaytonaConfig(
            api_key=api_key,
            api_url=os.environ.get("DAYTONA_API_URL"),
            target=os.environ.get("DAYTONA_TARGET"),
        )
    )
    sandbox = None
    destroyed = False
    try:
        params = CreateSandboxFromSnapshotParams(
            name=f"peel-live-{uuid.uuid4().hex[:12]}",
            language="python",
            snapshot=os.environ.get("DAYTONA_SNAPSHOT") or None,
            auto_delete_interval=30,
        )
        sandbox = client.create(params, timeout=120)
        payload = request["payload"]
        sandbox.fs.upload_file(payload, INPUT_PATH, timeout=120)
        if request.get("original_payload") is not None:
            sandbox.fs.upload_file(request["original_payload"], "/tmp/peel-original.xlsx", timeout=120)
        if isinstance(request.get("repair_plan"), dict):
            sandbox.fs.upload_file(json.dumps(request["repair_plan"], separators=(",", ":")).encode("utf-8"), "/tmp/peel-repair-plan.json", timeout=120)
        sandbox.fs.upload_file(ENGINE_SCRIPT.read_bytes(), "/tmp/peel-engine.py", timeout=120)
        result = sandbox.process.exec(_command(request), timeout=120)
        if result.exit_code != 0 or not isinstance(result.result, str):
            raise RuntimeError("Daytona production engine command failed")
        engine_result = json.loads(result.result)
        if not isinstance(engine_result, dict):
            raise RuntimeError("Daytona production engine returned invalid JSON")
        if request["operation"] in {"repair", "verify"} and engine_result.get("status") in {"repaired", "verified"}:
            output_path = REPAIR_OUTPUT_PATH if request["operation"] == "repair" else OUTPUT_PATH
            downloaded = sandbox.fs.download_file(output_path)
            if not isinstance(downloaded, bytes):
                raise RuntimeError("Daytona returned an invalid declared artifact")
            expected_hash = engine_result.get("artifact_sha256")
            if not isinstance(expected_hash, str) or len(downloaded) > MAX_ARTIFACT_BYTES or hashlib.sha256(downloaded).hexdigest() != expected_hash:
                raise RuntimeError("declared Daytona artifact failed its hash check")
            if request["operation"] == "verify" and expected_hash != request["artifact"]["sha256"]:
                raise RuntimeError("Daytona result identity does not match the declared candidate")
            return {"result": engine_result, "candidate_bytes_base64": base64.b64encode(downloaded).decode("ascii")} if request["operation"] == "repair" else {"result": engine_result}
        return {"result": engine_result}
    finally:
        if sandbox is not None:
            try:
                client.delete(sandbox, timeout=120, wait=True)
                destroyed = True
            finally:
                if not destroyed:
                    raise RuntimeError("Daytona sandbox cleanup was not confirmed")


def main() -> int:
    try:
        print(json.dumps(run(_request()), separators=(",", ":")))
        return 0
    except Exception:
        sys.stderr.write("Daytona production engine bridge failed.\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
