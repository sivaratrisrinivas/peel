#!/usr/bin/env python3
"""Prove one clean workbook Disclosure through the real WSL integrations."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import imaplib
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path
from typing import Any
from urllib import error, request

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.mail_gate_probe import _load_dotenv, _retrieve_eligible_draft
from scripts.trueforge_gate_probe import (
    SUPPORTED_MODEL_NAMES,
    _API,
    _approval,
    _denial_response_observed,
    _runtime_identity,
    _tool_calls,
)


SCHEMA_VERSION = "1"
PROBE_NAME = "live_clean_workbook"
DEFAULT_EVIDENCE_FILE = "/tmp/peel-live-clean-evidence.json"
DEFAULT_DAEMON_PORT = 8787
DEFAULT_CONFIRMATION_TIMEOUT = 90


class LiveFailure(RuntimeError):
    """A bounded failure code safe to expose in live evidence."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _write_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def _base_evidence() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "probe": PROBE_NAME,
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "status": "failed",
        "draft_retrieved": False,
        "draft_envelope_valid": False,
        "artifact_uploaded": False,
        "stage_completed": False,
        "serial_tool_loop_executed": False,
        "trueforge_cerebras_verified": False,
        "daytona_scan_executed": False,
        "daytona_verify_executed": False,
        "native_disclosure_denial_executed": False,
        "smtp_invocations_after_denial": 0,
        "fresh_disclosure_approval_observed": False,
        "approved_disclosure_completed": False,
        "recipient_matching_messages": 0,
        "recipient_confirmation": False,
        "local_python_fallback": False,
        "run_state": "",
        "artifact_sha256": "",
        "model_name": "",
        "provider_base_url": "",
        "failure_code": "",
    }


class DaemonClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def call(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        body = raw if raw is not None else (json.dumps(payload).encode("utf-8") if payload is not None else None)
        request_headers = {"Accept": "application/json", **(headers or {})}
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        req = request.Request(self.base_url + path, data=body, headers=request_headers, method=method)
        try:
            with request.urlopen(req, timeout=30) as response:
                decoded = json.loads(response.read())
        except (OSError, ValueError, error.HTTPError) as exc:
            raise LiveFailure("daemon_unavailable") from exc
        if not isinstance(decoded, dict):
            raise LiveFailure("daemon_invalid_response")
        return decoded


def _start_daemon(
    repo_root: Path,
    database_path: Path,
    audit_path: Path,
    port: int,
) -> tuple[subprocess.Popen[str], DaemonClient]:
    node_bin = os.environ.get("PEEL_NODE_BIN", "node")
    child_environment = os.environ.copy()
    child_environment.update(
        {
            "PEEL_LIVE_MODE": "1",
            "PEEL_PORT": str(port),
            "PEEL_DATABASE_PATH": str(database_path),
            "PEEL_SMTP_AUDIT_FILE": str(audit_path),
            "TMPDIR": "/tmp",
            "TMP": "/tmp",
            "TEMP": "/tmp",
        }
    )
    process = subprocess.Popen(
        [node_bin, "dist/src/index.js"],
        cwd=repo_root,
        env=child_environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    client = DaemonClient(f"http://127.0.0.1:{port}")
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise LiveFailure("daemon_start_failed")
        try:
            health = client.call("GET", "/health")
            if health.get("status") == "ok":
                return process, client
        except LiveFailure:
            pass
        time.sleep(0.25)
    process.terminate()
    raise LiveFailure("daemon_start_timeout")


def _stop_daemon(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def _audit_count(path: Path) -> int:
    if not path.is_file():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line == "delivery_invocation")


def _json_text(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in _json_text(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _json_text(item)]
    return []


def _approval_from_tool_response(events: list[dict[str, Any]]) -> dict[str, Any]:
    for event in events:
        if event.get("type") != "tool.response":
            continue
        for text in _json_text(event.get("content")):
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            approval = value.get("approval")
            if isinstance(approval, dict):
                return approval
            result = value.get("result")
            if isinstance(result, dict) and isinstance(result.get("approval"), dict):
                return result["approval"]
    raise LiveFailure("disclosure_approval_missing")


def _tool_response_states(events: list[dict[str, Any]]) -> list[str]:
    states: list[str] = []
    for event in events:
        if event.get("type") != "tool.response":
            continue
        for text in _json_text(event.get("content")):
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            result = value.get("result") if isinstance(value.get("result"), dict) else value
            run = result.get("run") if isinstance(result, dict) else None
            if isinstance(run, dict) and isinstance(run.get("state"), str):
                states.append(run["state"])
    return states


def _record_run_state(evidence: dict[str, Any], state: str) -> None:
    evidence["run_state"] = state
    if state in {"refused", "failed", "delivery_unknown"}:
        evidence["status"] = state


def _record_tool_run_state(evidence: dict[str, Any], events: list[dict[str, Any]]) -> None:
    states = _tool_response_states(events)
    if states:
        _record_run_state(evidence, states[-1])


def _tool_call_ids(events: list[dict[str, Any]], name: str) -> list[str]:
    return [call_id for call_id, tool_name in _tool_calls(events).items() if tool_name == name]


def _is_serial(events: list[dict[str, Any]]) -> bool:
    for event in events:
        if event.get("type") not in {"model.message", "model.message.delta"}:
            continue
        calls = event.get("tool_calls")
        if isinstance(calls, list) and len(calls) > 1:
            return False
    return True


def _turn_done(events: list[dict[str, Any]]) -> bool:
    for event in reversed(events):
        if event.get("type") == "turn.done":
            state = event.get("state")
            return isinstance(state, dict) and state.get("status") == "done"
    return False


def _approval_tool_call(events: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
    approval_event = _approval(events)
    if approval_event is None:
        raise LiveFailure("native_disclosure_approval_missing")
    calls = _tool_calls(events)
    references = approval_event.get("tool_calls")
    matching: list[str] = []
    if isinstance(references, list):
        for reference in references:
            if not isinstance(reference, dict):
                continue
            call_id = reference.get("id")
            if isinstance(call_id, str) and calls.get(call_id) == "send_email":
                matching.append(call_id)
    if len(matching) != 1:
        raise LiveFailure("native_disclosure_approval_ambiguous")
    return approval_event, matching[0]


def _command_base(run: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": "1",
        "command_id": str(uuid.uuid4()),
        "run_id": run["run_id"],
        "revision": run["revision"],
        "artifact_sha256": run["artifact"]["sha256"],
    }


def _trueforge_workflow(
    client: DaemonClient,
    run: dict[str, Any],
    audit_path: Path,
    model_name: str,
    trueforge_url: str,
    trueforge_token: str | None,
    evidence: dict[str, Any],
) -> None:
    peel_server_name = "peel-live-clean-workbook"
    peel_url = client.base_url + "/mcp"
    api = _API(trueforge_url, trueforge_token)
    api.call(
        "PUT",
        "/api/v1/settings/mcp-servers",
        {
            "manifest": {
                "name": peel_server_name,
                "type": "remote",
                "url": peel_url,
                "description": "Peel live clean-workbook daemon MCP endpoint.",
            }
        },
    )
    agent_spec = {
        "model": {
            "name": f"cerebras/{model_name}",
            "params": {"parallel_tool_calls": False},
        },
        "instructions": (
            "You are operating one Peel Run. Use only the Peel tools and preserve every argument exactly. "
            "The daemon is authoritative. Never invent, omit, or rewrite a Run identity. "
            "On the first turn, call scan, verify, and request_disclosure exactly once each in that order, "
            "then stop. Do not call send_email on the first turn. On a later turn, call send_email only "
            "when the caller explicitly asks and use the exact approval returned by request_disclosure."
        ),
        "mcp_servers": [
            {
                "name": peel_server_name,
                "enable_tools": ["scan", "verify", "request_disclosure", "send_email"],
                "preload": True,
                "require_approval_for_tools": ["send_email"],
            }
        ],
        "config": {
            "generative_ui": {"enabled": False},
            "ask_user_questions": {"enabled": False},
            "dynamic_sub_agents": {"enabled": False},
            "iteration_limit": 20,
        },
    }
    session_response = api.call("POST", "/api/v1/sessions", {"agent": {"spec": agent_spec}})
    session = session_response.get("data", {}) if isinstance(session_response, dict) else {}
    session_id = session.get("id") if isinstance(session, dict) else None
    if not isinstance(session_id, str):
        raise LiveFailure("trueforge_session_missing")

    run_identity = {
        "run_id": run["run_id"],
        "revision": run["revision"],
        "artifact_sha256": run["artifact"]["sha256"],
    }
    first_events = api.stream_turn(
        session_id,
        {
            "stream": True,
            "input": [
                {
                    "type": "user.message",
                    "content": (
                        "Run the first Peel stage using these exact identifiers: "
                        f"{json.dumps(run_identity, sort_keys=True)}. "
                        "Call scan, then verify, then request_disclosure exactly once each and stop."
                    ),
                }
            ],
        },
    )
    _record_tool_run_state(evidence, first_events)
    first_names = list(_tool_calls(first_events).values())
    first_states = _tool_response_states(first_events)
    if (
        not _turn_done(first_events)
        or first_names != ["scan", "verify", "request_disclosure"]
        or first_states != ["scanned", "verified", "awaiting_disclosure_approval"]
        or not _is_serial(first_events)
    ):
        raise LiveFailure("trueforge_first_turn_invalid")
    evidence["daytona_scan_executed"] = True
    evidence["daytona_verify_executed"] = True
    approval = _approval_from_tool_response(first_events)
    runtime_identity = _runtime_identity(api, session_id, model_name)
    evidence.update(
        {
            "model_name": runtime_identity["model_name"],
            "provider_base_url": runtime_identity["provider_base_url"],
            "trueforge_cerebras_verified": runtime_identity["runtime_identity_verified"],
        }
    )

    second_events = api.stream_turn(
        session_id,
        {
            "stream": True,
            "input": [
                {
                    "type": "user.message",
                    "content": (
                        "Request the exact send_email tool call for this approval and stop for native approval. "
                        f"Use this approval object without changes: {json.dumps(approval, sort_keys=True)}"
                    ),
                }
            ],
        },
    )
    denial_approval_event, denied_call_id = _approval_tool_call(second_events)
    if not _is_serial(second_events) or len(_tool_call_ids(second_events, "send_email")) != 1:
        raise LiveFailure("trueforge_denial_turn_invalid")
    native_denial_events = api.stream_turn(
        session_id,
        {
            "stream": True,
            "input": [
                {
                    "type": "user.tool_approval",
                    "thread_id": denial_approval_event.get("thread_id", "main"),
                    "tool_call_id": denied_call_id,
                    "approval": {"status": "deny", "reason": "Peel live Disclosure denial proof."},
                }
            ],
        },
    )
    evidence["native_disclosure_denial_executed"] = _denial_response_observed(native_denial_events, denied_call_id)
    evidence["smtp_invocations_after_denial"] = _audit_count(audit_path)
    if not evidence["native_disclosure_denial_executed"]:
        raise LiveFailure("native_denial_unconfirmed")
    if evidence["smtp_invocations_after_denial"] != 0:
        raise LiveFailure("smtp_side_effect_after_denial")

    denial_command = {
        **_command_base(run),
        "command": "respond_disclosure",
        "expected_state": "awaiting_disclosure_approval",
        "approval_id": approval["approval_id"],
        "idempotency_key": approval["idempotency_key"],
        "decision": "deny",
        "binding": approval["binding"],
    }
    denied = client.call("POST", "/v1/commands", payload=denial_command)
    if isinstance(denied.get("run"), dict) and isinstance(denied["run"].get("state"), str):
        _record_run_state(evidence, denied["run"]["state"])
    if denied.get("ok") is not True or denied.get("run", {}).get("state") != "verified":
        raise LiveFailure("denial_not_recorded")

    third_events = api.stream_turn(
        session_id,
        {
            "stream": True,
            "input": [
                {
                    "type": "user.message",
                    "content": (
                        "The first Disclosure Approval was denied and recorded. Call request_disclosure exactly "
                        f"once for this exact Run identity: {json.dumps(run_identity, sort_keys=True)}. Stop at the fresh approval."
                    ),
                }
            ],
        },
    )
    _record_tool_run_state(evidence, third_events)
    third_names = list(_tool_calls(third_events).values())
    if not _turn_done(third_events) or third_names != ["request_disclosure"] or not _is_serial(third_events):
        raise LiveFailure("fresh_approval_turn_invalid")
    fresh_approval = _approval_from_tool_response(third_events)
    evidence["fresh_disclosure_approval_observed"] = (
        fresh_approval.get("approval_id") != approval.get("approval_id")
        and fresh_approval.get("idempotency_key") != approval.get("idempotency_key")
    )
    if not evidence["fresh_disclosure_approval_observed"]:
        raise LiveFailure("fresh_approval_not_distinct")

    fourth_events = api.stream_turn(
        session_id,
        {
            "stream": True,
            "input": [
                {
                    "type": "user.message",
                    "content": (
                        "Call send_email exactly once using this fresh approval object, then stop for native approval. "
                        f"Use it without changes: {json.dumps(fresh_approval, sort_keys=True)}"
                    ),
                }
            ],
        },
    )
    approved_approval_event, approved_call_id = _approval_tool_call(fourth_events)
    approved_events = api.stream_turn(
        session_id,
        {
            "stream": True,
            "input": [
                {
                    "type": "user.tool_approval",
                    "thread_id": approved_approval_event.get("thread_id", "main"),
                    "tool_call_id": approved_call_id,
                    "approval": {"status": "approve"},
                }
            ],
        },
    )
    _record_tool_run_state(evidence, approved_events)
    if not _approved_tool_response_is_success(approved_events, approved_call_id):
        raise LiveFailure("approved_disclosure_not_completed")
    _record_run_state(evidence, "disclosed")
    evidence["approved_disclosure_completed"] = True
    if _audit_count(audit_path) != 1:
        raise LiveFailure("approved_smtp_invocation_not_unique")
    evidence["serial_tool_loop_executed"] = all(
        _is_serial(events) for events in (first_events, second_events, third_events, fourth_events, approved_events)
    )
    if not evidence["serial_tool_loop_executed"]:
        raise LiveFailure("parallel_tool_call_observed")


def _approved_tool_response_is_success(events: list[dict[str, Any]], call_id: str) -> bool:
    for event in events:
        if event.get("type") != "tool.response" or event.get("tool_call_id") != call_id:
            continue
        for text in _json_text(event.get("content")):
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("ok") is True and value.get("run", {}).get("state") == "disclosed":
                return True
    return False


def _matching_recipient_messages(
    *,
    sender: str,
    recipient: str,
    subject: str,
    artifact_filename: str,
    artifact_sha256: str,
) -> int:
    host = os.environ.get("PEEL_RECIPIENT_IMAP_HOST", os.environ.get("IMAP_HOST", ""))
    username = os.environ.get("PEEL_RECIPIENT_IMAP_USERNAME", os.environ.get("IMAP_USERNAME", ""))
    password = os.environ.get("PEEL_RECIPIENT_IMAP_PASSWORD", os.environ.get("IMAP_PASSWORD", ""))
    mailbox = os.environ.get("PEEL_RECIPIENT_IMAP_MAILBOX", "INBOX")
    if not host or not username or not password:
        raise LiveFailure("recipient_mailbox_configuration_missing")
    matches = 0
    with imaplib.IMAP4_SSL(host, int(os.environ.get("PEEL_RECIPIENT_IMAP_PORT", "993"))) as client:
        if client.login(username, "".join(password.split()))[0] != "OK":
            raise LiveFailure("recipient_mailbox_login_failed")
        if client.select(mailbox, readonly=True)[0] != "OK":
            raise LiveFailure("recipient_mailbox_select_failed")
        search_status, data = client.uid("search", None, "ALL")
        if search_status != "OK" or not data or not data[0]:
            return 0
        for message_id in data[0].split()[-100:]:
            fetch_status, fetched = client.uid("fetch", message_id, "(RFC822)")
            if fetch_status != "OK":
                continue
            raw = b"".join(item[1] for item in fetched if isinstance(item, tuple) and len(item) == 2)
            if not raw:
                continue
            message = BytesParser(policy=policy.default).parsebytes(raw)
            if len(getaddresses([str(value) for value in message.get_all("From", [])])) != 1:
                continue
            if getaddresses([str(value) for value in message.get_all("From", [])])[0][1].casefold() != sender.casefold():
                continue
            recipients = getaddresses(
                [str(value) for header in ("To", "Cc", "Bcc") for value in message.get_all(header, [])]
            )
            if len(recipients) != 1 or recipients[0][1].casefold() != recipient.casefold():
                continue
            if str(message.get("Subject", "")).strip() != subject:
                continue
            attachments = []
            for part in message.walk():
                filename = part.get_filename() or ""
                if part.get_content_disposition() == "attachment" or filename:
                    payload = part.get_payload(decode=True)
                    if isinstance(payload, bytes):
                        attachments.append((filename, payload))
            if len(attachments) == 1 and attachments[0][0] == artifact_filename and hashlib.sha256(attachments[0][1]).hexdigest() == artifact_sha256:
                matches += 1
    return matches


def _await_recipient_confirmation(
    *,
    timeout_seconds: int,
    sender: str,
    recipient: str,
    subject: str,
    artifact_filename: str,
    artifact_sha256: str,
) -> int:
    deadline = time.monotonic() + timeout_seconds
    matches = 0
    while time.monotonic() < deadline:
        matches = _matching_recipient_messages(
            sender=sender,
            recipient=recipient,
            subject=subject,
            artifact_filename=artifact_filename,
            artifact_sha256=artifact_sha256,
        )
        if matches == 1:
            return matches
        time.sleep(2)
    return matches


def run(args: argparse.Namespace) -> int:
    _load_dotenv(Path(args.repo_root) / ".env")
    evidence = _base_evidence()
    evidence_file = Path(args.evidence_file)
    process: subprocess.Popen[str] | None = None
    try:
        required_configuration = (
            "PEEL_OWNED_RECIPIENT",
            "IMAP_HOST",
            "IMAP_USERNAME",
            "IMAP_PASSWORD",
            "DAYTONA_API_KEY",
            "SMTP_HOST",
            "SMTP_USERNAME",
            "SMTP_PASSWORD",
        )
        if any(not os.environ.get(name) for name in required_configuration):
            raise LiveFailure("live_configuration_missing")
        try:
            draft = _retrieve_eligible_draft()
        except (KeyError, OSError, ValueError, imaplib.IMAP4.error) as exc:
            raise LiveFailure("mailbox_retrieval_failed") from exc
        if draft is None:
            raise LiveFailure("eligible_draft_not_found")
        evidence["draft_retrieved"] = True
        evidence["draft_envelope_valid"] = True
        with tempfile.TemporaryDirectory(prefix="peel-live-") as temporary:
            temporary_path = Path(temporary)
            audit_path = temporary_path / "smtp-audit.log"
            database_path = temporary_path / "peel.sqlite"
            process, daemon = _start_daemon(Path(args.repo_root), database_path, audit_path, args.daemon_port)
            upload = daemon.call(
                "POST",
                "/v1/artifacts",
                raw=draft.attachment_bytes,
                headers={"x-artifact-filename": draft.attachment_filename},
            )
            artifact = upload.get("artifact")
            if not isinstance(artifact, dict):
                raise LiveFailure("artifact_upload_failed")
            evidence["artifact_uploaded"] = True
            evidence["artifact_sha256"] = artifact.get("sha256", "")
            stage = daemon.call(
                "POST",
                "/v1/commands",
                payload={
                    "version": "1",
                    "command": "stage",
                    "command_id": str(uuid.uuid4()),
                    "expected_state": "new",
                    "trigger": {
                        "mailbox_account": draft.mailbox_account,
                        "folder_uidvalidity": draft.folder_uidvalidity,
                        "message_uid": draft.message_uid,
                        "attachment_sha256": artifact["sha256"],
                    },
                    "envelope": {
                        "sender": draft.sender,
                        "recipient": draft.recipient,
                        "subject": draft.subject,
                        "body": draft.body,
                        "attachment": artifact,
                    },
                },
            )
            if stage.get("ok") is not True:
                raise LiveFailure("stage_failed")
            evidence["stage_completed"] = True
            run_view = stage.get("run")
            if not isinstance(run_view, dict):
                raise LiveFailure("stage_run_missing")
            _trueforge_workflow(
                daemon,
                run_view,
                audit_path,
                args.model,
                args.trueforge_url,
                os.environ.get("TRUEFORGE_API_KEY"),
                evidence,
            )
            matches = _await_recipient_confirmation(
                timeout_seconds=args.confirmation_timeout,
                sender=draft.sender,
                recipient=draft.recipient,
                subject=draft.subject,
                artifact_filename=draft.attachment_filename,
                artifact_sha256=artifact["sha256"],
            )
            evidence["recipient_matching_messages"] = matches
            evidence["recipient_confirmation"] = matches == 1
            if not evidence["recipient_confirmation"]:
                raise LiveFailure("recipient_confirmation_failed")
        evidence["status"] = "disclosed"
        _write_evidence(evidence_file, evidence)
        print(json.dumps({key: value for key, value in evidence.items() if key != "observed_at"}, sort_keys=True))
        return 0
    except LiveFailure as exc:
        evidence["failure_code"] = exc.code
    except Exception as exc:
        evidence["failure_code"] = type(exc).__name__
    finally:
        if process is not None:
            _stop_daemon(process)
    _write_evidence(evidence_file, evidence)
    print(json.dumps({key: value for key, value in evidence.items() if key != "observed_at"}, sort_keys=True))
    return 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--daemon-port", type=int, default=int(os.environ.get("PEEL_LIVE_DAEMON_PORT", str(DEFAULT_DAEMON_PORT))))
    parser.add_argument("--trueforge-url", default=os.environ.get("PEEL_TRUEFORGE_URL", "http://localhost:8790"))
    parser.add_argument("--model", default=os.environ.get("PEEL_TRUEFORGE_MODEL", "gemma-4-31b"), choices=sorted(SUPPORTED_MODEL_NAMES))
    parser.add_argument("--evidence-file", default=os.environ.get("PEEL_LIVE_EVIDENCE_FILE", DEFAULT_EVIDENCE_FILE))
    parser.add_argument("--confirmation-timeout", type=int, default=DEFAULT_CONFIRMATION_TIMEOUT)
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
