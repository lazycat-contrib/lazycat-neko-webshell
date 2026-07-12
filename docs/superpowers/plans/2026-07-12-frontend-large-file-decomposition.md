# Frontend Large-File Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the largest frontend files by moving internationalization data, application overlay behavior, AI provider-profile state, and terminal clipboard behavior into focused modules without changing UI or terminal behavior.

**Architecture:** Keep `main.ts` as the composition layer. Extract locale data into typed message modules and stateful behavior into factory controllers with explicit callbacks. Plugin-specific settings remain under `plugins/ai-chat/settings/`; terminal clipboard behavior remains cross-platform and outside `mobile/`.

**Tech Stack:** TypeScript, DOM APIs, Restty, Connect RPC, Vite, Node test runner.

## Global Constraints

- Preserve all visible DOM, copy, CSS classes, keyboard shortcuts, focus behavior, and terminal protocol behavior.
- Do not add new frontend behavior to `src/frontend/src/main.ts`.
- Plugin-specific code belongs under `src/frontend/src/plugins/<pluginName>/`.
- Mobile-only code belongs under `src/frontend/src/mobile/`.
- Do not introduce a global state library or a broad catch-all module.
- Keep `MessageKey`, `resolveLanguage`, and `translate` as the public i18n API.

---

### Task 1: Split internationalization data

**Files:**
- Create: `src/frontend/src/i18n/messages-en.ts`
- Create: `src/frontend/src/i18n/messages-zh-cn.ts`
- Modify: `src/frontend/src/i18n.ts`

**Interfaces:**
- Produces: `enMessages`, `MessageKey = keyof typeof enMessages`, and `zhCNMessages satisfies Record<MessageKey, string>`.
- Preserves: `translate(locale, key, values)` and `resolveLanguage(locale)`.

- [ ] **Step 1: Extract English messages**

Move the existing `messages.en` object byte-for-byte into `messages-en.ts` and export it with `as const`.

- [ ] **Step 2: Derive the message-key type**

In `i18n.ts`, replace the handwritten union with:

```ts
import { enMessages } from "./i18n/messages-en";
export type MessageKey = keyof typeof enMessages;
```

- [ ] **Step 3: Extract and type-check Chinese messages**

Move the existing `messages["zh-CN"]` object byte-for-byte into `messages-zh-cn.ts`:

```ts
import type { MessageKey } from "../i18n";
export const zhCNMessages = { /* unchanged messages */ } satisfies Record<MessageKey, string>;
```

- [ ] **Step 4: Rebuild the facade map**

Keep the translation replacement logic unchanged and construct:

```ts
const messages = { en: enMessages, "zh-CN": zhCNMessages } satisfies Record<Language, Record<MessageKey, string>>;
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`

Expected: all frontend tests pass, TypeScript reports no missing locale keys, and Vite completes.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/i18n.ts src/frontend/src/i18n/messages-en.ts src/frontend/src/i18n/messages-zh-cn.ts
git commit -m "refactor: split frontend locale data"
```

### Task 2: Extract application overlay controller

**Files:**
- Create: `src/frontend/src/app-overlays-controller.ts`
- Modify: `src/frontend/src/main.ts`

**Interfaces:**
- Produces: `createAppOverlaysController(options)` returning `openSettings`, `closeSettings`, `toggleSettingsMenu`, `closeSettingsMenu`, `togglePluginSidebar`, `openPluginSidebar`, `closePluginSidebar`, `toggleShortcutHelp`, `closeShortcutHelp`, `openAboutDialog`, `closeAboutDialog`, `toggleFullscreen`, `closeMobileOverlaysBeforeViewportChange`, `restoreTerminalFocusAfterOverlay`, `toggleInstanceMenu`, and `closeInstanceMenu`.
- Consumes: `ShellElements`, overlay preparation helpers, focus restoration, pane-menu close, plugin load/render hooks, tab activation, and close callbacks for neighboring overlays.

- [ ] **Step 1: Create the typed controller**

Define a narrow options type using `Pick<ShellElements, ...>` for only the DOM elements the controller mutates. Preserve every existing `hidden`, class, `aria-expanded`, `aria-hidden`, `inert`, focus, and fullscreen statement.

- [ ] **Step 2: Wire the controller from `main.ts`**

Construct the controller after DOM/controller setup and destructure its methods under the existing function names so current event bindings remain unchanged.

- [ ] **Step 3: Remove the old implementations**

Delete only the moved function bodies from `main.ts`; keep `navigateLightOSHome` and runtime-specific chrome coordination in `main.ts`.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`

Expected: all commands exit 0 and overlay call sites compile unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/app-overlays-controller.ts src/frontend/src/main.ts
git commit -m "refactor: extract application overlay controller"
```

### Task 3: Move AI provider-profile state into the plugin

**Files:**
- Create: `src/frontend/src/plugins/ai-chat/settings/provider-profile-state.ts`
- Create: `src/frontend/src/plugins/ai-chat/settings/dialog-state.ts`
- Modify: `src/frontend/src/main.ts`

**Interfaces:**
- Produces: profile lookup, active-profile selection, profile creation, sanitization, synchronization, upsert, selection, removal, and provider normalization helpers that accept `Settings` explicitly.
- Produces: `AISettingsTab`, `AIConfigDialogState`, `normalizeAISettingsTab`, and `normalizeAIConfigDialogType`.

- [ ] **Step 1: Add focused state tests where decisions are pure**

Create a Node test covering provider normalization, profile sanitization, active-profile fallback, maximum-profile trimming, and dialog-type normalization.

- [ ] **Step 2: Run the focused test before implementation**

Run: `node --test --experimental-strip-types src/frontend/src/plugins/ai-chat/settings/provider-profile-state.test.mjs`

Expected: fail because the new module does not yet exist.

- [ ] **Step 3: Move pure state logic**

Move the existing logic without changing default values, profile limits, selected IDs, or mutation ordering. Functions that mutate settings must take `Settings` as their first argument.

- [ ] **Step 4: Move dialog state normalization**

Move only the types and normalizers. DOM reading and dialog rendering remain in existing settings view/reader modules.

- [ ] **Step 5: Replace main wrappers**

Use imported helpers from `main.ts`; retain only thin callbacks that trigger `saveSettings()` or `renderPluginSettings()`.

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/plugins/ai-chat/settings src/frontend/src/main.ts
git commit -m "refactor: isolate AI provider profile state"
```

### Task 4: Extract terminal clipboard controller

**Files:**
- Create: `src/frontend/src/terminal-clipboard-controller.ts`
- Modify: `src/frontend/src/main.ts`

**Interfaces:**
- Produces: `createTerminalClipboardController(options)` returning keyboard/paste handlers, `copySelection`, `pasteIntoPane`, `pasteImageFileIntoPane`, `pasteTextIntoPane`, and `scheduleCopySelection`.
- Consumes: pane lookup, active pane, settings getter, terminal-write authorization, Herdr paste callbacks, socket reconnect callbacks, focus callbacks, status translation, and upload progress.
- Does not own: pane creation, WebSocket lifecycle, pending input queues, or terminal-transfer protocol consumption.

- [ ] **Step 1: Move pure shortcut decisions**

Add tests for macOS Ctrl/Meta behavior, non-Apple Super shortcuts, Ctrl+Shift shortcuts, repeat suppression, and editable-target exclusion.

- [ ] **Step 2: Run the focused test before implementation**

Run: `node --test --experimental-strip-types src/frontend/src/terminal-clipboard-controller.test.mjs`

Expected: fail until the controller module exists.

- [ ] **Step 3: Implement the controller**

Move clipboard event routing and copy/paste/image functions verbatim. Preserve Restty-first clipboard behavior, Herdr routing, image-size errors, status messages, upload progress, and focus restoration.

- [ ] **Step 4: Wire stable wrappers**

Keep existing call sites by assigning controller methods to the current names or by thin forwarding functions. Do not create circular imports.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/terminal-clipboard-controller.ts src/frontend/src/terminal-clipboard-controller.test.mjs src/frontend/src/main.ts
git commit -m "refactor: extract terminal clipboard controller"
```

### Task 5: Final audit and release verification

**Files:**
- Modify only if audit finds a concrete extraction regression.

**Interfaces:**
- Confirms the design contract rather than adding new public interfaces.

- [ ] **Step 1: Measure frontend files**

Run:

```bash
find src/frontend/src -type f \( -name '*.ts' -o -name '*.css' \) -print0 | xargs -0 wc -l | sort -nr | head -n 20
```

Expected: `i18n.ts` is a small facade and `main.ts` is smaller with moved responsibilities absent.

- [ ] **Step 2: Check ownership rules**

Confirm AI settings files are under `plugins/ai-chat/settings/`, mobile files were not moved to the root, and no plugin-specific view was added to `plugin-views.ts`.

- [ ] **Step 3: Run complete verification**

```bash
npm test
npm run typecheck
npm run build
cargo test --all-targets
cargo fmt --check
cargo clippy --all-targets --message-format short
lzc-cli project lint
git diff --check
```

Expected: every command exits 0; existing Clippy warnings may remain but no errors are introduced.

- [ ] **Step 4: Review and commit any final mechanical cleanup**

If no cleanup is required, do not create an empty commit. Otherwise stage only the audited frontend files and use:

```bash
git commit -m "refactor: finish frontend module decomposition"
```
