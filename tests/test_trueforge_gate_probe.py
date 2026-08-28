import json
from typing import Any

from scripts.trueforge_gate_probe import _denial_response_observed, _tool_calls


def test_tool_calls_fold_streamed_tool_call_deltas() -> None:
    events: list[dict[str, Any]] = [
        {
            "type": "model.message.delta",
            "tool_calls": [
                {
                    "index": 0,
                    "id": "read-1",
                    "type": "function",
                    "function": {"name": "read_mail_status", "arguments": "{"},
                }
            ],
        },
        {
            "type": "model.message.delta",
            "tool_calls": [
                {"index": 0, "function": {"arguments": "}"}},
            ],
        },
    ]

    assert _tool_calls(events) == {"read-1": "read_mail_status"}


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
            "content": json.dumps(
                {"error": [{"type": "text", "text": '{"error":"User denied tool call: test"}'}]}
            ),
        },
        {"type": "turn.done", "state": {"status": "error", "message": "Request failed (429)"}},
    ]

    assert _denial_response_observed(events) is True
