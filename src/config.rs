pub const APP_ID: &str = "lazycat-neko-webshell";
pub const APP_NAME: &str = "LazyCat Neko WebShell";
pub const LIGHTOSCTL: &str = "/lzcinit/lightosctl";
pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 32;
pub const MAX_COLS: u16 = 500;
pub const MAX_ROWS: u16 = 200;
pub const MAX_FONT_BYTES: usize = 10 * 1024 * 1024;
pub const DEFAULT_OUTPUT_FRAME_LIMIT: usize = 4096;
pub const MIN_OUTPUT_FRAME_LIMIT: usize = 128;
pub const MAX_OUTPUT_FRAME_LIMIT: usize = 20000;
pub const MAX_OUTPUT_BUFFER_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_FONT_DIR: &str = "/lzcapp/var/fonts";
pub const DEFAULT_SESSION_STATE_FILE: &str = "/lzcapp/var/sessions.json";
pub const SHELL_BOOTSTRAP_SCRIPT: &str = concat!(
    "__webshell_user=\"$(id -un 2>/dev/null || true)\"\n",
    "__webshell_entry=\"$(getent passwd \"$__webshell_user\" 2>/dev/null || true)\"\n",
    "__webshell_shell=\"$(printf '%s\\n' \"$__webshell_entry\" | cut -d: -f7)\"\n",
    "if [ -z \"$__webshell_shell\" ]; then __webshell_shell=\"${SHELL:-/bin/sh}\"; fi\n",
    "case \"$__webshell_shell\" in */*) ;; *) __webshell_shell=\"$(command -v \"$__webshell_shell\" 2>/dev/null || printf '%s' \"$__webshell_shell\")\";; esac\n",
    "if [ -z \"${LANG:-}\" ] || [ \"$LANG\" = C ] || [ \"$LANG\" = POSIX ]; then export LANG=C.UTF-8; fi\n",
    "if [ -f /run/catlink/shell-env.sh ]; then . /run/catlink/shell-env.sh; fi\n",
    "export SHELL=\"$__webshell_shell\"\n",
    "unset __webshell_user __webshell_entry\n",
    "exec \"$__webshell_shell\"",
);
