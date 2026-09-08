#!/usr/bin/env python3
import base64
import fcntl
import json
import os
import pty
import signal
import select
import struct
import subprocess
import sys
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MAX_BODY_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_INPUT_EVENTS = 2048


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: bridge.py HERDR_BINARY STATE_DIRECTORY")
    herdr_binary = Path(sys.argv[1]).resolve(strict=True)
    state_dir = Path(sys.argv[2]).resolve(strict=True)
    state_dir.mkdir(parents=True, exist_ok=True)
    config_path = state_dir / "config.toml"
    socket_path = state_dir / "herdr.sock"
    xdg_path = state_dir / "xdg"
    # The launcher owns a fresh namespace; never attach to or stop an existing socket.
    if socket_path.exists() or config_path.exists():
        raise RuntimeError("Herdr fixture requires a fresh isolated state directory")
    config_path.write_text(
        'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n'
        '[update]\nversion_check = false\nmanifest_check = false\n',
        encoding="utf-8",
    )

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
    child_env = controlled_environment(config_path, socket_path, xdg_path)
    child = subprocess.Popen(
        [str(herdr_binary)],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=child_env,
        cwd=state_dir,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)

    output = bytearray()
    output_base = 0
    input_events = []
    lock = threading.Lock()

    def read_output():
        nonlocal output_base
        while True:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            with lock:
                output.extend(chunk)
                if len(output) > MAX_OUTPUT_BYTES:
                    removed = len(output) - MAX_OUTPUT_BYTES
                    del output[:removed]
                    output_base += removed

    threading.Thread(target=read_output, daemon=True, name="herdr-output").start()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/status":
                self.send_json({"running": child.poll() is None, "pid": child.pid})
                return
            if parsed.path == "/inputs":
                with lock:
                    events = list(input_events)
                self.send_json({"events": events})
                return
            if parsed.path != "/output":
                self.send_error(404)
                return
            try:
                requested = int(parse_qs(parsed.query).get("offset", ["0"])[0])
            except ValueError:
                self.send_error(400, "invalid output offset")
                return
            with lock:
                if requested < output_base:
                    self.send_error(410, "output offset was evicted")
                    return
                relative = requested - output_base
                body = bytes(output[relative:])
                end = output_base + len(output)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Output-End", str(end))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400, "invalid content length")
                return
            if length < 0 or length > MAX_BODY_BYTES:
                self.send_error(413, "request body is too large")
                return
            data = self.rfile.read(length)
            if len(data) != length:
                self.send_error(400, "incomplete request body")
                return
            if self.path == "/input":
                with lock:
                    input_events.append(base64.b64encode(data).decode("ascii"))
                    if len(input_events) > MAX_INPUT_EVENTS:
                        del input_events[: len(input_events) - MAX_INPUT_EVENTS]
                try:
                    write_all(master, data)
                except (OSError, TimeoutError) as error:
                    self.send_error(503, str(error))
                    return
            elif self.path == "/resize":
                try:
                    size = json.loads(data)
                    rows = bounded_dimension(size["rows"])
                    cols = bounded_dimension(size["cols"])
                except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                    self.send_error(400, "invalid terminal size")
                    return
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                os.killpg(child.pid, signal.SIGWINCH)
            else:
                self.send_error(404)
                return
            self.send_response(204)
            self.end_headers()

        def send_json(self, value):
            body = json.dumps(value, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)

    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        if child.poll() is not None:
            with lock:
                startup_output = bytes(output[-16 * 1024 :]).decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Herdr exited during startup with status {child.returncode}: {startup_output}"
            )
        print(
            json.dumps(
                {
                    "type": "ready",
                    "port": server.server_address[1],
                    "herdrPid": child.pid,
                    "socketPath": str(socket_path),
                    "configPath": str(config_path),
                    "xdgPath": str(xdg_path),
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        try:
            # Normal 0.8/0.9 launches may detach a daemon outside the PTY process
            # group. Address only the uniquely owned socket, never the default server.
            result = subprocess.run(
                [str(herdr_binary), "server", "stop"], env=child_env, cwd=state_dir,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False,
            )
            if result.returncode != 0 and socket_path.exists():
                raise RuntimeError("failed to stop the isolated Herdr server")
        finally:
            try:
                stop_process_group(child)
            finally:
                os.close(master)


def controlled_environment(config_path, socket_path, xdg_path):
    environment = {
        key: os.environ[key]
        for key in ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL")
        if key in os.environ
    }
    environment.update(
        {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "TERM": "xterm-256color",
            "SHELL": "/bin/sh",
            "HERDR_CONFIG_PATH": str(config_path),
            "HERDR_SOCKET_PATH": str(socket_path),
            "XDG_CONFIG_HOME": str(xdg_path),
        }
    )
    return environment


def bounded_dimension(value):
    dimension = int(value)
    if dimension < 1 or dimension > 1000:
        raise ValueError("terminal dimension out of bounds")
    return dimension


def write_all(fd, data):
    offset = 0
    deadline = time.monotonic() + 1
    while offset < len(data):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("PTY input write timed out")
        _, writable, _ = select.select([], [fd], [], remaining)
        if not writable:
            raise TimeoutError("PTY input write timed out")
        offset += os.write(fd, data[offset:])


def stop_process_group(child):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        child.wait(timeout=3)
        return
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)


if __name__ == "__main__":
    main()
