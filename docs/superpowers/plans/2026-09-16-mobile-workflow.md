# Mobile Workflow Implementation Plan

> **For agentic workers:** Use subagent-driven-development; execute the approved assessment without additional user checkpoints.

**Goal:** Make mobile drafting, navigation keys, reusable phrases and session selection easier without replacing familiar workflows.
**Architecture:** Focused mobile controllers with injected target/send callbacks; retain current terminal transport and keyboard gesture ownership. Parent owns shared wiring/translations and target adapter. One implementer at a time works in isolated directories while parent handles independent integration.
**Tech Stack:** TypeScript, native DOM/dialog, CSS tokens, Node tests, Vite and agent-browser.
**Spec:** docs/superpowers/specs/2026-09-16-mobile-workflow.md

## Global Constraints
- Follow AGENTS.md; main.ts wiring only; no plugins, dependencies, backend or agent changes.
- Retain toolbar icon-only controls, theme tokens, 44–48px actions, 320px layout, visualViewport and reduced motion.
- Capture target and revalidate before sends. Draft and query never persisted as history or diagnostics. Respect explicit sendEnter.
- Implementers edit only their owned folders. Parent exclusively edits main.ts, translations, keyboard core, overview, spec and plan. Stage only owned files when committing; never discard other work. No child agents.

### Task 1: Multi-line composer
**Owner:** implementer; files only src/frontend/src/mobile/composer/ (controller.ts, model.ts, view.ts, styles.css, model.test.mjs as needed).
**Consumes:** import type MobileInputTarget from ../input-target.ts, type MessageKey from ../../i18n. Target has key, label, pane, selector, sessionId, generation, optional herdrPaneId. Do not mutate it.
**Produces:** createMobileComposer(options) -> {open():void, close():void, sync():void, isOpen():boolean, ownsEvent(event:Event):boolean, dispose():void}.
```ts
type Options = {
 target: () => MobileInputTarget | undefined;
 isCurrent: (target: MobileInputTarget) => boolean;
 send: (target: MobileInputTarget, text: string, enter: boolean) => Promise<boolean>;
 prepare: () => void;
 tr: (key: MessageKey, values?: Record<string,string|number>) => string;
};
```
- [x] Implement memory-only drafts keyed by target.key, 64 KiB UTF-8 limit, preserved whitespace and newlines, clear on success only. Draft survives close, cleared by explicit discard. Avoid unbounded orphan drafts; bound total draft size or number and do not silently evict text in an active session.
- [x] Native dialog/bottom sheet with title, target label, labeled textarea and Insert / Send+Enter / Discard actions. Autofocus textarea synchronously from user open gesture, preserve native IME. No Enter shortcut that submits while composing. Busy prevents duplicate sends; failure is inline and retains text.
- [x] Close when target becomes stale via sync(), retaining original draft. Old responses cannot close/change a newly opened target's view. Exact send callback is provided by parent; never append raw Enter internally.
- [x] Use keys mobileComposer.title, .input, .hint, .insert, .send, .discard, .empty, .tooLarge, .unavailable, .failed, .sending, .close. Parent adds messages, so report desired wording. Use local view/status DOM nodes, no unsafe HTML. Import owned stylesheet from controller/view. Mobile viewport and focus handling, 200/150ms token transitions, reduced motion; no separate animation library.
- [x] Meaningful unit tests for draft isolation, size limit, preservation/failure/success and stale pending completion; test pure model as necessary. Run focused tests; commit owned files only and report commit, checks and requested translations.

### Task 2: Searchable phrase and key palette
**Owner:** fresh implementer; files only src/frontend/src/mobile/command-palette/.
**Consumes:** same target contract and shared keys from ../keyboard-layout-types; MobileQuickPhrase from ../../types.
**Produces:** createMobileCommandPalette(options) -> {open():void,close():void,sync():void,isOpen():boolean,ownsEvent(event:Event):boolean,dispose():void}.
```ts
type Options = {
 target: () => MobileInputTarget | undefined;
 isCurrent: (target: MobileInputTarget) => boolean;
 phrases: () => MobileQuickPhrase[];
 keys: () => MobileKeyboardKey[];
 sendPhrase: (target: MobileInputTarget, phraseId: string) => Promise<boolean>;
 sendKey: (target: MobileInputTarget, key: MobileKeyboardKey) => Promise<boolean>;
 prepare: () => void;
 tr: (key: MessageKey, values?: Record<string,string|number>) => string;
};
```
- [x] Recent/All/Keys tabs, case-insensitive search of phrase label/text/group and key label/value; recent sorts lastUsedAt >0, all respects current group/order. Query is not persisted. No built-in agent commands or fake recents. Stable choice identity and exact target checked on activation.
- [x] Native dialog/bottom sheet, explicit search label and clear control, empty states, full multiline phrase preview, Enter indicator only when sendEnter true. Don't autofocus search/open system keyboard on open. Close/sync safe and double activation locked. Inline failure, modal stays when send failed. Revalidate phrase/key against current configuration (removed or changed while open must not run stale payload).
- [x] Keys list only safe terminal shortcut/chord items and explicit user-defined text keys, never destructive workspace actions. Parent callback decides transport/modifiers. Preserve custom key identity and autoEnter indicator.
- [x] i18n keys prefix mobilePalette (title,search,clear,recent,all,keys,empty,noRecent,noMatches,enter,insert,sending,failed,unavailable,close). Parent owns messages. Local CSS tokens and accessibility. Reuse infrastructure only via narrow imports.
- [x] Unit tests search/order/recency/XSS rendering/changed choices and target validity as appropriate; run focused tests, commit owned files only and report.

### Task 3: Parent integration, navigation panel and overview
**Owner:** parent. Files input-target.ts + tests; mobile/navigation-pad.ts/css; keyboard-view/controller/layout-view/action-event-phase and targeted tests; existing workspace-overview modules; i18n; main.ts call-throughs.
- [x] Snapshot actual focused Herdr pane and validate generation, session, pane identity. Explicit scoped Herdr send verifies remote current pane before sending to captured id. Plain PTY uses existing paste + separate Enter; check writable/replay/socket states.
- [x] New draft icon in scrollable toolbar; existing phrase icon becomes palette entry even if phrases empty. Overview accessible from operations page for all presets without clobbering custom layouts. Keep secret and keyboard fixed controls.
- [x] Existing nav page opens nonmodal grid above toolbar for built-in presets; custom nav page stays as configured. Retain all original navigation keys, hold repeat and modifiers. Remove main-left/down/up/right from built-in defaults; do not copy Tab/Enter/Ctrl/Esc into navigation. Opening remembers prior page; second tap/outside/Escape close, cancel held gestures, no keyboard pop or simultaneous rail. Latest user guidance requires exactly one default arrow set, in navigation.
- [x] Overview adds status and count, checkmark, stable ordering; closes only on valid current item activation. Improve readable flat hierarchy and opaque sheet using scoped CSS.
- [x] Coordinate overlay exclusivity and global keyboard/paste capture so composer and palette input never reaches terminal. Close input surfaces on target changes, preserve memory draft. Register sync at existing updateActiveDetails and dispose on lifecycle teardown.

### Task 4: Verification and patch release
**Owner:** parent with independent review.
- [ ] npm test, npm run build. New browser fixture imports production controls and real pointer events: draft editing/IME/newlines/no unintended Enter/failure/target switch, palette empty/search/recents/marked Enter and dynamic changes, directional press/repeat/move/cancel and keyboard retention, custom layout and overview selection.
- [ ] Screenshots at 390x844 and 320px plus short viewport; inspect real UI and no unintended desktop affordances; run existing mobile keyboard/layout regressions.
- [ ] Review task modules then full diff; fix concrete issues and recheck affected paths.
- [ ] Update README and patch version fields; full release script, npm audit and LPK package metadata/payload verification. Agent version unchanged for frontend-only work.
- [ ] Commit release, merge isolated feature branch fast-forward into clean main (verify remote unchanged), atomic push main/tag, confirm remote refs and workflow status.
