# ADR-001: Runtime Backends And Built-In Tools

## Status
Accepted

## Date
2026-06-26

## Context
Neko Webshell started as a LazyCat / LightOS WebShell provider. The product now needs to also run as a generic browser WebShell and support SSH targets without assuming LightOS APIs are present.

The existing codebase also uses `PluginDescriptor` and `plugins/` module names for built-in panels such as file transfer, AI Chat, terminal transfer, port forwarding, tunnels, and Pomodoro. Those names are internal implementation history. The product direction does not include third-party plugin distribution, installable plugin packages, a marketplace, or hot-loaded external tool execution.

## Decision
Model the product as:

- `Runtime`: environment-level availability, currently `lightos` or `generic`.
- `Backend`: terminal/session transport target, currently native WebShell, SSH, Herdr, and zellij.
- `Capability`: what a tool can do against a runtime or backend, such as shell execution, terminal stream transfer, file transfer, AI context, LightOS administration, or port forwarding.
- Built-in tools: first-party WebShell features surfaced in the tool panel. They can keep internal `PluginDescriptor` names for protocol compatibility, but user-facing language should call them tools.

`NEKO_WEBSHELL_TTY_INIT=generic` disables LightOS terminal initialization and hides LightOS-only UI and APIs. SSH profiles are first-class terminal targets and are not LightOS instances.

## Alternatives Considered

### Build A Plugin Distribution Platform
- Pros: could eventually allow third-party extensions.
- Cons: requires package distribution, permission boundaries, version compatibility, security review, upgrade semantics, and a separate developer contract.
- Rejected: this is not the product requirement. It would delay generic WebShell and SSH backend work while solving a different problem.

### Keep LightOS As The Implicit Core
- Pros: smaller immediate diff.
- Cons: generic deployments would keep seeing LightOS-only menus and error paths; SSH would become a special case inside LightOS assumptions.
- Rejected: generic WebShell and SSH targets need a clean boundary.

### Rename All Internal Plugin Code To Tools Now
- Pros: perfect naming consistency.
- Cons: churns generated proto usage, persisted settings, frontend controllers, CSS, and tests without changing product behavior.
- Deferred: user-facing language should say tools now. Internal names can migrate later only when there is a concrete maintenance gain.

## Consequences
- Runtime checks gate LightOS-only UI and APIs.
- Backend selection and session metadata must treat SSH as a first-class backend.
- Built-in tools should declare runtime/backend capability metadata where behavior depends on the target.
- Documentation must describe built-in tools, not plugin distribution.
- Existing `PluginDescriptor` APIs remain a compatibility layer for current frontend/backend control flow.
