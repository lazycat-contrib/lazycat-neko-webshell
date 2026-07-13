# Remote Device HTTP/2 Fix Design

## Status

Approved for implementation on 2026-07-13.

## Problem

The instance switcher lists running remote devices, but selecting one cannot load its workspace. Discovery succeeds because `/api/client-instances` is a normal JSON request. The first remote workspace request then calls `device_api_auth::resolve_auth_token`, which sends the device `RequestAuthToken` gRPC request through reqwest.

The project disables reqwest default features and does not enable its `http2` feature. The resolved reqwest transport therefore supports HTTP/1.1 only, while the device permission endpoint requires HTTP/2. The working Go provider uses `grpc.Dial`, so it does not have this protocol mismatch.

## Fix

Enable reqwest's `http2` feature and configure the device authentication client to use HTTP/2 only. Keep this setting inside `device_api_auth.rs`; JSON admin, ticket, workspace, and attachment requests do not need transport changes.

Add safe tracing around the remote authentication boundary. Logs may include the request stage and redacted device origin, but must not include terminal tickets, device tokens, certificates, signatures, cookies, or authorization headers.

No frontend changes are required. The existing instance-row handler and `client:<id>` workspace dispatch remain unchanged, and `main.ts` stays an orchestration layer.

## Regression Guard

Add a transport-level test that fails when the device authentication client cannot negotiate HTTP/2. The test should use a local HTTP/2 endpoint and verify both the request protocol and decoded token response without reading mounted production credentials.

Keep the existing tests for gRPC framing, certificate parsing, signatures, endpoint construction, ticket validation, and remote workspace conversion.

## Verification

Run the focused device authentication and client terminal tests, followed by the full Rust test suite, Clippy, frontend tests, type checking, and the production frontend build. Confirm through Cargo's feature graph that reqwest enables `http2`.

Real-device acceptance requires selecting a running remote device, loading its workspace, opening or attaching a terminal pane, and receiving terminal output. If the deployment environment is unavailable, report that check as pending instead of treating compilation as runtime proof.
