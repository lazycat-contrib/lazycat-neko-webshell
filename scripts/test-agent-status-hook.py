#!/usr/bin/env python3
"""Exercise the built helper in a real Linux PTY, without any user configuration."""

import errno
import json
import os
import pty
import select
import signal
import sys
import time


CHILD = r'''
import json, os, signal, subprocess, sys, time

binary = sys.argv[1]
enabled = dict(os.environ, NEKO_WEBSHELL_AGENT_STATUS="1")
payload = json.dumps({"session_id": "smoke", "hook_event_name": "PermissionRequest",
                      "tool_input": {"command": "PRIVATE_COMMAND"}}).encode()

def call(data=payload, env=enabled, agent="codex", **kwargs):
    result = subprocess.run([binary, "status-hook", agent], input=data, env=env,
                            capture_output=True, timeout=2, **kwargs)
    assert result.returncode == 0, result
    assert result.stdout == result.stderr == b"", result

call()  # The only accepted report.
call(env=dict(enabled, NEKO_WEBSHELL_AGENT_STATUS="0"))
call(agent="claude")  # A helper cannot borrow another Agent's identity.
call(start_new_session=True)  # No controlling terminal.
call(process_group=0)  # A background group on the same terminal.
call(data=b"invalid json")
call(data=json.dumps({"session_id": "s", "hook_event_name": "SubagentStop"}).encode())
call(data=b"x" * (128 * 1024))

# A hook sender that keeps stdin open cannot stall the Agent indefinitely.
p = subprocess.Popen([binary, "status-hook", "codex"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=enabled)
assert p.wait(timeout=2) == 0
p.stdin.close()
assert p.stdout.read() == p.stderr.read() == b""

# Let the helper bind, then replace the foreground group before providing JSON.
other = subprocess.Popen(["sleep", "3"], process_group=0)
p = subprocess.Popen([binary, "status-hook", "codex"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=enabled)
try:
    input_pipe = os.readlink(f"/proc/{p.pid}/fd/0")
    deadline = time.monotonic() + 1
    while True:
        # The helper opens a second descriptor for stdin only after its first
        # identity check. Wait for that boundary before replacing foreground.
        try:
            copies = sum(os.readlink(f"/proc/{p.pid}/fd/{fd}") == input_pipe
                         for fd in os.listdir(f"/proc/{p.pid}/fd"))
        except FileNotFoundError:
            copies = 0
        if copies >= 2:
            break
        assert p.poll() is None and time.monotonic() < deadline, "helper never bound stdin"
        time.sleep(0.001)
    os.tcsetpgrp(0, other.pid)
    try:
        p.stdin.write(payload)
        p.stdin.close()
    except BrokenPipeError:
        pass
    assert p.wait(timeout=2) == 0
    assert p.stdout.read() == p.stderr.read() == b""
finally:
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    os.tcsetpgrp(0, os.getpgrp())
    other.terminate()
    other.wait()
print("HOOK_SMOKE_OK", flush=True)
'''


def main():
    binary = os.path.abspath(sys.argv[1])
    pid, master = pty.fork()
    if pid == 0:
        # Match a real foreground Agent command without installing an Agent CLI.
        os.execv(sys.executable, ["codex", "-c", CHILD, binary])
    output = bytearray()
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            if not select.select([master], [], [], 0.2)[0]:
                continue
            try:
                chunk = os.read(master, 8192)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output.extend(chunk)
        else:
            os.kill(pid, signal.SIGKILL)
            raise AssertionError("hook smoke timed out")
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0, repr(output)
        report = b"\x1b]7501;state=blocked:kind=permission:app=codex:id=_neko_hook\x07"
        assert bytes(output) == report + b"HOOK_SMOKE_OK\r\n", repr(output)
        print("Agent status hook: foreground PTY, quiet failures, input budget and isolation passed.")
    finally:
        os.close(master)


if __name__ == "__main__":
    main()
