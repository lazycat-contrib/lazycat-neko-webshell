# Neko Webshell

[中文](./README.md)

Current version: `0.5.38`

Neko Webshell is a browser WebShell workbench. It defaults to LazyCat / LightOS app instances, but it can also run as a generic WebShell with LightOS initialization disabled and manage remote terminal targets through SSH profiles.

It works as a remote workbench you can reach from a browser. On desktop, it is comfortable for longer development and troubleshooting sessions. On mobile, it keeps the keys, vertical history scrolling, and tab switching behavior terminal work needs.

## What You Can Do

- Open a terminal for a target app instance and run commands or inspect logs.
- Keep several terminal tabs open at the same time.
- Split one terminal tab into panes so you can watch output and keep typing elsewhere.
- Reopen the browser or WebShell app and return to the previous tabs, panes, and recent output.
- Use mobile shortcut keys for Ctrl, Alt, Tab, arrow keys, F1-F12, and shell symbols.
- Upload, download, and inspect files from the target instance.
- Paste clipboard images, save them on the target instance, and send the saved path to the terminal.
- Use AI Chat to analyze recent output, organize command ideas, or draft troubleshooting steps.
- Preview HTTP services inside a LightOS instance through port forwarding.
- Publish a local HTTP preview URL through Cloudflare Quick Tunnel or a tunnel provider with saved authentication.
- Play local white-noise and ambient sound files from `/lzcapp/var/sounds`.
- Add SSH profiles and open remote hosts as first-class terminal targets.
- If Herdr is installed on the target device, switch Herdr spaces and tabs from the same WebShell interface.

## Opening The Terminal

Open Neko Webshell from the LightOS WebShell entry and choose the app instance you want to work on.

The top area handles instance switching, new tabs, layout actions, and menus. The middle area is the terminal. On smaller screens, common actions move into menus or the mobile shortcut bar so the terminal keeps as much room as possible.

Native WebShell sessions are held by an agent running inside the target instance. Browser refreshes, closing the WebShell page, and WebShell backend restarts should not stop a running shell program. When you reopen the page, the workspace is restored and recent output is replayed. If the target instance stops or the agent is killed, those sessions are lost.

## Generic WebShell And SSH Backend

The default runtime mode is `lightos`. It loads LightOS terminal initialization and shows LightOS Home, Herdr, LightOS port forwarding, and other LightOS-only entries. Generic deployments can use:

```bash
NEKO_WEBSHELL_TTY_INIT=generic cargo run
```

`generic` mode does not load `/run/catlink/shell-env.sh` and hides LightOS-only menus and APIs. Leaving the variable unset keeps the default `lightos` behavior for LazyCat / LightOS packages.

The SSH backend is managed through SSH profiles in settings. Two profile kinds are supported:

- `Managed key`: WebShell generates and stores an ed25519 key for the profile. Add the public key to the remote host.
- `OpenSSH`: WebShell calls the device `ssh <target>` command directly, so existing `~/.ssh/config`, ssh-agent, and system OpenSSH behavior can be used.

When the device user has `~/.ssh/config`, the settings page reads selectable `Host` aliases and can fill an OpenSSH profile from them. Connections are still resolved by the device OpenSSH command, including certificate and key authentication behavior such as `IdentityFile`, `CertificateFile`, `ProxyJump`, and ssh-agent. WebShell does not copy those OpenSSH semantics and does not store certificate or private-key contents in its own database.

Managed keys are stored in `/lzcapp/var/ssh/keys` by default. Set `NEKO_WEBSHELL_SSH_KEY_DIR` to override that directory. OpenSSH config defaults to the current process user's `~/.ssh/config`; set `NEKO_WEBSHELL_SSH_CONFIG_FILE` to point at another config file.

You can also create or reuse an OpenSSH profile from URL parameters and open an SSH WebShell automatically:

```text
https://<webshell-domain>/?sshTarget=cert-box
https://<webshell-domain>/?sshTarget=deploy@example.com&sshName=prod&sshPort=2222
```

Parameters:

- `sshTarget`: required. This is passed to the device OpenSSH command as `ssh <target>`. It can be a `Host` alias from `~/.ssh/config` or a `user@host` target.
- `sshName`: optional profile display name. Defaults to `sshTarget`.
- `sshHost`: optional display host for the UI. The real connection target is still `sshTarget`.
- `sshUser`: optional display and workspace metadata user. The real connection target is still `sshTarget`.
- `sshPort`: optional profile port, passed to OpenSSH as `ssh -p`. When `sshTarget` is a `Host` alias from `~/.ssh/config`, usually omit this parameter so it does not override the OpenSSH config port.
- `sshStrictHostKeyChecking`: optional, one of `accept-new`, `yes`, or `no`. Defaults to `accept-new`.

After these parameters are consumed, the address bar is replaced with the normal workspace URL `?name=<profile-id>@ssh` so refreshes do not create duplicates. Existing OpenSSH profiles with the same `sshTarget` and port are reused. Certificate, private key, ProxyJump, and agent authentication settings are still read and handled only by the device OpenSSH command.

## Terminal Experience

Neko Webshell supports tabs and split panes. Each tab can have its own terminal layout. You can rename tabs, close sessions you no longer need, or promote the current pane into a new tab.

You can scroll back through terminal history. Desktop uses the mouse wheel. Mobile uses vertical touch scrolling. When a full-screen editor or terminal program takes over mouse input, Neko Webshell lets that program handle mouse and scroll events first.

You can also adjust the terminal theme, font, font size, line height, cursor style, background image, opacity, and blur. The app theme and terminal theme are separate, so you can mix light and dark preferences.

## Mobile Use

Mobile keyboards miss many keys that terminal work needs, so Neko Webshell includes a shortcut bar.

- `Main` has common modifier and action keys, including Ctrl, Alt, Shift, Tab, Return, arrows, copy, and paste.
- `Ops` has tab, pane, and font size actions.
- `Nav` has Home, End, PageUp, PageDown, Delete, and Backspace.
- `Fn` has F1-F12.
- `Sym` has common shell symbols.

You can tap Ctrl in the shortcut bar, then press a letter on the system keyboard to enter combinations such as Ctrl+C, Ctrl+A, or Ctrl+E. Double tap the terminal to open the system keyboard. Swipe left or right to switch tabs.

## Files, Images, And Upload Progress

The file panel follows the current terminal directory when possible. You can enter folders, go up one level, refresh the list, upload local files, download remote files, view text files, and inspect file details.

When you paste an image, Neko Webshell saves it on the target instance first, then sends the saved path to the terminal. This lets you pass screenshots, clipboard images, or mobile photos to commands and tools running in the terminal.

During image upload, WebShell shows a thin progress bar at the top. The bar hides after the upload finishes. In Herdr sessions, WebShell also tries to send Herdr notifications when image upload starts and completes.

## AI Chat

AI Chat is a built-in chat panel for understanding and organizing terminal work. It does not control your terminal automatically.

You can configure multiple AI provider profiles and switch between them in the chat panel. The current version supports OpenAI-compatible APIs, OpenAI Responses, and Anthropic Claude. Replies stream in progressively, Markdown is rendered in the chat, and code blocks can be copied directly.

Sending recent terminal context is optional. When enabled, chat requests include recent terminal output and show a small terminal-style preview next to the AI avatar. When disabled, chat requests do not include terminal content.

AI Chat can also connect to remote MCP servers so chat can use external tools. Streamable HTTP and SSE MCP servers are supported. Local stdio MCP servers are not supported in this version.

## Herdr Support

If Herdr is installed on the target device, Neko Webshell shows Herdr as an option when creating tabs and in settings. You can switch spaces, view tabs in the current space, create tabs, create spaces, and refresh state from the WebShell interface.

Herdr sessions are owned by Herdr itself. When you close the WebShell app and open it again later, Neko Webshell reconnects to Herdr and tries to restore the recent view position and output.

When the device Herdr protocol version differs from the version WebShell supports, the interface shows a non-intrusive hint: newer device protocol means WebShell protocol support may need an update, older device protocol means Herdr on the device may need an update.

If Herdr is not installed, these controls stay out of the way.

## Port Forwarding And Public Tunnel

LightOS port forwarding maps an HTTP port inside the target instance to a local URL on the WebShell backend. This is useful for previewing a service running inside the instance, such as `127.0.0.1:3000`.

Public Tunnel can publish that local HTTP URL temporarily:

- Cloudflare Quick Tunnel works without authentication.
- Tunnel providers that need tokens use saved tunnel authentication configs from tool settings.
- The current version supports Cloudflare Quick Tunnel and ngrok.
- Tunnel and port-forward sessions stay alive while the WebShell backend is running. If the backend process exits, they need to be started again.

Tunnel authentication configs are stored in the WebShell backend database. The tool panel only selects saved configs and does not ask for tokens directly.

These features are built-in WebShell tools, not a third-party plugin distribution system. External plugin marketplaces, installable plugin packages, and hot-loaded third-party tools are not supported.

## White Noise And Local Sounds

The white-noise tool does not bundle audio files into the frontend. The backend reads audio from `/lzcapp/var/sounds`, and the first directory level under `sounds/` becomes the category list. Default package:

```text
https://share.pushcat.eu.org/sounds.zip
```

The zip archive root must contain a `sounds/` directory, for example:

```text
sounds/
  rain/
    light-rain.mp3
  noise/
    white-noise.wav
  custom/
    my-focus-sound.ogg
```

Extract it on the device:

```bash
curl -L -o /tmp/sounds.zip https://share.pushcat.eu.org/sounds.zip
unzip -o /tmp/sounds.zip -d /lzcapp/var
```

The final files should look like `/lzcapp/var/sounds/noise/white-noise.wav`. Supported formats are `.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, and `.webm`. To add custom sounds, place your own folders and audio files under `sounds/`, then refresh the tool.

## Appearance And Settings

Settings include:

- App language and interface style.
- Default terminal type for new tabs: native WebShell, Herdr, or zellij.
- Terminal theme, font, font size, line height, and cursor.
- Programming ligatures, font hinting, and terminal effects.
- Terminal background image, opacity, and blur.
- Output history size.
- Mobile touch selection behavior.
- Built-in tool state.
- AI providers, MCP servers, and terminal context options.
- Tunnel authentication configs.

The settings menu also includes an About page for version and app information.

## Technical Notes

This section is for developers and package maintainers. You do not need it for normal use.

- Frontend: TypeScript, Vite, Restty.
- Backend: Rust, Axum, Tokio.
- Terminal rendering: Restty, with native plugins and Shader stages for context collection, input glow, scanline, and vignette effects.
- Native WebShell sessions: in-instance agent daemon manages workspaces, tabs, panes, PTYs, and bounded history.
- Terminal protocol: WebSocket data plane, ConnectRPC control plane, and protobuf frames for the internal agent protocol.
- Storage: SQLite for workspaces, session metadata, recent output, Herdr replay cursors, built-in tool settings, SSH profiles, and tunnel authentication configs.
- File capability: file reads, writes, and uploads through the active target instance session.
- Network capability: LightOS port forwarding, Cloudflare Quick Tunnel, and ngrok.
- LazyCat Rust SDK: [GitHub source](https://github.com/lib-x/lzc-sdk-rs), [crates.io](https://crates.io/crates/lzc-sdk), and [API documentation](https://docs.rs/lzc-sdk).
- Optional integrations: SSH backend, Herdr socket bridge, and zellij backend detection.
- Package target: LazyCat LPK, exported as a LightOS WebShell provider.

Local build:

```bash
npm install
npm run build
cargo test
cargo run
```

Frontend development:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. Vite forwards API requests to the local backend.

For generic WebShell deployment, use `NEKO_WEBSHELL_TTY_INIT=generic`. Supported values include `lightos` and `generic`; the default is `lightos`. The white-noise directory can be overridden with `NEKO_WEBSHELL_SOUNDS_DIR`. The managed SSH key directory can be overridden with `NEKO_WEBSHELL_SSH_KEY_DIR`, and the OpenSSH config file can be overridden with `NEKO_WEBSHELL_SSH_CONFIG_FILE`.

Build the LazyCat LPK:

```bash
lzc-cli project release
```

After installation, LightOS opens it through the WebShell entry:

```text
https://<provider-domain>/?name=<name>@<owner_deploy_id>
```

LightOS and the in-instance agent run commands inside LightOS targets; SSH targets connect through the local OpenSSH process. Neko Webshell provides the interface, workspace recovery, input and output forwarding, built-in tool features, and mobile experience around the terminal.
