# Agent Rules

## Keep `main.ts` Thin

Do not put new frontend code into `src/frontend/src/main.ts` by default.

`main.ts` should stay as the application composition layer: startup flow, top-level event binding, and coordination between focused modules. Before adding logic there, first look for an existing module that owns the behavior, or create a small focused module under `src/frontend/src/`.

Prefer these boundaries:

- Tab labels, tab rendering data, and tab ordering helpers belong in tab/navigation modules, not `main.ts`.
- Pane lifecycle, terminal transport reuse, reconnect rules, and backend-specific pane selection should live in focused pane/session modules.
- Herdr-specific behavior should stay in Herdr modules unless the code is only wiring UI events.
- Plugin code belongs under `src/frontend/src/plugins/<pluginName>/...`. Use the plugin id or domain as the directory name, for example `plugins/pomodoro/tool-view.ts` or `plugins/public-tunnel/settings-view.ts`.
- A plugin directory should own its UI components, view-state types, presenter helpers, and plugin-specific types. Shared app-level plugin registry code may stay in `plugin-views.ts`, but plugin-specific UI must not be added there.
- Mobile-only code belongs under `src/frontend/src/mobile/`, including mobile keyboard controls, mobile quick phrase UI, mobile clock helpers, and mobile-only CSS. Keep root-level modules for cross-platform code only.
- Settings views must be split by setting group or feature. A `settings-view.ts` file should compose smaller views, not accumulate unrelated settings markup.
- UI should be split into focused component/view files. Do not create or grow catch-all files such as `plugin-views.ts`, `notification-views.ts`, or broad `views.ts` files with unrelated components.
- Settings, mobile controls, uploads, file browsing, and AI chat logic should remain in their existing dedicated modules or move into the owning plugin directory when plugin-specific.

When adding new behavior:

1. Check existing files in `src/frontend/src/` for the closest ownership boundary.
2. If the code is more than a small event handler or simple call-through, extract it.
3. Keep new modules narrow, typed, and easy to test.
4. Avoid growing `main.ts` with pure helpers, data formatting, backend-specific rules, or UI rendering helpers.
5. For plugin work, create or update `src/frontend/src/plugins/<pluginName>/...` first, then wire it from `main.ts`.

If a change must touch `main.ts`, keep the edit to orchestration and move reusable logic out in the same change.
