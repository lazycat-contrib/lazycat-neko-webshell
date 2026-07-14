# Contextual Local and Remote Tab Labels Design

## Status

Approved. The user accepted this interaction on 2026-07-14 after reporting
that remote device names were not visible in the tab strip.

## Goal

Make the active terminal's location immediately understandable without letting
long local or remote names consume the whole tab bar.

## Current problem

Every remote tab currently sets `iconOnly: true`, including the active tab.
The device name and terminal detail exist only in `title` and `aria-label`, so
the visible tab is always one device icon. On mobile the icon-only tab is also
fixed at 70px, while local active labels are capped too narrowly to show both
the instance and terminal names.

The tab width currently transitions when tabs become active. Tab switching is
a frequent navigation action, so animating width makes the strip feel delayed
and causes adjacent tabs to move unnecessarily.

## Selected interaction

- An inactive remote tab remains a single remote-device icon.
- An active remote tab shows `remote icon + device name · terminal name`.
- An active local tab shows `instance name · terminal name`.
- An inactive local tab keeps its existing terminal label so multiple local
  tabs remain compact.
- Tooltip and accessible text always use the contextual `source · detail`
  label. When the contextual label is visible on the active tab, that exact
  string is also the visible text.
- Duplicate or missing parts collapse cleanly: if source and detail are equal,
  render the value once; if one part is empty, render the other part.
- Renaming edits only the terminal name; the contextual source prefix is never
  copied into the rename input or persisted as part of the custom name.

Examples:

- Local active: `Neko Webshell · Herdr`
- Remote active: `MacBook Pro · Herdr`, preceded by the remote-device icon
- Remote inactive: remote-device icon only, with `MacBook Pro · Herdr` in the
  tooltip and accessible label

## Layout and motion

- The horizontal tab list remains scrollable.
- A contextual active tab may grow to 60vw, with a desktop cap of 520px and a
  mobile cap of 320px.
- Text truncates with an ellipsis only after reserving space for the remote
  icon, status indicator, and close button.
- Inactive remote tabs retain their compact fixed width; mobile reduces the
  previous oversized 70px remote tab to 52px.
- Remove the `max-width` transition. Keep only short color, background, and
  focus feedback because those do not move neighboring tabs.
- Vertical tabs keep their existing rail width and truncate contextual labels
  within that rail.

## Code boundaries

- Contextual label composition and active/inactive label presentation belong
  in `src/frontend/src/tab-labels.ts`.
- Icon-plus-text rendering belongs in
  `src/frontend/src/navigation-views.ts`.
- Desktop layout changes belong in `src/frontend/src/styles.css`.
- Mobile-only sizing changes belong in
  `src/frontend/src/mobile/styles.css`.
- `src/frontend/src/main.ts` supplies active state, instance/device name, and
  the existing terminal detail; it does not own formatting rules.

## Accessibility

- The tab's `title` and `aria-label` use the same contextual label.
- The remote icon remains decorative with `aria-hidden="true"` because the
  accessible label already describes the device.
- Visible text remains a real text node and uses ellipsis rather than a
  marquee or animation.

## Non-goals

- Do not change terminal lifecycle, selector reconciliation, remote transport,
  remote Herdr launch behavior, pinning rules, or tab ordering.
- Do not add a second row, marquee, tooltip library, or JavaScript width
  measurement.
- Do not bump the application version, create a tag, or publish a release as
  part of this visual fix.
