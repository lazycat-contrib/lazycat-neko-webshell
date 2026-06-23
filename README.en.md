# Neko Webshell

[中文](./README.md)

Neko Webshell is a browser terminal for LazyCat and LightOS. Open an app instance, run commands, read output, move files, paste images, and keep working without setting up an SSH client first.

It works as a remote workbench you can reach from a browser. On desktop, it is comfortable for longer sessions. On mobile, it keeps the keys and scrolling behavior you need for terminal work.

## What You Can Do

- Open a terminal for a target app instance and run commands.
- Keep several terminal tabs open at the same time.
- Split a terminal tab into panes so you can watch output and keep typing elsewhere.
- Reopen the page and recover your tabs, panes, and recent output.
- Use mobile shortcut keys for Ctrl, Alt, Tab, arrow keys, F1-F12, and shell symbols.
- Upload, download, and inspect files from the target instance.
- Paste an image from the clipboard, save it on the target instance, and send the file path to the terminal.
- Use the built-in chat panel to analyze recent output or draft troubleshooting steps.
- If Herdr is installed on the target device, switch Herdr spaces and tabs from the same WebShell interface.

## Opening The Terminal

Open Neko Webshell from the LightOS WebShell entry and choose the app instance you want to work on.

The top area handles instance switching, new tabs, layout actions, and menus. The middle area is the terminal. On smaller screens, common actions move into menus or the mobile shortcut bar so the terminal keeps as much room as possible.

Neko Webshell tries to keep your working state. When you reopen the page, existing tabs, panes, and recent output come back. If the remote process is still running, you can continue watching later output.

## Terminal Experience

Neko Webshell supports tabs and split panes. Each tab can have its own terminal layout. You can rename tabs, close sessions you no longer need, or move the current pane into a new tab.

You can scroll back through terminal history. Desktop uses the mouse wheel. Mobile uses vertical touch scrolling. When a full-screen editor or terminal program takes over mouse input, Neko Webshell lets that program handle the mouse and scroll events first.

You can also adjust the terminal theme, font, font size, line height, cursor style, background image, opacity, and blur. The app theme and the terminal theme are separate, so you can mix light and dark preferences.

## Mobile Use

Mobile keyboards miss many keys that terminal work needs, so Neko Webshell includes a shortcut bar.

- `Main` has common modifier and action keys, including Ctrl, Alt, Shift, Tab, Return, arrows, copy, and paste.
- `Ops` has tab, pane, and font size actions.
- `Nav` has Home, End, PageUp, PageDown, Delete, and Backspace.
- `Fn` has F1-F12.
- `Sym` has common shell symbols.

You can tap Ctrl in the shortcut bar, then press a letter on the system keyboard to enter combinations such as Ctrl+C, Ctrl+A, or Ctrl+E. Double tap the terminal to open the system keyboard. Swipe left or right to switch tabs.

## Files And Images

The file panel follows the current terminal directory when possible. You can enter folders, go up one level, refresh the list, upload local files, download remote files, view text files, and inspect file details.

When you paste an image, Neko Webshell saves it on the target instance first, then sends the saved path to the terminal. This lets you pass screenshots, clipboard images, or mobile photos to commands and tools running in the terminal.

## AI Chat

AI Chat is a built-in chat panel for understanding and organizing terminal work. It does not control your terminal automatically.

You can ask about command output, get troubleshooting ideas, draft commands, or turn recent output into a clearer checklist. The panel supports model switching, connection tests, multiple chats, copying one answer, and exporting a full chat.

Sending recent terminal context is optional. If you turn that option off, chat requests do not include terminal content.

## Herdr Support

If Herdr is installed on the target device, Neko Webshell shows Herdr as an option when creating tabs and in settings. You can switch spaces, view tabs in the current space, create tabs, create spaces, and refresh the state from the WebShell interface.

On mobile, the current space keeps its name while other spaces are shown more compactly, leaving more room for the terminal.

If Herdr is not installed, these controls stay out of the way.

## Settings

You can adjust:

- App language and interface style.
- Default terminal type for new tabs.
- Terminal theme, font, font size, line height, and cursor.
- Terminal background image, opacity, and blur.
- How much output history to keep.
- Mobile touch selection behavior.
- Plugin state.
- AI connection and privacy options.

## Technical Notes

This section is for developers and package maintainers. You do not need it for normal use.

- Frontend: TypeScript, Vite, Restty.
- Backend: Rust, Axum, Tokio.
- Terminal sessions: portable-pty, with recent output stored for page recovery.
- Storage: SQLite.
- Control API: ConnectRPC.
- Package target: LazyCat LPK, exported as a LightOS WebShell provider.
- Optional integrations: Herdr socket bridge and zellij backend detection.

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

Build the LazyCat LPK:

```bash
lzc-cli project release
```

After installation, LightOS opens it through the WebShell entry:

```text
https://<provider-domain>/?name=<name>@<owner_deploy_id>
```

LightOS runs commands inside the target instance. Neko Webshell provides the interface, session recovery, input and output forwarding, and the user experience around the terminal.
