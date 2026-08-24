# Mobile terminal productivity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, configurable mobile shortcut layouts, richer quick phrases, pane maximization, and a mobile workspace overview.

**Architecture:** Mobile layout data is normalized and rendered by focused modules under `src/frontend/src/mobile/`. A small controller owns ephemeral pane maximization, and `main.ts` only supplies application callbacks and refresh hooks. Existing terminal byte encoding and backend actions remain the sole execution paths.

**Tech Stack:** TypeScript, native DOM, CSS, Node test runner, Vite, Rust/Axum packaging.

**Spec:** `docs/superpowers/specs/2026-08-25-mobile-terminal-productivity-design.md`

## Global constraints

- Keep the system IME as the primary text keyboard.
- Keep custom application actions allowlisted and Herdr compatibility directional.
- Keep `src/frontend/src/main.ts` to orchestration.
- Keep mobile-only code and CSS under `src/frontend/src/mobile/`.
- Use existing CSS/theme tokens and Lucide icons; add no dependency.
- Animate no high-frequency keyboard or tab action.
- Ship 44px touch targets, focus-visible states, theme parity, and reduced-motion behavior.

---

### Task 1: Mobile keyboard model and presets

**Files:**
- Create: `src/frontend/src/mobile/keyboard-layout.ts`
- Test: `src/frontend/src/mobile/keyboard-layout.test.mjs`
- Modify: `src/frontend/src/types.ts`
- Modify: `src/frontend/src/config.ts`
- Modify: `src/frontend/src/migrate/settings.ts`

**Interfaces:**
- Produces `normalizeMobileKeyboardLayout`, `mobileKeyboardPresetLayout`, `resolveMobileKeyboardLayout`, and bounded key/page types.
- Consumes existing shortcut, chord, and app-action identifiers only.

- [ ] Write tests that require invalid keys/actions to be dropped, stable IDs, bounded labels/text, safe repeat behavior, and three immutable presets.
- [ ] Run the new test and confirm it fails before the module exists.
- [ ] Implement the typed model, preset factories, normalization, and settings migration.
- [ ] Run the model test and settings migration tests.

### Task 2: Configurable keyboard rendering and editor

**Files:**
- Modify: `src/frontend/src/mobile/keyboard-view.ts`
- Modify: `src/frontend/src/mobile/keyboard-controller.ts`
- Create: `src/frontend/src/mobile/settings/keyboard-layout-view.ts`
- Create: `src/frontend/src/mobile/keyboard-layout-settings-controller.ts`
- Modify: `src/frontend/src/mobile/settings-view.ts`
- Modify: `src/frontend/src/shell.ts`
- Test: `src/frontend/src/mobile/keyboard-view.test.mjs`
- Test: `src/frontend/src/mobile/keyboard-layout-settings-controller.test.mjs`

**Interfaces:**
- The keyboard renderer consumes a normalized layout and produces the existing `data-mobile-shortcut`, `data-mobile-chord`, and `data-mobile-action` contracts plus bounded `data-mobile-text` input.
- The settings controller emits a preset ID and Custom layout through callbacks owned by `main.ts`.

- [ ] Write failing render/controller tests for preset selection, reorder, visibility, width, and custom key validation.
- [ ] Implement data-driven page rendering while preserving the dynamic Symbols and Phrases pages.
- [ ] Implement the progressively disclosed editor with native buttons/selects and inline errors.
- [ ] Wire settings and render refreshes from `main.ts` using call-throughs only.
- [ ] Run focused keyboard tests and typecheck.

### Task 3: Grouped, manually ordered quick phrases

**Files:**
- Modify: `src/frontend/src/types.ts`
- Modify: `src/frontend/src/mobile/quick-input.ts`
- Modify: `src/frontend/src/mobile/quick-phrase-editor.ts`
- Modify: `src/frontend/src/mobile/quick-phrase-settings-controller.ts`
- Modify: `src/frontend/src/mobile/settings/quick-phrase-view.ts`
- Modify: `src/frontend/src/shell.ts`
- Test: `src/frontend/src/mobile/quick-input.test.mjs`
- Test: `src/frontend/src/mobile/quick-phrase-editor.test.mjs`

**Interfaces:**
- Extends `MobileQuickPhrase` with normalized `group`, `order`, and `sendEnter` fields.
- The run callback sends the phrase text and a trailing carriage return only when `sendEnter` is true.

- [ ] Write failing migration, ordering, movement, group, and Enter behavior tests.
- [ ] Extend the model and editor while preserving legacy phrase data.
- [ ] Add Up/Down controls and visible group/Enter metadata to the list.
- [ ] Wire movement and execution through existing save/input callbacks.
- [ ] Run focused phrase tests and typecheck.

### Task 4: Ephemeral pane maximization

**Files:**
- Create: `src/frontend/src/pane-maximize-controller.ts`
- Test: `src/frontend/src/pane-maximize-controller.test.mjs`
- Modify: `src/frontend/src/pane-menu-actions.ts`
- Modify: `src/frontend/src/mobile/keyboard-layout.ts`
- Modify: `src/frontend/src/main.ts`
- Modify: `src/frontend/src/styles.css`

**Interfaces:**
- Produces `toggle`, `clear`, `sync`, and `isMaximized` operations over a tab mount and pane mount.
- Uses CSS classes only and never mutates `SplitNode`.

- [ ] Write a failing controller test proving sibling panes hide, restore preserves DOM, and stale targets clear.
- [ ] Implement the controller and styles.
- [ ] Add the allowlisted action to the pane menu and mobile Operations preset.
- [ ] Wire active-pane changes and pane disposal to controller synchronization.
- [ ] Run controller/menu tests and typecheck.

### Task 5: Mobile Tab/Pane overview

**Files:**
- Create: `src/frontend/src/mobile/workspace-overview-view.ts`
- Create: `src/frontend/src/mobile/workspace-overview-controller.ts`
- Create: `src/frontend/src/mobile/workspace-overview-view.test.mjs`
- Modify: `src/frontend/src/mobile/keyboard-view.ts`
- Modify: `src/frontend/src/main.ts`
- Modify: `src/frontend/src/mobile/styles.css`

**Interfaces:**
- The view consumes presentation-only tab/pane items.
- The controller exposes `open`, `close`, `render`, and `isOpen`, and calls the existing tab/pane activation callbacks.

- [ ] Write failing view tests for active state, labels, escaped content, and empty state.
- [ ] Implement the dialog shell, presentation renderer, focus lifecycle, backdrop/Escape dismissal, and activation callbacks.
- [ ] Add the overview action to the Operations preset and wire current tab/pane presentation from `main.ts`.
- [ ] Add safe-area layout, 44px targets, focus-visible styles, and 220ms enter/150ms exit motion with reduced-motion handling.
- [ ] Run overview tests and typecheck.

### Task 6: Localization, visual verification, and release

**Files:**
- Modify: `src/frontend/src/i18n/messages-en.ts`
- Modify: `src/frontend/src/i18n/messages-zh-cn.ts`
- Modify: `src/frontend/src/mobile/styles.css`
- Modify: release version files selected by the repository's existing release workflow.

**Interfaces:**
- Keeps message-key parity between English and Chinese.
- Keeps package, Cargo, manifest, and tag versions synchronized.

- [ ] Add concise English and Chinese labels, help, validation, and status copy.
- [ ] Run all Node tests, `npm run typecheck`, `npm run build`, and Rust tests.
- [ ] Render the UI in a browser and inspect 320px, 375px, and desktop widths in light and dark themes.
- [ ] Review the complete diff, fix all findings, and rerun verification.
- [ ] Bump the patch version, verify version consistency, commit, push `main`, create and push the new tag, then verify remote refs and CI/release status.
