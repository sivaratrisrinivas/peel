import json
from pathlib import Path
from typing import Any, cast

from scripts.trueforge_gate_mcp import _FixtureState
from scripts.trueforge_gate_probe import _denial_response_observed, _runtime_identity, _tool_calls


def test_tool_calls_fold_streamed_deferred_tool_call_deltas() -> None:
    events: list[dict[str, Any]] = [
        {
            "type": "model.message.delta",
            "tool_calls": [
                {
                    "index": 0,
                    "id": "send-1",
                    "type": "function",
                    "function": {
                        "name": "call_tool",
                        "arguments": '{"mcp_server":"peel-gate-mail-probe","tool_name":"send_',
                    },
                }
            ],
        },
        {
            "type": "model.message.delta",
            "tool_calls": [
                {"index": 0, "function": {"arguments": 'email","input":{}}'}},
            ],
        },
    ]

    assert _tool_calls(events) == {"send-1": "send_email"}


def test_tool_calls_resolve_deferred_call_tool_to_underlying_name() -> None:
    events: list[dict[str, Any]] = [
        {
            "type": "model.message",
            "tool_calls": [
                {
                    "id": "send-1",
                    "function": {
                        "name": "call_tool",
                        "arguments": json.dumps(
                            {
                                "mcp_server": "peel-gate-mail-probe",
                                "tool_name": "send_email",
                                "input": {},
                            }
                        ),
                    },
                }
            ],
        }
    ]

    assert _tool_calls(events) == {"send-1": "send_email"}


def test_denial_response_is_observed_even_when_follow_up_is_rate_limited() -> None:
    events: list[dict[str, Any]] = [
        {
            "type": "tool.response",
            "tool_call_id": "send-1",
            "content": json.dumps(
                {"error": [{"type": "text", "text": '{"error":"User denied tool call: test"}'}]}
            ),
        },
        {"type": "turn.done", "state": {"status": "error", "message": "Request failed (429)"}},
    ]

    assert _denial_response_observed(events, "send-1") is True
    assert _denial_response_observed(events, "other-call") is False


def test_runtime_identity_comes_from_trueforge_catalog() -> None:
    responses = {
        ("GET", "/api/v1/sessions/session-1"): {
            "data": {"agent": {"spec": {"model": {"name": "cerebras/gemma-4-31b"}}}}
        },
        ("GET", "/api/v1/models"): {
            "data": [
                {
                    "model_id": "gemma-4-31b",
                    "name": "cerebras/gemma-4-31b",
                    "provider": {"name": "cerebras"},
                }
            ]
        },
        ("GET", "/api/v1/settings/model-providers"): {
            "data": [
                {
                    "name": "cerebras",
                    "manifest": {
                        "base_url": "https://api.cerebras.ai/v1",
                        "models": [{"model_id": "gemma-4-31b", "name": "gemma-4-31b"}],
                    },
                }
            ]
        },
    }

    class FakeAPI:
        def call(self, method: str, path: str) -> Any:
            return responses[(method, path)]

    assert _runtime_identity(cast(Any, FakeAPI()), "session-1", "gemma-4-31b") == {
        "model_name": "gemma-4-31b",
        "provider_base_url": "https://api.cerebras.ai/v1",
        "runtime_identity_verified": True,
    }


def test_status_write_replaces_symlink_without_touching_target(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_text("do not overwrite", encoding="utf-8")
    status = tmp_path / "status.json"
    status.symlink_to(target)

    _FixtureState(status)

    assert target.read_text(encoding="utf-8") == "do not overwrite"
    assert not status.is_symlink()
    assert json.loads(status.read_text(encoding="utf-8"))["read_only_tool_calls"] == 0
