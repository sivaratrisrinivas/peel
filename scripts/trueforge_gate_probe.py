#!/usr/bin/env python3
"""Prove the TrueForge/Cerebras serial loop and native denial boundary."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import threading
from http.client import HTTPResponse
from pathlib import Path
from typing import Any
from urllib import error, request

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.environment_gate import _load_dotenv
from scripts.trueforge_gate_mcp import _MCPServer


SCHEMA_VERSION = "1"
DEFAULT_EVIDENCE_FILE = "/tmp/peel-trueforge-evidence.json"
TRUEFORGE_DEFAULT_URL = "http://localhost:8790"
SUPPORTED_MODEL_NAMES = {"gpt-oss-120b", "gemma-4-31b"}
PROVIDER_BASE_URL = "https://api.cerebras.ai/v1"


class _API:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = request.Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=120) as response:
                raw = response.read()
        except error.HTTPError as exc:
            detail = exc.read(500).decode("utf-8", errors="replace")
            raise RuntimeError(f"TrueForge {method} {path} failed with HTTP {exc.code}: {detail}") from exc
        if not raw:
            return None
        return json.loads(raw)

    def stream_turn(self, session_id: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        body = json.dumps(payload).encode("utf-8")
        headers = {"Accept": "text/event-stream", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = request.Request(
            f"{self.base_url}/api/v1/sessions/{session_id}/turns",
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=180) as response:
                return _read_sse(response)
        except error.HTTPError as exc:
            detail = exc.read(500).decode("utf-8", errors="replace")
            raise RuntimeError(f"TrueForge turn failed with HTTP {exc.code}: {detail}") from exc


def _read_sse(response: HTTPResponse) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    data_lines: list[str] = []
    while True:
        line = response.readline()
        if not line:
            break
        decoded = line.decode("utf-8", errors="replace").rstrip("\r\n")
        if not decoded:
            if data_lines:
                try:
                    event = json.loads("\n".join(data_lines))
                except json.JSONDecodeError:
                    data_lines = []
                    continue
                if isinstance(event, dict):
                    events.append(event)
                data_lines = []
            continue
        if decoded.startswith("data:"):
            data_lines.append(decoded[5:].lstrip())
    if data_lines:
        try:
            event = json.loads("\n".join(data_lines))
        except json.JSONDecodeError:
            event = None
        if isinstance(event, dict):
            events.append(event)
    return events


def _effective_tool_name(call: dict[str, Any]) -> str | None:
    function = call.get("function")
    if not isinstance(function, dict):
        function = {}
    name = function.get("name") or call.get("name")
    if not isinstance(name, str):
        return None
    if name != "call_tool":
        return name
    arguments = function.get("arguments")
    if not isinstance(arguments, str):
        return name
    try:
        parsed = json.loads(arguments)
    except json.JSONDecodeError:
        return name
    underlying = parsed.get("tool_name") if isinstance(parsed, dict) else None
    return underlying if isinstance(underlying, str) else name


def _tool_calls(events: list[dict[str, Any]]) -> dict[str, str]:
    calls: dict[str, dict[str, Any]] = {}
    delta_slots: dict[int, str] = {}
    for event in events:
        event_type = event.get("type")
        if event_type not in {"model.message", "model.message.delta"}:
            continue
        for call in event.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            if not isinstance(function, dict):
                function = {}
            call_id = call.get("id")
            index = call.get("index")
            if isinstance(call_id, str):
                if isinstance(index, int):
                    delta_slots[index] = call_id
            elif isinstance(index, int):
                call_id = delta_slots.setdefault(index, f"delta:{index}")
            else:
                continue
            entry = calls.setdefault(call_id, {"id": call_id, "function": {}})
            entry_function = entry["function"]
            if isinstance(function.get("name"), str):
                entry_function["name"] = function["name"]
            arguments = function.get("arguments")
            if isinstance(arguments, str) and arguments:
                entry_function["arguments"] = entry_function.get("arguments", "") + arguments
            if event_type == "model.message":
                entry.update({key: value for key, value in call.items() if key != "function"})
                entry["function"] = entry_function
    result: dict[str, str] = {}
    for call_id, call in calls.items():
        name = _effective_tool_name(call)
        if isinstance(name, str):
            result[call_id] = name
    return result


def _approval(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    return next((event for event in events if event.get("type") == "tool.approval_required"), None)


def _denial_response_observed(events: list[dict[str, Any]], expected_tool_call_id: str) -> bool:
    """Confirm that TrueForge converted the native denial into a denied tool response."""

    return any(
        event.get("type") == "tool.response"
        and event.get("tool_call_id") == expected_tool_call_id
        and "User denied tool call:" in json.dumps(event.get("content", ""))
        for event in events
    )


def _runtime_identity(
    api: _API, session_id: str, expected_model_name: str
) -> dict[str, str | bool]:
    """Verify the resolved model and provider from TrueForge's runtime catalog.

    TrueForge 0.1.4 exposes the resolved inline session spec and the live model/provider
    catalogs, while its public event schema strips the lower-level provider source field.
    Cross-checking those independent runtime responses prevents the evidence from merely
    repeating the CLI request or a hard-coded provider URL.
    """

    session_response = api.call("GET", f"/api/v1/sessions/{session_id}")
    session_data = session_response.get("data", {}) if isinstance(session_response, dict) else {}
    agent = session_data.get("agent", {}) if isinstance(session_data, dict) else {}
    spec = agent.get("spec", {}) if isinstance(agent, dict) else {}
    model = spec.get("model", {}) if isinstance(spec, dict) else {}
    resolved_fqn = model.get("name") if isinstance(model, dict) else None
    if not isinstance(resolved_fqn, str) or not resolved_fqn.startswith("cerebras/"):
        raise RuntimeError("TrueForge session did not resolve a Cerebras model")
    observed_model_name = resolved_fqn.removeprefix("cerebras/")
    if observed_model_name != expected_model_name:
        raise RuntimeError("TrueForge session resolved a different model than the requested Cerebras model")

    models_response = api.call("GET", "/api/v1/models")
    model_entries = models_response.get("data", []) if isinstance(models_response, dict) else []
    catalog_entry = next(
        (
            entry
            for entry in model_entries
            if isinstance(entry, dict)
            and entry.get("name") == resolved_fqn
            and entry.get("model_id") == observed_model_name
        ),
        None,
    )
    catalog_provider = catalog_entry.get("provider", {}) if isinstance(catalog_entry, dict) else {}
    if not isinstance(catalog_provider, dict) or catalog_provider.get("name") != "cerebras":
        raise RuntimeError("TrueForge model catalog did not resolve the session model to Cerebras")

    providers_response = api.call("GET", "/api/v1/settings/model-providers")
    providers = providers_response.get("data", []) if isinstance(providers_response, dict) else []
    provider_entry = next(
        (
            entry
            for entry in providers
            if isinstance(entry, dict) and entry.get("name") == "cerebras"
        ),
        None,
    )
    manifest = provider_entry.get("manifest", {}) if isinstance(provider_entry, dict) else {}
    provider_base_url = manifest.get("base_url") if isinstance(manifest, dict) else None
    configured_models = manifest.get("models", []) if isinstance(manifest, dict) else []
    configured_model = next(
        (
            entry
            for entry in configured_models
            if isinstance(entry, dict)
            and entry.get("model_id") == observed_model_name
            and entry.get("name") == observed_model_name
        ),
        None,
    )
    if provider_base_url != PROVIDER_BASE_URL or configured_model is None:
        raise RuntimeError("TrueForge Cerebras provider configuration did not match the exercised model")
    return {
        "model_name": observed_model_name,
        "provider_base_url": provider_base_url,
        "runtime_identity_verified": True,
    }


def _write_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def _base_evidence() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "probe": "trueforge_cerebras",
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "model_name": "",
        "provider_base_url": "",
        "parallel_tool_calls": False,
        "response_format_on_tool_turn": False,
        "serial_tool_loop_executed": False,
        "native_denial_executed": False,
        "denied_tool_name": "",
        "side_effects_checked": False,
        "side_effects_observed": False,
        "runtime_identity_verified": False,
    }


def run(
    base_url: str,
    token: str | None,
    model_name: str,
    evidence_file: Path,
    status_file: Path,
) -> int:
    if model_name not in SUPPORTED_MODEL_NAMES:
        raise ValueError(
            f"unsupported Cerebras model {model_name!r}; "
            f"choose one of {sorted(SUPPORTED_MODEL_NAMES)}"
        )
    evidence = _base_evidence()
    server = _MCPServer(("127.0.0.1", 0), status_file)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    api = _API(base_url, token)
    connector_name = "peel-gate-mail-probe"
    try:
        connector_port = server.server_address[1]
        api.call(
            "PUT",
            "/api/v1/settings/mcp-servers",
            {
                "manifest": {
                    "name": connector_name,
                    "type": "remote",
                    "url": f"http://127.0.0.1:{connector_port}/mcp",
                    "description": "Temporary local no-op mail fixture for Peel approval-gate verification.",
                }
            },
        )
        agent_spec = {
            "model": {
                "name": f"cerebras/{model_name}",
                "params": {"parallel_tool_calls": False},
            },
            "instructions": (
                "This is a two-stage safety-gate test. The caller will run two sequential turns. "
                "In the first stage, use any required runtime discovery operations, then call "
                "the fixture's read_mail_status exactly once with no arguments and stop after its "
                "response. In the second stage, use any required runtime discovery operations, "
                "then request the fixture's send_email exactly once with "
                "to=owned@example.invalid, a test subject, and a test body. The send_email "
                "request must remain pending for native human approval. Do not ask the user any "
                "questions; all test values are already provided."
            ),
            "mcp_servers": [
                {
                    "name": connector_name,
                    "enable_tools": ["@all"],
                    "preload": True,
                    "require_approval_for_tools": ["send_email"],
                }
            ],
            "config": {
                "generative_ui": {"enabled": False},
                "ask_user_questions": {"enabled": False},
                "dynamic_sub_agents": {"enabled": False},
                "iteration_limit": 10,
            },
        }
        session_response = api.call("POST", "/api/v1/sessions", {"agent": {"spec": agent_spec}})
        session = session_response.get("data", {}) if isinstance(session_response, dict) else {}
        session_id = session.get("id")
        if not isinstance(session_id, str):
            raise RuntimeError("TrueForge did not return a session id")
        first_events = api.stream_turn(
            session_id,
            {
                "stream": True,
                "input": [
                    {
                        "type": "user.message",
                        "content": "Stage 1: read the mail fixture status exactly once, then stop.",
                    }
                ],
            },
        )
        first_calls = _tool_calls(first_events)
        first_done = next(
            (
                event
                for event in reversed(first_events)
                if event.get("type") == "turn.done"
            ),
            None,
        )
        first_status = first_done.get("state", {}).get("status") if first_done else None
        first_read_calls = [call_id for call_id, name in first_calls.items() if name == "read_mail_status"]
        if first_status != "done" or len(first_read_calls) != 1:
            event_types = ",".join(
                str(event.get("type")) for event in first_events if isinstance(event, dict)
            )
            raise RuntimeError(
                "TrueForge first serial read stage did not complete; "
                f"status={first_status!r}, read_calls={len(first_read_calls)}, events={event_types[:300]}"
            )
        read_completed = any(
            event.get("type") == "tool.response"
            and isinstance(event.get("tool_call_id"), str)
            and first_calls.get(event["tool_call_id"]) == "read_mail_status"
            for event in first_events
        )

        second_events = api.stream_turn(
            session_id,
            {
                "stream": True,
                "input": [
                    {
                        "type": "user.message",
                        "content": (
                            "Stage 2: request send_email exactly once with "
                            "to=owned@example.invalid, a test subject, and a test body. "
                            "Leave it pending for native approval."
                        ),
                    }
                ],
            },
        )
        second_calls = _tool_calls(second_events)
        approval = _approval(second_events)
        if approval is None:
            event_types = ",".join(
                str(event.get("type")) for event in second_events if isinstance(event, dict)
            )
            raise RuntimeError(f"TrueForge did not request native approval; events={event_types[:300]}")
        approval_refs = approval.get("tool_calls", [])
        send_refs = []
        for ref in approval_refs if isinstance(approval_refs, list) else []:
            if not isinstance(ref, dict):
                continue
            ref_id = ref.get("id")
            if isinstance(ref_id, str) and second_calls.get(ref_id) == "send_email":
                send_refs.append(ref)
        if len(send_refs) != 1:
            raise RuntimeError("TrueForge approval did not identify exactly one send_email call")
        second_send_calls = [call_id for call_id, name in second_calls.items() if name == "send_email"]
        runtime_identity = _runtime_identity(api, session_id, model_name)
        evidence.update(
            {
                **runtime_identity,
                "serial_tool_loop_executed": (
                    read_completed
                    and len(first_read_calls) == 1
                    and len(second_send_calls) == 1
                    and not any(name == "send_email" for name in first_calls.values())
                    and not any(name == "read_mail_status" for name in second_calls.values())
                ),
                "denied_tool_name": "send_email",
            }
        )
        resume_events = api.stream_turn(
            session_id,
            {
                "stream": True,
                "input": [
                    {
                        "type": "user.tool_approval",
                        "thread_id": approval.get("thread_id", "main"),
                        "tool_call_id": send_refs[0]["id"],
                        "approval": {"status": "deny", "reason": "Peel environment-gate denial proof."},
                    }
                ],
            },
        )
        # The denial is proved by TrueForge's denied tool response. The follow-up model
        # completion is not part of the safety boundary and may be rate-limited after
        # TrueForge has already rejected the tool call.
        evidence["native_denial_executed"] = _denial_response_observed(
            resume_events, send_refs[0]["id"]
        )
        status = server.fixture_state.snapshot()
        evidence["side_effects_checked"] = (
            status["read_only_tool_calls"] == 1
            and status["send_email_invoked"] is False
        )
        evidence["side_effects_observed"] = status["send_email_invoked"]
        success = all(
            (
                evidence["model_name"] in SUPPORTED_MODEL_NAMES,
                evidence["provider_base_url"] == PROVIDER_BASE_URL,
                evidence["runtime_identity_verified"] is True,
                evidence["parallel_tool_calls"] is False,
                evidence["response_format_on_tool_turn"] is False,
                evidence["serial_tool_loop_executed"] is True,
                evidence["native_denial_executed"] is True,
                evidence["denied_tool_name"] == "send_email",
                evidence["side_effects_checked"] is True,
                evidence["side_effects_observed"] is False,
            )
        )
        _write_evidence(evidence_file, evidence)
        print(
            json.dumps(
                {key: value for key, value in evidence.items() if key != "observed_at"},
                sort_keys=True,
            )
        )
        return 0 if success else 2
    except Exception as exc:
        _write_evidence(evidence_file, evidence)
        message = str(exc)
        if token:
            message = message.replace(token, "<redacted>")
        message = message[:500]
        print(
            json.dumps(
                {"error": message, "error_type": type(exc).__name__, "probe": "trueforge_cerebras"},
                sort_keys=True,
            )
        )
        return 2
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)


def main() -> int:
    _load_dotenv(Path(".env"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=TRUEFORGE_DEFAULT_URL)
    parser.add_argument("--token")
    parser.add_argument(
        "--model",
        default=os.environ.get("PEEL_TRUEFORGE_MODEL", "gemma-4-31b"),
        choices=sorted(SUPPORTED_MODEL_NAMES),
        help="Cerebras custom model configured in TrueForge (default: gemma-4-31b)",
    )
    parser.add_argument("--evidence-file", default=DEFAULT_EVIDENCE_FILE)
    parser.add_argument("--status-file", default="/tmp/peel-trueforge-mcp-status.json")
    args = parser.parse_args()
    return run(
        args.base_url,
        args.token,
        args.model,
        Path(args.evidence_file),
        Path(args.status_file),
    )


if __name__ == "__main__":
    raise SystemExit(main())
