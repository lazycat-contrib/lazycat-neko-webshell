# Mobile terminal productivity design

## Goal

Bring the useful, low-risk parts of Dinotty 0.23.0's mobile keyboard and workspace navigation into Neko WebShell without replacing the system IME or weakening the LightOS and Herdr boundaries.

## Approved scope

1. Let users reorder, hide, resize, and add keys on the mobile shortcut pages.
2. Provide built-in Default, Operations, and Editor presets plus one saved Custom layout.
3. Extend quick phrases with grouping, manual ordering, and an explicit send-with-Enter option.
4. Let users temporarily maximize the active pane without changing the persisted split layout.
5. Add a lightweight mobile Tab/Pane overview for both ordinary and Herdr-backed WebShell tabs.

## Product boundaries

- The operating-system keyboard remains the primary text and CJK IME surface. Do not add a full QWERTY virtual keyboard.
- Custom application actions use a closed allowlist. No custom JavaScript or unknown Herdr SockAPI method may be configured.
- Custom terminal text is capped and normalized. Sending Enter is off by default and visibly indicated.
- Repeating input is limited to the existing safe navigation/editing shortcuts.
- Pane maximization is frontend-only, ephemeral, and cleared when its pane or tab disappears.
- The overview changes existing active tab/pane state through current application actions. It owns no terminal transport or Herdr state.
- `main.ts` remains orchestration only. Mobile models, views, settings controllers, and overview behavior live under `src/frontend/src/mobile/`; pane maximization has a focused app-level controller.

## Interaction and visual direction

- **Visual thesis:** dense terminal utility, using the current semantic colors, compact typography, and flat surface hierarchy.
- **Content plan:** orient with preset/page state, show the current ordered controls, reveal advanced key fields only when adding or editing.
- **Interaction thesis:** keyboard page changes remain instant; pressables use a 160 ms scale response; the occasional overview sheet uses a 220 ms transform/opacity transition with a faster close and a reduced-motion fallback.
- Every mobile target is at least 44 by 44 CSS pixels with at least 8 pixels between adjacent editor actions.
- Reordering is available through explicit Up/Down buttons, not drag-only interaction.
- The overview is a true dialog with a labelled close control, focus entry, Escape/backdrop dismissal, focus restoration, and visible focus rings.
- English and Chinese labels must fit at 320 and 375 CSS pixel widths. All colors come from existing interface theme tokens.

## Acceptance criteria

- Existing users retain the current Default mobile shortcut layout after migration.
- Switching a preset immediately updates the shortcut bar; editing a key creates or updates Custom without mutating built-in presets.
- A malformed saved layout falls back to a valid bounded layout.
- Quick phrases preserve old saved data and add optional group/order/send-enter fields.
- Maximizing any ordinary, SSH, zellij, or Herdr pane hides only its sibling panes and restoring reconstructs the existing layout unchanged.
- The mobile overview lists current tabs and visible panes, marks the active targets, and activates the selected pane.
- System keyboard focus protection, terminal input encoding, replay input locks, and existing mobile swipe-to-tab behavior remain unchanged.
- Unit tests, TypeScript checks, frontend build, Rust tests, and release consistency checks pass before publishing.
