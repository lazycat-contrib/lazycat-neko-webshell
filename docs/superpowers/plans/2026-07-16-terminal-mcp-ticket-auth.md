# Terminal MCP Ticket Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require LazyCat's internal user ticket for Terminal MCP tool calls and prevent delegated callers from reaching browser-only approval actions.

**Architecture:** Keep the opaque ticket at the HTTP trust boundary. `McpPrincipal` validates that `X-HC-USER-TICKET`, `X-HC-USER-ID`, and `X-HC-SOURCE` are present and bounded, but stores only the non-secret user and caller fields. Browser approval routing rejects requests carrying either delegated marker.

**Tech Stack:** Rust, `http::request::Parts`, Axum/RMCP Streamable HTTP, existing Rust unit and integration tests.

## Global Constraints

- LazyCat consumers access `http://app.community.lazycat.webshell.neko.lzcx/mcp` with a real `X-HC-USER-TICKET`.
- Never parse, persist, log, return, or place the ticket in `McpPrincipal`.
- Do not add an external Bearer-token authentication path in this release.
- Preserve the current plugin enable switch, policies, grants, sequence/replay protocol, and focused module boundaries.

---

### Task 1: Require the internal ticket at principal extraction

**Files:**
- Modify: `src/plugins/terminal_mcp/principal.rs`
- Test: `src/plugins/terminal_mcp/principal.rs`

**Interfaces:**
- Consumes: `McpPrincipal::from_parts(parts: &http::request::Parts)`.
- Produces: the same `McpPrincipal` shape, with ticket validation performed before projected identity fields are accepted.

- [ ] **Step 1: Write failing principal tests**

Add a valid `x-hc-user-ticket` to the successful extraction request. Add cases proving that projected identity without a ticket and a ticket larger than 8192 bytes both return `UNAUTHENTICATED_CALLER`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cargo test plugins::terminal_mcp::principal::tests -- --nocapture`

Expected: the new missing-ticket assertion fails because `McpPrincipal::from_parts` currently accepts user/source headers alone.

- [ ] **Step 3: Implement opaque ticket validation**

Add `MAX_TICKET_BYTES: usize = 8192` and validate `x-hc-user-ticket` with a helper that only checks UTF-8, trimming, non-empty content, and the byte limit. Do not return or store the value.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cargo test plugins::terminal_mcp::principal::tests -- --nocapture`

Expected: all principal tests pass.

### Task 2: Protect integration and approval boundaries

**Files:**
- Modify: `src/plugins/terminal_mcp/server.rs`
- Modify: `src/plugins/terminal_mcp/http.rs`
- Test: `src/plugins/terminal_mcp/server.rs`
- Test: `src/plugins/terminal_mcp/http.rs`

**Interfaces:**
- Consumes: MCP requests carrying LazyCat projected headers and browser approval requests.
- Produces: valid ticket-backed MCP calls and a browser-only `is_terminal_ui_request(&HeaderMap) -> bool` boundary.

- [ ] **Step 1: Write failing boundary tests**

Update the MCP test helper so valid delegated calls include `x-hc-user-ticket`. Add an integration request with user/source headers but no ticket and assert `UNAUTHENTICATED_CALLER`. Add an HTTP test showing that a ticket-bearing request without `x-hc-source` is not a terminal UI request.

- [ ] **Step 2: Run focused tests and verify the new approval test fails**

Run: `cargo test plugins::terminal_mcp::server::tests plugins::terminal_mcp::http::tests -- --nocapture`

Expected: the ticket-only approval-boundary test fails because the current helper checks only `x-hc-source`.

- [ ] **Step 3: Implement the delegated-request guard**

Change `is_terminal_ui_request` to return false when either `x-hc-user-ticket` or `x-hc-source` is present. Keep direct browser requests without delegated markers allowed.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `cargo test plugins::terminal_mcp -- --nocapture`

Expected: all Terminal MCP tests pass.

### Task 3: Verify and commit the security correction

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-terminal-mcp-plugin-design.md`
- Add: `docs/superpowers/plans/2026-07-16-terminal-mcp-ticket-auth.md`

**Interfaces:**
- Consumes: the completed ticket-authentication implementation.
- Produces: committed source, tests, and design documentation ready for release assessment.

- [ ] **Step 1: Run repository verification**

Run: `cargo fmt --check && cargo test && cargo clippy --all-targets`

Expected: formatting, all Rust tests, and the repository's normal Clippy profile pass.

- [ ] **Step 2: Re-read the diff and secret surface**

Run: `git diff --check && git diff -- src/plugins/terminal_mcp docs/superpowers/specs docs/superpowers/plans && rg -n -i 'x-hc-user-ticket|ticket' src/plugins/terminal_mcp docs/superpowers/specs/2026-07-16-terminal-mcp-plugin-design.md`

Expected: the ticket appears only as a header name, validation requirement, or test placeholder; no real ticket value is committed or logged.

- [ ] **Step 3: Commit the correction**

Run: `git add src/plugins/terminal_mcp/principal.rs src/plugins/terminal_mcp/server.rs src/plugins/terminal_mcp/http.rs docs/superpowers/specs/2026-07-16-terminal-mcp-plugin-design.md docs/superpowers/plans/2026-07-16-terminal-mcp-ticket-auth.md && git commit -m "fix: require LazyCat ticket for terminal MCP"`

Expected: one focused commit containing only ticket-authentication code, tests, and documentation.
