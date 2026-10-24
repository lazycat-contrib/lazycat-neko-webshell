#!/usr/bin/env python3
import argparse
import base64
import io
import json
import os
import select
import socket
import struct
import subprocess
import tempfile
import threading
import time


def frame(payload):
    return struct.pack(">I", len(payload)) + payload


def receive_exact(reader, length):
    data = bytearray()
    while len(data) < length:
        chunk = reader(length - len(data))
        if not chunk:
            raise RuntimeError("unexpected control-stream EOF")
        data.extend(chunk)
    return bytes(data)


def receive_frame(reader):
    length = struct.unpack(">I", receive_exact(reader, 4))[0]
    if length > 32 * 1024 * 1024:
        raise RuntimeError("oversized control response")
    return receive_exact(reader, length)


def pipe_reader(pipe):
    def read(length):
        ready, _, _ = select.select([pipe], [], [], 3)
        if not ready:
            raise RuntimeError("control helper timed out")
        return os.read(pipe.fileno(), length)
    return read


def summarize(samples, starts):
    ordered = sorted(samples)
    return {
        "requests": len(samples),
        "helper_process_starts": starts,
        "median_ms": ordered[len(ordered) // 2] * 1000,
        "p95_ms": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))] * 1000,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", required=True)
    parser.add_argument("--requests", type=int, default=50)
    parser.add_argument("--single-only", action="store_true")
    options = parser.parse_args()
    if not 1 <= options.requests <= 1000:
        parser.error("requests must be between 1 and 1000")
    request = b"\x08\x01"
    response = b"\x08\x01"
    with tempfile.TemporaryDirectory(prefix="neko-control-bench-") as directory:
        address = os.path.join(directory, "agent.sock")
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(address)
        listener.listen(8)
        listener.settimeout(0.1)
        stopped = threading.Event()
        failures = []

        def serve():
            while not stopped.is_set():
                try:
                    connection, _ = listener.accept()
                except socket.timeout:
                    continue
                with connection:
                    connection.settimeout(3)
                    try:
                        if receive_frame(connection.recv) != request:
                            raise RuntimeError("mock received unexpected request bytes")
                        connection.sendall(frame(response))
                    except Exception as error:
                        failures.append(str(error))

        worker = threading.Thread(target=serve)
        worker.start()
        try:
            samples = []
            for _ in range(options.requests):
                started = time.perf_counter()
                result = subprocess.run(
                    [options.agent, "agent", "request", "--socket", address,
                     "--request", base64.b64encode(request).decode()],
                    capture_output=True, check=True, timeout=3,
                )
                if receive_frame(io.BytesIO(result.stdout).read) != response:
                    raise RuntimeError("one-shot response mismatch")
                samples.append(time.perf_counter() - started)
            results = {"scope": "local helper and mock Unix socket, not LightOS/WAN", "one_shot": summarize(samples, options.requests)}
            if not options.single_only:
                started = time.perf_counter()
                process = subprocess.Popen(
                    [options.agent, "agent", "request-stream", "--socket", address],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                )
                try:
                    read = pipe_reader(process.stdout)
                    receive_frame(read)
                    startup = time.perf_counter() - started
                    samples = []
                    for _ in range(options.requests):
                        started = time.perf_counter()
                        process.stdin.write(frame(request))
                        process.stdin.flush()
                        if receive_frame(read) != response:
                            raise RuntimeError("stream response mismatch")
                        samples.append(time.perf_counter() - started)
                    results["stream"] = {**summarize(samples, 1), "startup_ms": startup * 1000}
                    process.stdin.close()
                    if process.wait(timeout=3) != 0:
                        raise RuntimeError("stream helper failed to exit cleanly")
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=3)
            if failures:
                raise RuntimeError(str(failures))
            print(json.dumps(results, indent=2))
        finally:
            stopped.set()
            worker.join(timeout=4)
            listener.close()
            if worker.is_alive():
                raise RuntimeError("mock server did not stop")


if __name__ == "__main__":
    main()
