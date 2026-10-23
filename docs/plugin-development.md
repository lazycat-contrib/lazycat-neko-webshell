# Built-in plugin development

## Scope and build model

All eight existing plugins are statically included in the provider. Rutis 0.13.0
owns their service registration and cleanup. Browser plugins remain browser code;
no additional language runtime or dynamic-library loader is required. Building a
plugin into the application does not enable it or change saved user settings.

The new Terminal Diagnostics plugin uses the same discovery and packaging path,
bringing the catalog to nine built-ins. It defaults off.

`crates/plugin` is the shared plugin contract and Rutis runtime. `src/plugin`
is the host integration module. `src/plugins/<name>` owns each implementation and
manifest; `src/frontend/src/plugins/<id>` owns its browser entry, controllers and
views. The host discovers the manifests at build time and registers the matching
backend and frontend entries. Existing Connect, HTTP and WebSocket URLs, payloads
and persisted settings remain compatible.

## Resource contract (defined before migration)

| Resource | Consumers | Interface and authority |
| --- | --- | --- |
| Target files | file-transfer | Typed list/stat/read/write; host resolves the session and reauthorizes its selector and login identity on every operation. No raw host filesystem or arbitrary command API. Upload buffers are plugin-owned and bounded. |
| Terminal output | terminal-mcp, ai-chat, terminal-transfer | Host owns PTY output/replay and session identities. MCP uses bounded snapshots/subscriptions; AI receives only explicitly selected recent context; browser transfer hooks process the existing byte path once. |
| Terminal control | terminal-mcp | Host broker preserves ticket authentication, account/target checks, capability grants, confirmation and immediate revocation. Plugins cannot take ownership of PTYs, Herdr or target agents. |
| UI | all | Declared tool/settings entries, translation keys and icons; typed controller dependencies. Browser stream hooks preserve input/output ordering and transfer cancellation. Mobile uses the same existing views and confirmation flows. |
| Storage | pomodoro and plugin configuration | Plugin-scoped keys. Host owns database access and legacy key mapping. Existing enabled state, timer state and preferences survive migration. |
| Notifications | pomodoro, terminal-mcp | Host persists and renders notifications. Plugin access is restricted to its own source. Completion and approval deduplication remain authoritative. |
| Credentials | ai-chat, public-tunnel | Host supplies only the requested plugin's settings/profile secret; secrets are excluded from descriptors and the catalog. |
| Forwarding | lightos-port-forward, public-tunnel | Host authorizes target access; plugin owns its forwarding resources. Disable/unload cleans up plugin connections and tasks without touching terminal sessions. |
| Media | white-noise | Existing sound catalog, playback and browser audio lifecycle; no terminal access. |
| Diagnostics | terminal-diagnostics | Anonymous, bounded connection/replay trace and numeric task timing snapshots. The plugin receives no terminal handles, text, addresses or credentials. |

Native built-ins are trusted application code, not a sandbox for arbitrary third
party binaries. Capability declarations describe and validate the interfaces the
host supplies; they do not claim to sandbox native Rust code. `AppState`, raw
PTY handles, the database connection and unrestricted credential stores are not
plugin resources. Host transports and platform adapters may use them internally.

## Module ownership

| Location | Owns |
| --- | --- |
| `crates/plugin/src` | Shared requests, replies, errors, typed resource contracts, configuration snapshots and the Rutis lifecycle adapter. |
| `src/plugin/catalog.rs` and `build.rs` | Discovery of `plugin.json`, generated native modules and registrations. |
| `src/plugin/settings.rs` and `configuration.rs` | Saved enabled state, defaults, schema validation, public descriptors and configuration commits. |
| `src/plugin/resources` | Target authentication, file/process adapters, scoped storage, notifications and credential access. |
| `src/plugin/http` | Compatibility adapters for Pomodoro and the Terminal MCP HTTP/platform transports. |
| `src/plugins/<name>` | Plugin registration, business logic and owned transient resources. |
| `src/frontend/src/plugins/<id>` | Browser entry, controllers, views, presenters and plugin-specific types. |
| `src/frontend/src/plugins/host.ts` and `terminal-stream.ts` | Shared browser entry contract and host terminal-stream broker. |

The native directory names use underscores; public plugin IDs and frontend
directories use hyphens. The public IDs are `ai-chat`, `file-transfer`,
`lightos-port-forward`, `pomodoro`, `public-tunnel`, `terminal-mcp`,
`terminal-transfer`, `terminal-diagnostics` and `white-noise`.

## Add or change a built-in plugin

1. Create `src/plugins/<name>/mod.rs` and copy the closest existing
   `plugin.json`. Set a unique public `id`; retain the descriptor fields,
   `enabled`, `metadata`, `resources`, `frontend` and `configuration` sections.
   Defaults apply only when no saved setting exists.
2. Export `register(&Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError>`.
   The implementation's `id()` must match the manifest. Request only declared
   resources with `Resources::require`; undeclared, missing or incorrectly typed
   resources fail registration. Browser-only plugins still have a small native
   entry so enabled state and lifecycle have the same contract.
3. Put browser code under `src/frontend/src/plugins/<id>`. Its `entry.ts` exports
   `EntryResources`, `createEntry`, `renderSettings` and `isSettingsOpen`.
   A plugin without settings returns an empty string and `false` for the last
   two functions. `PluginEntry` supports tool rendering, preparation, post-render
   work, configuration updates and optional terminal-stream hooks.
4. Add translation keys and the manifest's icon, `nameKey`, `descriptionKey` and
   `tool` flag. The generated catalog supplies names, descriptions, icons, tool
   availability and settings renderers. Keep plugin rendering and helpers out
   of `main.ts`; wire typed controller dependencies there only when needed.
5. Run `npm run plugins:generate` and include both generated TypeScript files in
   the change. Cargo discovers native entries independently. npm's test hook
   rejects stale generated files; dev/typecheck/build regenerate them, and the
   release script generates them before running its checks.

Adding a plugin using existing resources needs no central native dispatch case.
A new host resource needs a narrow interface in `crates/plugin`, a host adapter
and binding in `PluginHost::runtime`, then a manifest grant and focused tests.
Manifest declarations for browser/platform capabilities such as `ui` describe
host contracts; they are not all entries in the native service registry.

For terminal byte processing, expose `PluginEntry.stream` and declare
`terminal-stream`. The broker rejects undeclared stream hooks, passes the
original pane/bytes once, stops after a hook consumes a transfer, and forwards
reset/resize lifecycle events. The host still owns terminal transport, replay,
reply authority, authentication and pane lifetime.

## Configuration and compatibility

`configuration.version` is currently `1`. Its `metadata` section describes known
editable fields using `boolean`, `enum`, `csv` or `string-array` rules. Invalid
values fail before the saved or running configuration changes. Existing unknown
metadata remains compatible. Host-owned fields such as `builtin`, `runtime`,
`backends`, `requiresRuntime` and `defaultEnabled` cannot be changed by clients.

The host persists the existing version-1 plugin list and defaults missing
per-plugin `configuration_version` to `1`. It restores saved enabled states and
metadata over manifest defaults. A configuration saved by a newer implementation
is preserved and cannot be overwritten or enabled by this implementation;
supporting a later schema version requires an explicit migration.

`configuration.preferences` records ownership of existing application preference
keys; the migration does not relocate or reset them. Host adapters select the
values a plugin can read. New generic plugin storage uses a plugin-specific
namespace. The existing Pomodoro state key maps to its original namespace so
running/completed timers and notification deduplication survive migration.

`secrets` and `privateMetadata` exclude fields from public descriptors. Manifests
contain field names, never credential values. AI settings and tunnel profiles
keep their existing persistence paths. Tunnel credentials cross the dedicated
profile interface; public metadata exposes configuration status without tokens.
Sensitive transformations belong in the resource adapter and the plugin's
`prepare_configuration` hook, before general metadata is persisted.

At startup and after a saved update, `configure` receives the complete
`PluginConfiguration { version, enabled, metadata }`. Updates for one plugin
are ordered. A short global commit lock prevents concurrent settings snapshots
from overwriting each other; cleanup proceeds under that plugin's own gate.
Once started, a committed configuration task survives a canceled HTTP/RPC
request. Persistence happens before the runtime hook; a hook failure is returned
as an error without pretending that the durable change was rolled back.

## Lifecycle and failure isolation

Rutis owns each keyed plugin registration and disposer. The host checks that
registration reaches `FiberState::Active`; a failed constructor/initialization
is reported for that plugin while the others remain usable. Disabled plugins
retain their settings and reject generic invocations.

Runtime invocations own their tasks and keep the plugin's read gate through
blocking work. Configuration takes its write gate, waits for actual work to
finish, then applies policy changes or cleans up resources. Canceling a caller
must not detach a tunnel/forward startup from its cleanup gate. Shut down by
rejecting new invocations, draining actual work and running disposers.

Disable/shutdown clears pending upload buffers, revokes MCP grants, stops and
joins public tunnels, and kills/reaps port-forward subprocesses. White-noise
playback pauses through its browser configuration hook. Saved timer state is
retained. Cleanup must never close unrelated PTYs or change target agent versions.

## Verification and packaging

The repository pins development tools in `mise.toml` and Rust in
`rust-toolchain.toml`. With those tools installed, run:

```bash
mise exec -- npm ci
mise exec -- npm test
mise exec -- npm run build
mise exec -- cargo fmt --all --check
mise exec -- cargo test --workspace --locked
mise exec -- cargo clippy --workspace --all-targets --locked
```

Format plugin implementation files with `rustfmt --edition 2024` as well: their
module declarations are generated in Cargo's output directory. Keep frontend
builds sequential with Rust builds/tests, because Rust embeds the assets that
Vite replaces.

The plugin runtime tests cover scoped grants, initialization failures,
configuration ordering, canceled callers and draining shutdown. Host tests
cover all manifests, legacy settings/timers, newer configurations, credential
redaction, notification/storage isolation and upload ownership/cleanup. Catalog
tests cover auto-registration, defaults, duplicate/incomplete manifests and
stale generated files. The browser regression suite covers settings, mobile
workflows and real terminal/agent workspace synchronization.

`mise exec -- bash scripts/build-release.sh` additionally verifies versions,
builds the frontend, checks/tests the Rust workspace, builds the static musl
agent and provider, verifies embedded-agent compatibility/size and stages the
provider under `dist/content`. It requires a musl C compiler (`musl-gcc` in CI).
The LazyCat build then packages that content using `lzc-build.yml`. Plugins add
no extra deployment process or dynamic runtime. Application publication and
target-local agent compatibility versions remain separate concerns.
