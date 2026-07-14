# Cross-device Terminal Design

## Status

Accepted. The user requested cross-device terminals in the existing LightOS instance switcher and delegated implementation details to project best practices.

## Goal

Allow the provider to open the native WebShell terminal service exposed by another visible LazyCat client device while preserving the existing LightOS, Herdr, zellij, SSH, mobile, and settings behavior.

## Scope

- Discover account-visible client instances from lightos-admin `/api/client-instances`.
- Show them in the existing instance switcher under a separate “Remote devices” group.
- Proxy the official remote workspace GET/action APIs and terminal WebSocket.
- Support only the native WebShell backend for remote clients.
- Keep the embedded lightweight agent for normal LightOS instances; remote clients remain authoritative for their own terminal state.
- Do not add remote file transfer, remote LightOS port forwarding, Herdr, or zellij in this change.

## Architecture

The provider keeps three boundaries explicit:

1. `lightos_admin.rs` is the account-scoped discovery adapter. It calls both official admin endpoints with the browser’s safe auth headers and maps their JSON responses into the internal `Instance` protobuf model.
2. `client_terminal.rs` is the remote-terminal adapter. It re-authorizes every `client:<id>` request against the current account-visible list, obtains a short-lived terminal ticket, resolves the device API auth token, converts workspace JSON, and proxies WebSocket frames.
3. The shared `lzc-sdk` crate owns device authentication. `client_terminal.rs` loads the mounted LazyCat credentials through `ClientCredentials`, resolves the short-lived token through `TokenProvider`, and never reimplements the official protobuf signing or gRPC transport locally.

Transport compatibility currently matches the official Go provider and LazyCat SDK: device HTTP and WebSocket clients accept the platform's self-signed or hostname-mismatched certificates. This is a deliberate interoperability exception, not strict peer-identity verification. Credential-bearing HTTP clients must not follow redirects, and tickets, device tokens, certificate material, and signed authentication payloads must never be logged. Tightening certificate verification requires a documented LightOS device-certificate identity contract and real-device compatibility testing first.

Normal LightOS selectors continue to use the embedded instance-local agent. Remote selectors never enter `lightosctl`, agent install, Herdr, zellij, or local workspace persistence paths.

## Internal protobuf contract

`Instance` gains additive fields:

- `InstanceKind kind`: `LIGHTOS`, `REMOTE_CLIENT`, or `SSH`.
- `string platform`: populated for remote clients.
- `string owner_user_id`: populated when lightos-admin returns it.

Selectors remain stable:

- LightOS: `<name>@<owner_deploy_id>`
- Remote client: `client:<client_instance_id>`
- SSH: existing `ssh:<profile_id>` form

The device auth protobuf and transport are supplied by the shared `lzc-sdk` crate. The provider keeps no copied permission proto or provider-owned signing implementation. The external HTTP admin API remains JSON because that is the platform contract.

## Remote request flow

For every workspace request or terminal attach:

1. Extract the current account from the same headers used by instance discovery.
2. Parse `client:<id>` with strict length and character validation.
3. Fetch `/api/client-instances` and confirm the ID is still visible to that account.
4. POST `/api/client-instances/terminal-ticket` with the requested ID.
5. Validate the ticket: matching client ID, `http`/`https` device URL, safe terminal service name, non-empty ticket.
6. Resolve `lzc_dapi_auth_token` through the official device permission gRPC call.
7. Request `device_api_url/s/<terminal_service_name>/<path>` with the ticket query parameter and auth-token header.

Ticket and device auth token values are never logged or returned to the browser. Diagnostic URLs redact the ticket.

## Workspace conversion

The official remote terminal service returns its Go workspace schema. The provider converts it into the current Rust/frontend schema:

- pane ID is also used as the stable `session_id`;
- `session_backend` is always `webshell`;
- `status` is `running` unless the remote pane reports `exited`;
- layout, active tab, pane size, labels, and exit state are preserved;
- unsupported local metadata such as pin ordering is omitted.

The layout and action contracts require an explicit wire adapter rather than direct reuse of the local Rust types. The Go service represents pane nodes as `type: "leaf"`, split orientation as `direction: "vertical" | "horizontal"`, and optional child percentages as `size`. The Rust/frontend model uses `type: "pane"` and `axis: "columns" | "rows"`. Likewise, directional Rust splits map left/right to Go `vertical` and up/down to Go `horizontal`, while Rust `promote_pane_to_tab` maps to the Go action name `move_pane_to_tab`. Contract tests must use the literal Go JSON field and action names.

Workspace actions are converted in the other direction and only the native action set already supported by both implementations is forwarded. `session_backend` values other than `webshell` are rejected for remote clients.

## WebSocket compatibility

The remote service’s binary terminal bytes pass through unchanged. Text control frames are adapted:

- `history-replay-start` becomes the current `replay-start` event with selector, pane, session identity, and replay cursor.
- `history-replay-complete` becomes `replay-complete`.
- `process-exit` and other compatible control messages pass through.

The browser WebSocket is upgraded after authorization, ticket, and SDK token preparation but before dialing the remote terminal, matching the Go provider. A target dial failure is returned as a retryable `process-exit` control event. Remote panes send a 10-second JSON ping so the Go attach service does not hit its 30-second read deadline, extend replay input locking to 45 seconds while receiving `agent-preparing`, and mark the single allowed replay-generated terminal response with `generated: true`.

The frontend resets only a remote-client terminal when replay starts, matching the official client behavior and preventing duplicated history after reconnect. Instance switching remains immediate and receives no decorative animation because it is a frequent operation.

## UI and UX

The existing switcher is grouped into “LightOS instances”, “Remote devices”, and “SSH” only when each group has items. A remote row shows device name, platform, and status. Frequent switch interactions stay animation-free; rows retain concise press feedback and keyboard/accessibility semantics.

When a remote device is selected:

- the new-tab backend list contains only native WebShell;
- Herdr discovery is skipped;
- LightOS-only SSH-from-instance affordances are hidden;
- stopped/offline devices remain visible but disabled.

## Error handling

- Missing account: `401`.
- Invalid remote selector or action: `400`.
- Client no longer visible: `403`.
- Admin/ticket/device service failure: `502`, with credentials redacted.
- Timeout: `504` where the failing boundary is known.
- Remote WebSocket dial failure: upgrade succeeds only after authorization/ticket preparation; a post-upgrade target failure is sent as a fatal `process-exit` control event.

## Verification

- Unit tests for selector validation, client-instance JSON conversion, grouping, workspace conversion, ticket URL/redaction, protobuf gRPC frames, and replay-frame adaptation.
- Integration-style HTTP tests for account headers, visibility authorization, ticket request, and remote workspace proxying.
- Rust tests and Clippy for all targets.
- Frontend tests, typecheck, generated protobuf, and production build.
- Host release build with the embedded lightweight agent.
- musl LPK release and lint.
- Real-device acceptance remains required before claiming cross-device runtime success.
