#!/usr/bin/env python3
"""Serve a local no-op MCP server for the TrueForge approval gate probe.

The fixture exposes one read-only tool and one approval-gated ``send_email``
tool. It never sends mail; the latter only records whether TrueForge invoked it.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class _FixtureState:
    def __init__(self, status_file: Path) -> None:
        self._lock = threading.RLock()
        self._status_file = status_file
        self._read_only_tool_calls = 0
        self._send_email_invoked = False
        self._requests_received = 0
        self._write()

    def record_request(self) -> None:
        with self._lock:
            self._requests_received += 1
            self._write()

    def record_tool_call(self, name: str) -> None:
        with self._lock:
            if name == "read_mail_status":
                self._read_only_tool_calls += 1
            elif name == "send_email":
                self._send_email_invoked = True
            self._write()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "read_only_tool_calls": self._read_only_tool_calls,
                "send_email_invoked": self._send_email_invoked,
                "requests_received": self._requests_received,
            }

    def _write(self) -> None:
        self._status_file.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._status_file.parent,
                prefix=f".{self._status_file.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_name = temporary.name
                temporary.write(json.dumps(self.snapshot(), sort_keys=True) + "\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            if temporary_name is None:
                raise RuntimeError("temporary status file was not created")
            os.replace(temporary_name, self._status_file)
            temporary_name = None
        finally:
            if temporary_name is not None:
                Path(temporary_name).unlink(missing_ok=True)


def _tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "name": "read_mail_status",
            "description": "Read the fixed no-op mail fixture status; this never sends mail.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": True, "destructiveHint": False},
        },
        {
            "name": "send_email",
            "description": (
                "Send an email. This fixture must always be approval-gated and never be "
                "invoked during the denial proof."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": {"type": "string"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                },
                "required": ["to", "subject", "body"],
                "additionalProperties": False,
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": True},
        },
    ]


class _MCPHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PeelGateMCP/1"

    @property
    def fixture_state(self) -> _FixtureState:
        return self.server.fixture_state  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        if self.path == "/status":
            self._send_json(200, self.fixture_state.snapshot())
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/mcp":
            self._send_json(404, {"error": "not found"})
            return
        self.fixture_state.record_request()
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "invalid JSON"})
            return
        if not isinstance(request, dict):
            self._send_json(400, {"error": "request must be an object"})
            return

        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params")
        if method == "notifications/initialized":
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if method == "initialize":
            requested_version = params.get("protocolVersion") if isinstance(params, dict) else None
            self._send_result(
                request_id,
                {
                    "protocolVersion": requested_version or "2024-11-05",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "peel-gate-mcp", "version": "1"},
                },
            )
            return
        if method == "tools/list":
            self._send_result(request_id, {"tools": _tool_definitions()})
            return
        if method == "tools/call":
            self._handle_tool_call(request_id, params)
            return
        if method == "ping":
            self._send_result(request_id, {})
            return
        self._send_error(request_id, -32601, "method not found")

    def _handle_tool_call(self, request_id: Any, params: Any) -> None:
        if not isinstance(params, dict) or not isinstance(params.get("name"), str):
            self._send_error(request_id, -32602, "tool name is required")
            return
        name = params["name"]
        self.fixture_state.record_tool_call(name)
        if name == "read_mail_status":
            self._send_result(
                request_id,
                {"content": [{"type": "text", "text": "No side effects have occurred."}]},
            )
            return
        if name == "send_email":
            self._send_result(
                request_id,
                {
                    "isError": True,
                    "content": [{"type": "text", "text": "send_email fixture invoked unexpectedly"}],
                },
            )
            return
        self._send_error(request_id, -32602, "unknown tool")

    def _send_result(self, request_id: Any, result: dict[str, Any]) -> None:
        self._send_json(200, {"jsonrpc": "2.0", "id": request_id, "result": result})

    def _send_error(self, request_id: Any, code: int, message: str) -> None:
        self._send_json(
            200,
            {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}},
        )

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        session_id = getattr(self.server, "mcp_session_id", None)
        if session_id:
            self.send_header("Mcp-Session-Id", session_id)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


class _MCPServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], status_file: Path) -> None:
        super().__init__(address, _MCPHandler)
        self.fixture_state = _FixtureState(status_file)
        self.mcp_session_id = uuid.uuid4().hex


def serve(host: str, port: int, status_file: Path) -> None:
    server = _MCPServer((host, port), status_file)
    try:
        print(
            json.dumps({"host": host, "port": server.server_address[1], "status_file": str(status_file)}),
            flush=True,
        )
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--status-file", type=Path, default=Path("/tmp/peel-trueforge-mcp-status.json"))
    args = parser.parse_args()
    serve(args.host, args.port, args.status_file)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
