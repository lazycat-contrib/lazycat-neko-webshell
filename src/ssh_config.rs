use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigDocument {
    pub globals: Vec<SshConfigOption>,
    pub hosts: Vec<SshConfigHost>,
    pub matches: Vec<SshConfigMatch>,
    pub includes: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigOption {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub start_line: usize,
    pub end_line: usize,
    pub patterns: Vec<String>,
    pub options: Vec<SshConfigOption>,
    pub host_name: String,
    pub user: String,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
    pub certificate_files: Vec<String>,
    pub proxy_jump: String,
    pub proxy_command: String,
    pub forward_agent: String,
    pub strict_host_key_checking: String,
    pub server_alive_interval: Option<u32>,
    pub server_alive_count_max: Option<u32>,
    pub compression: String,
    pub connection_attempts: Option<u32>,
    pub connect_timeout: Option<u32>,
    pub local_forwards: Vec<String>,
    pub remote_forwards: Vec<String>,
    pub dynamic_forwards: Vec<String>,
    pub pubkey_accepted_algorithms: String,
    pub pubkey_accepted_key_types: String,
    pub host_key_algorithms: String,
    pub extra_options: Vec<SshConfigOption>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigMatch {
    pub condition: String,
    pub options: Vec<SshConfigOption>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigSelectableHost {
    pub alias: String,
    pub host: String,
    pub username: String,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
    pub certificate_files: Vec<String>,
    pub proxy_jump: String,
    pub proxy_command: String,
}

pub fn parse_ssh_config(content: &str) -> Result<SshConfigDocument, String> {
    let mut parser = ParserState::default();
    for (index, raw_line) in content.lines().enumerate() {
        parser.parse_line(index + 1, raw_line)?;
    }
    Ok(parser.finish())
}

pub fn selectable_hosts(document: &SshConfigDocument) -> Vec<SshConfigSelectableHost> {
    let mut hosts = Vec::new();
    let mut seen = HashSet::new();
    for host in &document.hosts {
        for pattern in &host.patterns {
            if !ssh_config_alias_is_selectable(pattern) || !seen.insert(pattern.clone()) {
                continue;
            }
            hosts.push(SshConfigSelectableHost {
                alias: pattern.clone(),
                host: if host.host_name.is_empty() {
                    pattern.clone()
                } else {
                    host.host_name.clone()
                },
                username: host.user.clone(),
                port: host.port,
                identity_files: host.identity_files.clone(),
                certificate_files: host.certificate_files.clone(),
                proxy_jump: host.proxy_jump.clone(),
                proxy_command: host.proxy_command.clone(),
            });
        }
    }
    hosts
}

#[derive(Default)]
struct ParserState {
    globals: Vec<SshConfigOption>,
    hosts: Vec<SshConfigHost>,
    matches: Vec<SshConfigMatch>,
    includes: Vec<String>,
    warnings: Vec<String>,
    section: CurrentSection,
    last_line: usize,
}

#[derive(Default)]
enum CurrentSection {
    #[default]
    Global,
    Host(SshConfigHost),
    Match(SshConfigMatch),
}

impl ParserState {
    fn parse_line(&mut self, line_number: usize, raw_line: &str) -> Result<(), String> {
        self.last_line = line_number;
        let line = strip_ssh_config_comment(raw_line);
        if line.trim().is_empty() {
            return Ok(());
        }
        let words = split_ssh_config_words(line)
            .map_err(|message| format!("line {line_number}: {message}"))?;
        let Some((keyword, values)) = words.split_first() else {
            return Ok(());
        };
        let key = normalize_keyword(keyword);
        if key == "host" {
            self.flush_section(line_number.saturating_sub(1));
            let patterns = values
                .iter()
                .map(String::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            if patterns.is_empty() {
                self.warnings
                    .push(format!("line {line_number}: Host has no pattern"));
                self.section = CurrentSection::Global;
            } else {
                self.section = CurrentSection::Host(SshConfigHost::new(patterns, line_number));
            }
            return Ok(());
        }
        if key == "match" {
            self.flush_section(line_number.saturating_sub(1));
            self.section = CurrentSection::Match(SshConfigMatch {
                condition: values.join(" "),
                options: Vec::new(),
            });
            return Ok(());
        }

        let value = values.join(" ");
        if key == "include" {
            self.includes.push(value.clone());
        }
        let option = SshConfigOption {
            key: keyword.to_owned(),
            value,
        };
        match &mut self.section {
            CurrentSection::Global => self.globals.push(option),
            CurrentSection::Host(host) => host.apply(option),
            CurrentSection::Match(match_section) => match_section.options.push(option),
        }
        Ok(())
    }

    fn flush_section(&mut self, end_line: usize) {
        match std::mem::take(&mut self.section) {
            CurrentSection::Global => {}
            CurrentSection::Host(mut host) => {
                host.end_line = end_line.max(host.start_line);
                self.hosts.push(host);
            }
            CurrentSection::Match(match_section) => self.matches.push(match_section),
        }
    }

    fn finish(mut self) -> SshConfigDocument {
        self.flush_section(self.last_line);
        SshConfigDocument {
            globals: self.globals,
            hosts: self.hosts,
            matches: self.matches,
            includes: self.includes,
            warnings: self.warnings,
        }
    }
}

impl SshConfigHost {
    fn new(patterns: Vec<String>, start_line: usize) -> Self {
        Self {
            start_line,
            end_line: start_line,
            patterns,
            options: Vec::new(),
            host_name: String::new(),
            user: String::new(),
            port: None,
            identity_files: Vec::new(),
            certificate_files: Vec::new(),
            proxy_jump: String::new(),
            proxy_command: String::new(),
            forward_agent: String::new(),
            strict_host_key_checking: String::new(),
            server_alive_interval: None,
            server_alive_count_max: None,
            compression: String::new(),
            connection_attempts: None,
            connect_timeout: None,
            local_forwards: Vec::new(),
            remote_forwards: Vec::new(),
            dynamic_forwards: Vec::new(),
            pubkey_accepted_algorithms: String::new(),
            pubkey_accepted_key_types: String::new(),
            host_key_algorithms: String::new(),
            extra_options: Vec::new(),
        }
    }

    fn apply(&mut self, option: SshConfigOption) {
        let normalized = normalize_keyword(&option.key);
        match normalized.as_str() {
            "hostname" => self.host_name.clone_from(&option.value),
            "user" => self.user.clone_from(&option.value),
            "port" => self.port = parse_u16(&option.value),
            "identityfile" => self.identity_files.push(option.value.clone()),
            "certificatefile" => self.certificate_files.push(option.value.clone()),
            "proxyjump" => self.proxy_jump.clone_from(&option.value),
            "proxycommand" => self.proxy_command.clone_from(&option.value),
            "forwardagent" => self.forward_agent.clone_from(&option.value),
            "stricthostkeychecking" => self.strict_host_key_checking.clone_from(&option.value),
            "serveraliveinterval" => self.server_alive_interval = parse_u32(&option.value),
            "serveralivecountmax" => self.server_alive_count_max = parse_u32(&option.value),
            "compression" => self.compression.clone_from(&option.value),
            "connectionattempts" => self.connection_attempts = parse_u32(&option.value),
            "connecttimeout" => self.connect_timeout = parse_u32(&option.value),
            "localforward" => self.local_forwards.push(option.value.clone()),
            "remoteforward" => self.remote_forwards.push(option.value.clone()),
            "dynamicforward" => self.dynamic_forwards.push(option.value.clone()),
            "pubkeyacceptedalgorithms" => {
                self.pubkey_accepted_algorithms.clone_from(&option.value);
            }
            "pubkeyacceptedkeytypes" => {
                self.pubkey_accepted_key_types.clone_from(&option.value);
            }
            "hostkeyalgorithms" => self.host_key_algorithms.clone_from(&option.value),
            _ => self.extra_options.push(option.clone()),
        }
        self.options.push(option);
    }
}

fn parse_u16(value: &str) -> Option<u16> {
    value.trim().parse::<u16>().ok().filter(|port| *port > 0)
}

fn parse_u32(value: &str) -> Option<u32> {
    value.trim().parse::<u32>().ok()
}

fn normalize_keyword(value: &str) -> String {
    value
        .trim()
        .trim_end_matches('=')
        .chars()
        .filter(|ch| *ch != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

pub fn ssh_config_alias_is_selectable(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(['-', '!', '*'])
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || matches!(ch, '*' | '?' | '['))
}

fn strip_ssh_config_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    for (index, ch) in line.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => return &line[..index],
            _ => {}
        }
    }
    line
}

fn split_ssh_config_words(line: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for ch in line.trim().chars() {
        if escaped {
            word.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if !in_single => escaped = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '=' if !in_single && !in_double && words.is_empty() && !word.is_empty() => {
                words.push(std::mem::take(&mut word));
            }
            ch if ch.is_whitespace() && !in_single && !in_double => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(ch),
        }
    }
    if escaped {
        word.push('\\');
    }
    if in_single || in_double {
        return Err("unterminated quote".to_owned());
    }
    if !word.is_empty() {
        words.push(word);
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::{parse_ssh_config, selectable_hosts};

    #[test]
    fn parses_structured_ssh_config() {
        let document = parse_ssh_config(
            r#"
AddKeysToAgent yes
Include ~/.ssh/conf.d/*

Host dev-box dev-short *.internal !blocked
  HostName 10.0.0.5
  User root
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
  CertificateFile ~/.ssh/id_ed25519-cert.pub
  ProxyJump bastion
  LocalForward 8080 localhost:80

Match host example.com
  User ignored
"#,
        )
        .unwrap();

        assert_eq!(document.globals.len(), 2);
        assert_eq!(document.includes, vec!["~/.ssh/conf.d/*"]);
        assert_eq!(document.hosts.len(), 1);
        assert_eq!(document.matches.len(), 1);
        assert_eq!(document.hosts[0].identity_files, vec!["~/.ssh/id_ed25519"]);
        assert_eq!(document.hosts[0].start_line, 5);
        assert_eq!(document.hosts[0].end_line, 13);
        assert_eq!(
            document.hosts[0].certificate_files,
            vec!["~/.ssh/id_ed25519-cert.pub"]
        );
        assert_eq!(document.hosts[0].local_forwards, vec!["8080 localhost:80"]);

        let hosts = selectable_hosts(&document);
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].alias, "dev-box");
        assert_eq!(hosts[0].host, "10.0.0.5");
        assert_eq!(hosts[0].username, "root");
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[1].alias, "dev-short");
    }

    #[test]
    fn parses_common_identity_file_blocks() {
        let document = parse_ssh_config(
            r#"
Host DemoServerA
  HostName host-a.example.net
  User ubuntu
  IdentityFile ~/.ssh/demo_a_key.pem

Host DemoServerB
  HostName host-b.example.net
  User ubuntu
  IdentityFile ~/.ssh/demo_b_key.pem

Host DemoServerC
  HostName 203.0.113.10
  User ecs-user
  IdentityFile ~/.ssh/demo_c_key.pem
"#,
        )
        .unwrap();

        assert_eq!(document.hosts.len(), 3);
        assert_eq!(document.hosts[0].patterns, vec!["DemoServerA"]);
        assert_eq!(document.hosts[0].host_name, "host-a.example.net");
        assert_eq!(document.hosts[0].user, "ubuntu");
        assert_eq!(document.hosts[0].identity_files, vec!["~/.ssh/demo_a_key.pem"]);
        assert_eq!(document.hosts[2].patterns, vec!["DemoServerC"]);
        assert_eq!(document.hosts[2].user, "ecs-user");
    }
}
