# Official LightOS WebShell Contract Parity Design

## Context

The official Go provider works on the user's current LightOS system, while the
Rust provider fails in `v0.5.19` through `v0.5.21`: native terminals cannot be
created, Herdr disappears, and the selected instance is shown as unknown.

The official provider changed its visible-instance path in commit `875eeab`
(`fix: load visible instances from LightOS admin`). It now forwards the current
LightOS account context to lightos-admin `/api/webshell/instances`. It also
accepts a server-provided `selector` field instead of requiring every item to
contain both `name` and `owner_deploy_id`.

The Rust provider still lists instances only with `/lzcinit/lightosctl ps`,
ignores an explicit `selector`, and silently drops incomplete records. Its
frontend then overwrites the useful load/create error with `空闲` whenever no
pane exists.

## Selected Approach

Port only the official contract needed by local LightOS WebShell targets:

- `/api/instances` obtains browser-visible instances from lightos-admin
  `/api/webshell/instances` with the current account headers.
- Provider build output carries the same `LIGHTOS_REQUIRE_COOKIE_AUTH` and
  optional `LIGHTOS_ADMIN_INTERNAL_BASE_URL` configuration used by the official
  provider.
- Instance decoding accepts an explicit `selector` and otherwise derives
  `<name>@<owner_deploy_id>`.
- `/lzcinit/lightosctl ps` remains the execution boundary for target
  authorization, status, and login-user lookup, but its parser also accepts an
  explicit `selector`.
- Empty-terminal rendering does not erase a current startup/connection error.

Remote PC client targets (`client:*`), terminal tickets, and other official
product additions are intentionally excluded from this repair.

## Module Boundaries

- `src/lightos_admin.rs` owns account extraction, safe request-header
  forwarding, admin URL construction, visible-instance decoding, and HTTP
  errors.
- `src/lightos.rs` owns `lightosctl` commands and target authorization.
- `src/router.rs` only wires request headers into the instance-list handler and
  merges SSH profiles.
- A focused frontend status module owns the rule deciding whether an empty
  workspace may replace the current status with `idle`; `main.ts` only calls it.

## Error Handling

- Missing account context returns `401` when cookie auth is required.
- lightos-admin resolution or upstream failure returns `502` with the upstream
  diagnostic body.
- Invalid upstream JSON returns `502` and never degrades to an empty list.
- Records without either a valid explicit selector or complete legacy fields
  are ignored, matching official selector fallback behavior.
- A real startup/connection error remains visible until another operation
  replaces it.

## Verification

- A regression test proves explicit selector records survive parsing.
- HTTP tests prove account headers and safe browser auth headers reach
  `/api/webshell/instances`.
- Tests prove missing account context is rejected and legacy records still work.
- A frontend unit test proves `idle` cannot overwrite an active error when no
  session exists.
- Existing Rust, frontend, build, Clippy, and LPK lint gates remain green.
- Real-device acceptance must verify instance list, Herdr option/workspaces, and
  native terminal creation because local tests cannot execute the user's target.

## Official Follow-up Audit

During implementation, official changes are classified into:

- required parity for this failure;
- safe reliability improvements suitable for this release;
- independent product features to report for later work.

Only the first two categories may enter this WebShell-focused release.
