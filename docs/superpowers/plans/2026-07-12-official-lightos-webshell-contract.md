# Official LightOS WebShell Contract Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rust WebShell instance discovery and selector handling match the official Go provider so native and Herdr targets remain visible and creatable on current LightOS.

**Architecture:** Add a focused account-aware lightos-admin client for browser-visible instances, keep `lightosctl ps` for target execution authorization, and prevent the empty frontend state from erasing useful failures. Port only the official local-target contract and preserve all `v0.5.20` frontend behavior.

**Tech Stack:** Rust 2024, Axum, Reqwest, Tokio, Serde, TypeScript, Node test runner, LazyCat LPK v2.

## Global Constraints

- Restrict changes to WebShell discovery, selector, creation diagnostics, tests, and release metadata.
- Do not add plugin, mobile, Herdr rendering, or pure helper logic to `src/frontend/src/main.ts`.
- Do not implement official remote PC client targets in this release.
- Keep `/lzcinit/lightosctl ps` as the authorization and login-user source for local targets.
- Preserve all `v0.5.20` web/mobile/function-option fixes.

---

### Task 1: Accept official selector-shaped LightOS records

**Files:**
- Modify: `src/lightos.rs`
- Test: `src/lightos.rs`

**Interfaces:**
- Produces: `selector_for_instance(&LightOsInstance) -> Option<String>` that prefers a valid non-empty `selector`, then falls back to `name@owner_deploy_id`.

- [ ] Add a failing parser test with `{"selector":"alpha@deploy-a","status":"running","username":"alice"}` and assert the selector is preserved.
- [ ] Run `cargo test lightos::tests::parses_explicit_lightos_selector -- --exact` and confirm RED.
- [ ] Add the optional selector field and fallback logic.
- [ ] Run the focused test and existing `lightos::tests` to confirm GREEN.

### Task 2: Load browser-visible instances through lightos-admin

**Files:**
- Create: `src/lightos_admin.rs`
- Modify: `src/main.rs`
- Modify: `src/router.rs`
- Modify: `scripts/build-release.sh`
- Test: `src/lightos_admin.rs`

**Interfaces:**
- Consumes: `HeaderMap`, `lightos::admin_info()`, `reqwest::Client`.
- Produces: `list_visible_instances(headers: &HeaderMap) -> Result<Vec<Instance>, LightOsAdminError>`.

- [ ] Add failing tests for account extraction, URL path joining, explicit/legacy selector conversion, and forwarded auth headers.
- [ ] Run `cargo test lightos_admin::tests -- --nocapture` and confirm RED/compile failure.
- [ ] Implement official env/config precedence, safe header copying, `/api/webshell/instances` request, decoding, and dedupe.
- [ ] Wire `/api/instances` to the new function while retaining SSH-profile merge behavior.
- [ ] Make the release build write `.env` with `LIGHTOS_REQUIRE_COOKIE_AUTH` and optional `LIGHTOS_ADMIN_INTERNAL_BASE_URL`.
- [ ] Run focused Rust tests and confirm GREEN.

### Task 3: Preserve actionable empty-workspace errors

**Files:**
- Create: `src/frontend/src/empty-workspace-status.ts`
- Create: `src/frontend/src/empty-workspace-status.test.mjs`
- Modify: `src/frontend/src/main.ts`

**Interfaces:**
- Produces: a pure decision helper that returns `idle` only when the current status is not an error.

- [ ] Add a failing frontend test proving an error status is preserved with no active pane.
- [ ] Run `node --test --experimental-strip-types src/frontend/src/empty-workspace-status.test.mjs` and confirm RED.
- [ ] Implement the helper and replace only the orchestration branch in `updateActiveDetails()`.
- [ ] Run the focused frontend test and confirm GREEN.

### Task 4: Verify, audit official parity, and release

**Files:**
- Modify version fields only after all tests pass.
- Update official parity docs if implementation details differ.

- [ ] Compare official Go reliability changes affecting instance selection, agent startup, session restore, and diagnostics; classify each as included, recommended later, or irrelevant.
- [ ] Run `cargo fmt --check`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, `npm test`, `npm run build`, `git diff --check`, and LazyCat lint/release checks.
- [ ] Inspect the generated LPK/content for `.env`, provider binary, version consistency, and WebShell resource export.
- [ ] Bump the patch version consistently, commit only intended files, push `main`, create an annotated tag, and push it.
- [ ] Verify CI/release/store state, then require device acceptance for native and Herdr creation before claiming runtime resolution.
