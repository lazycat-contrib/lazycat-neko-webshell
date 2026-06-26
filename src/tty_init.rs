use crate::config::ENV_TTY_INIT_MODE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtyInitMode {
    Lightos,
    Generic,
}

pub fn tty_init_mode() -> TtyInitMode {
    tty_init_mode_from_env(std::env::var(ENV_TTY_INIT_MODE).ok().as_deref())
}

pub fn lightos_features_enabled() -> bool {
    tty_init_mode() == TtyInitMode::Lightos
}

pub fn tty_init_mode_from_env(value: Option<&str>) -> TtyInitMode {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value)
            if matches!(
                value.to_ascii_lowercase().as_str(),
                "generic" | "portable" | "none"
            ) =>
        {
            TtyInitMode::Generic
        }
        Some(value) if matches!(value.to_ascii_lowercase().as_str(), "lightos" | "lazycat") => {
            TtyInitMode::Lightos
        }
        _ => TtyInitMode::Lightos,
    }
}

pub fn terminal_session_bootstrap_script() -> &'static str {
    terminal_session_bootstrap_script_for_mode(tty_init_mode())
}

pub fn terminal_session_bootstrap_script_for_mode(mode: TtyInitMode) -> &'static str {
    match mode {
        TtyInitMode::Lightos => lightos_terminal_session_bootstrap_script(),
        TtyInitMode::Generic => generic_terminal_session_bootstrap_script(),
    }
}

fn lightos_terminal_session_bootstrap_script() -> &'static str {
    concat!(
        "if [ -z \"${LANG:-}\" ] || [ \"$LANG\" = C ] || [ \"$LANG\" = POSIX ]; then export LANG=C.UTF-8; fi\n",
        "if [ -f /run/catlink/shell-env.sh ]; then . /run/catlink/shell-env.sh; fi\n",
        "export SHELL=\"$__webshell_shell\""
    )
}

fn generic_terminal_session_bootstrap_script() -> &'static str {
    concat!(
        "if [ -z \"${LANG:-}\" ] || [ \"$LANG\" = C ] || [ \"$LANG\" = POSIX ]; then export LANG=C.UTF-8; fi\n",
        "export SHELL=\"$__webshell_shell\""
    )
}

#[cfg(test)]
mod tests {
    use super::{TtyInitMode, terminal_session_bootstrap_script_for_mode, tty_init_mode_from_env};

    #[test]
    fn defaults_to_lightos_mode() {
        assert_eq!(tty_init_mode_from_env(None), TtyInitMode::Lightos);
        assert_eq!(tty_init_mode_from_env(Some("")), TtyInitMode::Lightos);
        assert_eq!(
            tty_init_mode_from_env(Some("unknown")),
            TtyInitMode::Lightos
        );
    }

    #[test]
    fn parses_generic_mode_aliases() {
        assert_eq!(
            tty_init_mode_from_env(Some("generic")),
            TtyInitMode::Generic
        );
        assert_eq!(
            tty_init_mode_from_env(Some("portable")),
            TtyInitMode::Generic
        );
        assert_eq!(tty_init_mode_from_env(Some("none")), TtyInitMode::Generic);
    }

    #[test]
    fn generic_mode_skips_lightos_shell_env() {
        let script = terminal_session_bootstrap_script_for_mode(TtyInitMode::Generic);

        assert!(!script.contains("/run/catlink/shell-env.sh"));
        assert!(script.contains("export LANG=C.UTF-8"));
        assert!(script.contains("export SHELL=\"$__webshell_shell\""));
    }

    #[test]
    fn lightos_mode_sources_catlink() {
        let script = terminal_session_bootstrap_script_for_mode(TtyInitMode::Lightos);

        assert!(script.contains("/run/catlink/shell-env.sh"));
    }
}
