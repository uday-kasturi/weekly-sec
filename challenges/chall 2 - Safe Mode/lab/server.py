#!/usr/bin/env python3
"""
Meadowlark "ops-assistant" MCP server (synthetic lab target).

A minimal Model Context Protocol server over the streamable-HTTP transport.
It exposes a few tools so an internal AI agent can check service health. One of
them, run_command, executes shell commands. It runs in "secure mode": every
command's executable must be on an allowlist before it runs.

This reproduces the vulnerability class behind CVE-2026-55580 / CVE-2026-55581
in github.com/sonirico/mcp-shell: shipping a shell interpreter (bash) on the
allowlist. Allowlisting the executable name is not a security boundary when the
allowlisted executable is itself a shell, because `bash -c '<anything>'` keeps
`bash` as argv[0] and runs arbitrary code.

Nothing here is malicious. It is intentionally vulnerable and is meant to run
only inside the challenge's Docker lab, bound to 127.0.0.1.
"""
import json
import os
import shlex
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Mirrors lab/config/security.yaml (shipped as evidence). Secure mode is ON, and
# the allowlist looks careful... but `bash` is on it.
SECURE_MODE = True
ALLOWED_EXECUTABLES = ["ls", "cat", "echo", "grep", "head", "tail", "wc", "uptime", "df", "bash"]
COMMAND_TIMEOUT = 10

SERVER_INFO = {"name": "meadowlark-ops-assistant", "version": "0.5.2"}
PROTOCOL_VERSION = "2025-06-18"

TOOLS = [
    {
        "name": "service_status",
        "description": "Report whether a named internal service is up. Reads from a fixed status file.",
        "inputSchema": {
            "type": "object",
            "properties": {"service": {"type": "string", "description": "service name, e.g. billing-api"}},
            "required": ["service"],
        },
    },
    {
        "name": "read_metric",
        "description": "Return the latest value of a whitelisted host metric (load, disk, mem).",
        "inputSchema": {
            "type": "object",
            "properties": {"metric": {"type": "string", "enum": ["load", "disk", "mem"]}},
            "required": ["metric"],
        },
    },
    {
        "name": "run_command",
        "description": (
            "Run a diagnostic shell command on the ops host. Secure mode is enabled: "
            "the command's executable must be on the server allowlist, so only safe, "
            "read-only diagnostics can run."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "the full command line to run"}},
            "required": ["command"],
        },
    },
]


def validate_command(command):
    """Secure-mode check: the executable (argv[0]) must be on the allowlist.

    This is the real bug. The check is correct as written -- but with `bash` on
    the allowlist, `bash -c '...'` passes it and runs anything.
    """
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        return None, f"could not parse command: {exc}"
    if not argv:
        return None, "empty command"
    if SECURE_MODE:
        executable = os.path.basename(argv[0])
        if executable not in ALLOWED_EXECUTABLES:
            return None, (
                f"blocked by secure mode: '{executable}' is not on the allowlist "
                f"({', '.join(ALLOWED_EXECUTABLES)})"
            )
    return argv, None


def run_command(command):
    argv, err = validate_command(command)
    if err:
        return {"ok": False, "error": err}
    try:
        # No shell=True: argv is executed directly. The shell comes from argv[0]
        # being bash, not from this call.
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=COMMAND_TIMEOUT)
    except FileNotFoundError:
        return {"ok": False, "error": f"executable not found: {argv[0]}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"command timed out after {COMMAND_TIMEOUT}s"}
    out = (proc.stdout or "") + (proc.stderr or "")
    return {"ok": True, "exit_code": proc.returncode, "output": out[:20000]}


STATUS = {
    "billing-api": "up (healthy, 3 replicas)",
    "auth": "up (healthy, 2 replicas)",
    "etl-nightly": "idle (last run 02:14 UTC, ok)",
}
METRICS = {"load": "0.41 0.37 0.33", "disk": "61% of 200G used", "mem": "5.8G / 16G used"}


def call_tool(name, args):
    if name == "service_status":
        svc = str(args.get("service", ""))
        return STATUS.get(svc, f"unknown service: {svc}")
    if name == "read_metric":
        metric = str(args.get("metric", ""))
        return METRICS.get(metric, f"unknown metric: {metric}")
    if name == "run_command":
        result = run_command(str(args.get("command", "")))
        return json.dumps(result)
    raise KeyError(name)


def handle_rpc(msg):
    """Minimal JSON-RPC 2.0 dispatch for the MCP methods this server supports."""
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        return ok(mid, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": "Operations assistant. Use the tools to check internal service health.",
        })
    if method in ("notifications/initialized", "initialized"):
        return None  # notification: no response
    if method == "ping":
        return ok(mid, {})
    if method == "tools/list":
        return ok(mid, {"tools": TOOLS})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            text = call_tool(name, args)
        except KeyError:
            return err(mid, -32602, f"unknown tool: {name}")
        return ok(mid, {"content": [{"type": "text", "text": text}], "isError": False})
    return err(mid, -32601, f"method not found: {method}")


def ok(mid, result):
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def err(mid, code, message):
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # keep container logs quiet
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/health"):
            self._send(200, b'{"status":"ok","server":"meadowlark-ops-assistant"}')
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if self.path.rstrip("/") not in ("/mcp", ""):
            self._send(404, b'{"error":"not found; POST JSON-RPC to /mcp"}')
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            msg = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send(200, json.dumps(err(None, -32700, "parse error")).encode())
            return
        messages = msg if isinstance(msg, list) else [msg]
        responses = [r for r in (handle_rpc(m) for m in messages) if r is not None]
        if not responses:
            self._send(202, b"")  # only notifications
            return
        body = json.dumps(responses[0] if len(responses) == 1 else responses).encode()
        self._send(200, body)


def main():
    host = os.environ.get("BIND_HOST", "0.0.0.0")  # inside the container; compose maps to 127.0.0.1
    port = int(os.environ.get("PORT", "8808"))
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"meadowlark ops-assistant MCP server on {host}:{port} (secure_mode={SECURE_MODE})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
