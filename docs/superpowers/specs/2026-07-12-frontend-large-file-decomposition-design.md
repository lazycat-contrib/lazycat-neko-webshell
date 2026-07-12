# Frontend Large-File Decomposition Design

## Context

The frontend has accumulated several files that are difficult to review safely:

- `src/frontend/src/main.ts`: 6,671 lines
- `src/frontend/src/styles.css`: 3,510 lines
- `src/frontend/src/plugin-tools.css`: 2,880 lines
- `src/frontend/src/i18n.ts`: 2,335 lines

`main.ts` currently owns startup, state, settings binding, overlays, plugin configuration, Herdr coordination, workspace restore, pane transport, tab lifecycle, clipboard handling, and terminal input. This conflicts with the repository rule that `main.ts` remain an application composition layer.

## Goals

- Reduce `main.ts` by moving cohesive behavior into focused modules.
- Preserve all existing UI, keyboard, mobile, WebShell, Herdr, SSH, plugin, and cross-device behavior.
- Keep plugin-specific code under `plugins/<plugin-id>/` and mobile-only behavior under `mobile/`.
- Keep module interfaces typed and narrow enough to test independently.
- Preserve import order and selector precedence where CSS is eventually split.
- Keep the current public i18n API: `MessageKey`, `resolveLanguage`, and `translate`.

## Non-Goals

- No visual redesign, new animation, copy change, or interaction change.
- No framework migration and no new global state library.
- No backend or protobuf changes.
- No speculative component hierarchy.
- No CSS split in the first implementation phase unless an extracted component has an unambiguous owned stylesheet.

## Considered Approaches

### 1. Mechanical split by line ranges

Move contiguous blocks into files without changing ownership boundaries. This is fast but produces new catch-all files and large dependency bags. It makes navigation look better while retaining the same coupling.

### 2. Responsibility-owned controllers and data modules

Extract stateful behavior behind small factory interfaces and move pure data into domain files. `main.ts` keeps object construction, startup order, and cross-module coordination. This is the selected approach because it reduces risk while enforcing the existing `AGENTS.md` boundaries.

### 3. Full frontend state-store rewrite

Introduce a global store and rebuild the application around actions/selectors. This could eventually simplify composition, but it changes too many lifecycle and terminal timing assumptions at once. It is not appropriate for a behavior-preserving refactor.

## Architecture

### Composition layer

`main.ts` will retain:

- application startup ordering;
- top-level service/client construction;
- controller construction and dependency wiring;
- the minimum shared state needed to coordinate independent domains;
- top-level browser lifecycle bindings.

It will not retain pure formatting helpers, domain-specific dialog state, clipboard protocol rules, or backend-specific action implementations when those can live in an owning module.

### Internationalization

`i18n.ts` becomes the stable facade. English messages define `MessageKey`; Chinese messages must satisfy the same record type at compile time. Locale data moves into `i18n/messages-en.ts` and `i18n/messages-zh-cn.ts`.

### Overlay and dialog chrome

General application overlays move to `app-overlays-controller.ts`. It owns open/close/toggle behavior for settings, plugin sidebar, shortcut help, about, instance menu, fullscreen coordination, focus restoration, and inert background state. It receives only DOM elements and callback hooks needed for current rendering.

### Terminal clipboard and input

Clipboard keyboard routing, copy/paste, image staging, IME guards, and pending input behavior move to `terminal-input-controller.ts`. The controller consumes the active pane lookup and transport callbacks; it does not own pane lifecycle or backend creation.

### AI settings

AI provider/profile dialog state and CRUD move under `plugins/ai-chat/settings/`. The plugin directory owns its settings state, dialog readers, presenter synchronization, and profile limits. `main.ts` only wires save/render callbacks.

### Herdr and pane lifecycle

Herdr event bridge/action coordination and generic pane transport are later tasks in the same refactor series. They must be extracted separately because replay ownership, reconnect timing, history cursors, and shared-terminal control have distinct invariants.

## Data Flow

Controllers receive getter callbacks for mutable application state and explicit callbacks for mutations. They do not import `main.ts`, reach into global DOM by default, or create circular dependencies. State changes continue to flow through the existing settings/workspace APIs.

## UI and UX Constraints

Following the project design rules and `emil-design-eng`:

- DOM structure and visible copy remain unchanged.
- No new animation is introduced during refactoring.
- Existing focus restoration, inert background behavior, touch keyboard handling, and reduced-motion behavior remain intact.
- Frequently used keyboard interactions remain immediate.
- Accessible button semantics and current ARIA attributes are preserved.

## Error Handling

- Existing user-visible status messages remain unchanged.
- Extracted controllers report failures through injected status callbacks.
- Async operations preserve existing cancellation, generation, and stale-result guards.
- A controller must not swallow errors that currently reach the global or plugin status surface.

## Testing and Verification

- Keep all existing frontend tests passing.
- Add focused unit tests when pure decision logic is extracted.
- Run `npm test`, `npm run typecheck`, and `npm run build` after each extraction group.
- Run Rust tests and release lint before final delivery because frontend assets are embedded in the provider.
- Confirm `main.ts` imports and calls extracted modules without reintroducing domain logic.
- Confirm no visual CSS or translated message values changed.

## Success Criteria

- `i18n.ts` is a small facade instead of a combined key/type/data file.
- `main.ts` loses at least two substantial responsibilities in the first implementation pass.
- No new broad catch-all module is introduced.
- Extracted modules have explicit typed dependencies.
- All test, typecheck, build, format, lint, and release-package checks pass.
