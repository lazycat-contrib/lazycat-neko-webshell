# Session Manager And Mobile Keyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved session manager refactor, unified launch behavior, and Termux-style mobile keyboard without breaking existing terminal protocols.

**Architecture:** Add a backend session manager as the lifecycle owner while keeping workspace topology and WebSocket contracts stable. Add frontend-only launch/mobile changes through the existing `/api/workspace` and Restty input paths. Image paste upload is explicitly deferred.

**Tech Stack:** Rust 2024, Axum 0.8, Tokio, portable-pty, Vite, TypeScript, Restty.

---

### Task 1: Backend Session Lifecycle Owner

**Files:**
- Create: `src/session_manager.rs`
- Modify: `src/main.rs`
- Modify: `src/state.rs`
- Modify: `src/terminal.rs`
- Modify: `src/service.rs`
- Modify: `src/workspace.rs`

- [x] Add `SessionManager` around session records, terminal registry, output buffers, stores, and output history.
- [x] Move status, restart policy, output limit, resize persistence, terminal open, terminal close, and output cleanup into `SessionManager` methods.
- [x] Keep workspace topology APIs stable, but create new workspace sessions as `starting` until the PTY is open.
- [x] Update WebSocket attach and Connect create/close paths to use `SessionManager`.
- [x] Add tests for starting-before-open, running-after-open, resize persistence, and close cleanup.

### Task 2: Unified Launch Selector

**Files:**
- Modify: `src/frontend/src/main.ts`
- Modify: `README.md`

- [x] Add last-selector storage keyed separately from last-tab storage.
- [x] Resolve launch selector as explicit `?name=`, then remembered running selector, then first running instance.
- [x] Keep writing resolved selectors back to `?name=`.
- [x] Show a status message when an explicit stale selector falls back to another running instance.
- [x] Update README launcher behavior.

### Task 3: Mobile Termux-Style Extra Keys

**Files:**
- Modify: `src/frontend/src/shell.ts`
- Modify: `src/frontend/src/main.ts`
- Modify: `src/frontend/src/keyboard.ts`
- Modify: `src/frontend/src/styles.css`
- Modify: `src/frontend/src/i18n.ts`

- [x] Replace the single mobile shortcut row with a multi-row/page extra-key pad.
- [x] Add missing key IDs to `keyboard.ts`.
- [x] Use pointer events with `preventDefault()` for all extra keys.
- [x] Gate visibility with coarse pointer/touch capability.
- [x] Preserve sticky modifier and repeat behavior.

### Task 4: Verification

**Files:**
- No source ownership; verification only.

- [x] Run `npm run build`.
- [x] Run `cargo test`.
- [x] Run `cargo clippy --all-targets --all-features -- -D warnings`.
- [x] Run `lzc-cli project release`.
- [x] Review `git diff` for protocol compatibility and unrelated churn.
