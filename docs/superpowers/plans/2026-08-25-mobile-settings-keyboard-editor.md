# Mobile Settings Keyboard Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile settings self-explanatory and let users manage shortcut pages through a visual, category-based keyboard layout editor with drag-and-drop and accessible move controls.

**Architecture:** Keep settings rendering in the existing mobile settings modules. Extend the pure keyboard layout model with an index-based reorder helper, then let the focused settings controller render category tabs and a grid preview. Preserve the current persisted layout schema and keep the existing up/down controls as a non-drag alternative.

**Tech Stack:** TypeScript, semantic HTML, CSS custom properties, Node test runner, Vite.

**Spec:** User screenshots and request in the current conversation.

## Global Constraints

- Keep `src/frontend/src/main.ts` as orchestration only.
- Preserve `MobileKeyboardLayout` persistence and preset compatibility.
- Keep every draggable reorder action available through keyboard/touch move buttons.
- Keep touch targets at least 44px and visible focus states.
- Update both English and Simplified Chinese copy.
- Bump only the application version for this frontend feature.

### Task 1: Clarify mobile setting copy and keyboard width labels

**Files:**
- Modify: `src/frontend/src/mobile/settings/clock-view.ts`
- Modify: `src/frontend/src/mobile/settings/touch-view.ts`
- Modify: `src/frontend/src/mobile/settings/quick-phrase-view.ts`
- Modify: `src/frontend/src/mobile/settings/keyboard-layout-view.ts`
- Modify: `src/frontend/src/i18n/messages-en.ts`
- Modify: `src/frontend/src/i18n/messages-zh-cn.ts`

- [x] Replace unexplained checkbox wording with action-oriented labels and helper text.
- [x] Replace S/M/L-only width choices with full labels and a visible narrow/standard/wide legend.

### Task 2: Add visual category editor and drag reorder

**Files:**
- Modify: `src/frontend/src/mobile/keyboard-layout.ts`
- Modify: `src/frontend/src/mobile/keyboard-layout-settings-controller.ts`
- Modify: `src/frontend/src/mobile/settings/keyboard-layout-view.ts`
- Modify: `src/frontend/src/mobile/styles.css`
- Test: `src/frontend/src/mobile/keyboard-layout.test.mjs`

- [x] Add an immutable `moveMobileKeyboardKeyToIndex` helper.
- [x] Render category tabs and a width-aware keyboard grid.
- [x] Support HTML drag-and-drop while retaining up/down buttons.
- [x] Add tests for index-based reorder and keep existing layout normalization tests passing.

### Task 3: Verify, version, commit, and publish tag

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` if present

- [x] Run focused tests, typecheck, and production build.
- [x] Bump `0.7.25` to `0.7.26`.
- [ ] Commit the complete change with a focused message.
- [ ] Push the commit and create/push `v0.7.26`.
