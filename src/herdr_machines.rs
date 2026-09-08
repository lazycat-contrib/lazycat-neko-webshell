//! The installed Herdr client's machine catalog is separate from server SockAPI state.
use anyhow::{bail, ensure};
use serde::{Deserialize, Serialize};

pub const MIN_MACHINE_AGENT_VERSION: u64 = 15;
pub const MAX_MACHINE_OUTPUT: usize = 1024 * 1024;
pub const MACHINE_SETUP_SECONDS: u64 = 300;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum MachineAction {
    List {},
    Test {
        target: String,
    },
    Add {
        target: String,
        label: String,
        session: String,
    },
    Rename {
        id: String,
        label: String,
    },
    Remove {
        id: String,
        expected: Machine,
    },
    Enable {
        id: String,
    },
    Disable {
        id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Machine {
    pub id: String,
    pub label: String,
    pub target: String,
    pub session: String,
    pub enabled: bool,
    pub selected: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MachineCatalog {
    pub supported: bool,
    pub machines: Vec<Machine>,
}

impl MachineAction {
    pub fn args(&self) -> anyhow::Result<Vec<String>> {
        let mut args = vec!["machine".to_owned()];
        match self {
            Self::Test { target } => {
                validate_text(target, "SSH target", 1024)?;
                ensure!(
                    !target.starts_with('-') && !target.chars().any(char::is_whitespace),
                    "invalid SSH target"
                );
                return Ok(vec![
                    "-o".into(),
                    "ConnectTimeout=10".into(),
                    "-o".into(),
                    "ConnectionAttempts=1".into(),
                    "-T".into(),
                    target.clone(),
                    "true".into(),
                ]);
            }
            Self::List {} => args.extend(["list".into(), "--json".into()]),
            Self::Add {
                target,
                label,
                session,
            } => {
                validate_text(target, "SSH target", 1024)?;
                ensure!(
                    !target.starts_with('-') && !target.chars().any(char::is_whitespace),
                    "invalid SSH target"
                );
                validate_label(label)?;
                ensure!(
                    !session.is_empty()
                        && session != "."
                        && session != ".."
                        && session.len() <= 64
                        && session
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)),
                    "invalid remote session name"
                );
                args.extend([
                    "add".into(),
                    target.clone(),
                    format!("--label={label}"),
                    format!("--remote-session={session}"),
                ]);
            }
            Self::Rename { id, label } => {
                validate_id(id)?;
                validate_label(label)?;
                args.extend(["rename".into(), id.clone(), format!("--label={label}")]);
            }
            Self::Remove { id, .. } | Self::Enable { id } | Self::Disable { id } => {
                validate_id(id)?;
                args.push(
                    match self {
                        Self::Remove { .. } => "remove",
                        Self::Enable { .. } => "enable",
                        _ => "disable",
                    }
                    .into(),
                );
                args.push(id.clone());
            }
        }
        if let Self::Remove { id, expected } = self {
            ensure!(
                expected.id == *id,
                "reviewed machine identity does not match profile id"
            );
            validate_label(&expected.label)?;
            validate_text(&expected.target, "SSH target", 1024)?;
            validate_text(&expected.session, "remote session", 64)?;
        }
        Ok(args)
    }

    pub fn check_removal(&self, machines: &[Machine]) -> anyhow::Result<()> {
        if let Self::Remove { id, expected } = self {
            ensure!(
                machines.iter().any(|machine| machine.id == *id
                    && machine.label == expected.label
                    && machine.target == expected.target
                    && machine.session == expected.session
                    && machine.enabled == expected.enabled),
                "machine changed since confirmation; refresh and review it again"
            );
        }
        Ok(())
    }
}

fn validate_id(id: &str) -> anyhow::Result<()> {
    ensure!(
        id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid machine profile id"
    );
    Ok(())
}

fn validate_label(label: &str) -> anyhow::Result<()> {
    validate_text(label, "machine label", 128)
}

fn validate_text(value: &str, name: &str, limit: usize) -> anyhow::Result<()> {
    if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        bail!("invalid {name}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_arguments_preserve_labels_and_aliases_without_a_shell() {
        let args = MachineAction::Add {
            target: "build-box".into(),
            label: "Build '$(touch x)'".into(),
            session: "agents".into(),
        }
        .args()
        .unwrap();
        assert_eq!(
            args,
            [
                "machine",
                "add",
                "build-box",
                "--label=Build '$(touch x)'",
                "--remote-session=agents"
            ]
        );
    }

    #[test]
    fn reviewed_machine_must_still_match_and_option_labels_stay_values() {
        let machine = Machine {
            id: "a".repeat(32),
            label: "Build".into(),
            target: "build".into(),
            session: "default".into(),
            enabled: true,
            selected: false,
        };
        let remove = MachineAction::Remove {
            id: machine.id.clone(),
            expected: machine.clone(),
        };
        assert!(remove.check_removal(std::slice::from_ref(&machine)).is_ok());
        let mut changed = machine.clone();
        changed.label = "Renamed elsewhere".into();
        assert!(remove.check_removal(&[changed]).is_err());
        assert!(remove.check_removal(&[]).is_err());
        let args = MachineAction::Rename {
            id: machine.id,
            label: "--session=qa".into(),
        }
        .args()
        .unwrap();
        assert_eq!(args.last().unwrap(), "--label=--session=qa");
    }

    #[test]
    fn machine_actions_reject_options_controls_and_unknown_fields() {
        for target in ["-oProxyCommand=bad", "a\nb", "", "a b"] {
            assert!(
                MachineAction::Add {
                    target: target.into(),
                    label: "Build".into(),
                    session: "default".into()
                }
                .args()
                .is_err()
            );
        }
        assert!(
            MachineAction::Disable {
                id: "--help".into()
            }
            .args()
            .is_err()
        );
        assert!(
            serde_json::from_str::<MachineAction>(r#"{"action":"list","command":"anything"}"#)
                .is_err()
        );
    }
}
