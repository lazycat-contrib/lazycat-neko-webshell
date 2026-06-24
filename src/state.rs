use std::collections::{HashMap, HashSet};
use std::io;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use buffa::MessageField;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::config::{LIGHTOSCTL, MAX_COLS, MAX_ROWS};
#[cfg(test)]
use crate::database::remove_database_file;
use crate::database::{
    AppDatabase, KV_KEY_PLUGINS, KV_KEY_SESSIONS, KV_NAMESPACE_STATE, database_path,
};
use crate::proto::lazycat::webshell::v1::{ControlLease, PluginDescriptor, Session};
use crate::session_manager::SessionManager;
use crate::terminal_manager::{OutputBuffer, TerminalSpec};
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};
use crate::workspace::{WorkspaceRecord, WorkspaceStore, default_workspace_store};

const METADATA_RESTARTABLE: &str = "restartable";
const METADATA_HOST: &str = "host";
const METADATA_OUTPUT_BUFFER_LIMIT: &str = "outputBufferLimit";
const METADATA_SESSION_BACKEND: &str = "sessionBackend";
pub const METADATA_LOGIN_USER: &str = "loginUser";

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<SessionManager>,
    pub plugins: Arc<RwLock<HashMap<String, PluginRecord>>>,
    pub workspaces: Arc<RwLock<HashMap<String, WorkspaceRecord>>>,
    database: Arc<AppDatabase>,
    workspace_store: Arc<WorkspaceStore>,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        let database = Arc::new(AppDatabase::open(database_path())?);
        let session_store = Arc::new(SessionStore::new(Arc::clone(&database)));
        let workspace_store = Arc::new(default_workspace_store(Arc::clone(&database)));
        let workspaces = workspace_store.load().unwrap_or_else(|err| {
            warn!(error = %err, "failed to load persisted terminal workspaces");
            HashMap::new()
        });
        let mut sessions = session_store.load().unwrap_or_else(|err| {
            warn!(error = %err, "failed to load persisted terminal sessions");
            HashMap::new()
        });
        for session_id in prune_unreferenced_sessions(&mut sessions, &workspaces) {
            if let Err(err) = database.delete_output_history(&session_id) {
                warn!(error = %err, session_id = %session_id, "failed to remove unreferenced terminal output history");
            }
        }
        if let Err(err) = session_store.save(&sessions) {
            warn!(error = %err, "failed to prune unreferenced terminal sessions");
        }
        let plugins = PluginStore::new(Arc::clone(&database))
            .load()
            .unwrap_or_else(|err| {
                warn!(error = %err, "failed to load persisted plugin settings");
                builtin_plugins()
            });
        Ok(Self {
            sessions: Arc::new(SessionManager::new(
                sessions,
                Arc::clone(&session_store),
                Arc::clone(&database),
            )),
            plugins: Arc::new(RwLock::new(plugins)),
            workspaces: Arc::new(RwLock::new(workspaces)),
            database,
            workspace_store,
        })
    }

    pub fn persist_sessions_snapshot(
        &self,
        sessions: &HashMap<String, SessionRecord>,
    ) -> io::Result<()> {
        self.sessions.persist_snapshot(sessions)
    }

    pub fn persist_workspaces_snapshot(
        &self,
        workspaces: &HashMap<String, WorkspaceRecord>,
    ) -> io::Result<()> {
        self.workspace_store.save(workspaces)
    }

    pub fn persist_plugins_snapshot(
        &self,
        plugins: &HashMap<String, PluginRecord>,
    ) -> io::Result<()> {
        PluginStore::new(Arc::clone(&self.database)).save(plugins)
    }

    pub fn output_buffer(&self, session_id: &str, limit: usize) -> Arc<OutputBuffer> {
        self.sessions.output_buffer(session_id, limit)
    }

    pub fn database(&self) -> Arc<AppDatabase> {
        Arc::clone(&self.database)
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(database_path: PathBuf) -> Self {
        let _ = remove_database_file(&database_path);
        let database = Arc::new(AppDatabase::open(database_path).expect("test database"));
        Self {
            sessions: Arc::new(SessionManager::new(
                HashMap::new(),
                Arc::new(SessionStore::new(Arc::clone(&database))),
                Arc::clone(&database),
            )),
            plugins: Arc::new(RwLock::new(HashMap::new())),
            workspaces: Arc::new(RwLock::new(HashMap::new())),
            database: Arc::clone(&database),
            workspace_store: Arc::new(WorkspaceStore::new(database)),
        }
    }
}

fn prune_unreferenced_sessions(
    sessions: &mut HashMap<String, SessionRecord>,
    workspaces: &HashMap<String, WorkspaceRecord>,
) -> Vec<String> {
    let referenced = workspaces
        .values()
        .flat_map(|workspace| &workspace.tabs)
        .flat_map(|tab| &tab.panes)
        .map(|pane| pane.session_id.as_str())
        .collect::<HashSet<_>>();
    let mut removed = Vec::new();
    sessions.retain(|session_id, _| {
        let keep = referenced.contains(session_id.as_str());
        if !keep {
            removed.push(session_id.clone());
        }
        keep
    });
    removed
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    #[serde(default)]
    pub host: String,
    pub selector: String,
    pub status: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub control: Option<ControlLease>,
    #[serde(default)]
    pub metadata: HashMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct PluginRecord {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub description: String,
    pub scopes: Vec<String>,
    pub accepted_content_types: Vec<String>,
    pub produced_content_types: Vec<String>,
    pub input_schema_json: String,
    pub output_schema_json: String,
    pub enabled: bool,
    pub metadata: HashMap<String, String>,
}

impl SessionRecord {
    pub fn to_proto(&self) -> Session {
        Session {
            id: Some(self.id.clone()),
            selector: Some(self.selector.clone()),
            status: Some(self.status.clone()),
            cols: Some(i32::from(self.cols)),
            rows: Some(i32::from(self.rows)),
            control: self
                .control
                .clone()
                .map_or_else(MessageField::none, MessageField::some),
            metadata: self.metadata.clone(),
            ..Default::default()
        }
    }

    pub fn normalize_for_startup(mut self) -> Self {
        if self.host.trim().is_empty() {
            self.host = host_from_selector(&self.selector);
        }
        let login_user = self
            .metadata
            .get(METADATA_LOGIN_USER)
            .map(String::as_str)
            .unwrap_or_default()
            .to_owned();
        let backend_id = self
            .metadata
            .get(METADATA_SESSION_BACKEND)
            .map_or("webshell", String::as_str)
            .to_owned();
        if self.command.trim().is_empty() {
            let (command, args) =
                session_command_for_backend_id(&self.selector, &login_user, &backend_id);
            self.command = command;
            self.args = args;
        } else if !login_user.trim().is_empty() {
            sync_session_login_user(&mut self, &login_user);
        }
        if self.status != "closed" {
            "stopped".clone_into(&mut self.status);
        }
        self.metadata
            .entry(METADATA_HOST.to_owned())
            .or_insert_with(|| self.host.clone());
        self.metadata
            .entry(METADATA_RESTARTABLE.to_owned())
            .or_insert_with(|| "false".to_owned());
        self
    }

    pub fn set_restartable(&mut self, restartable: bool) {
        self.metadata
            .insert(METADATA_RESTARTABLE.to_owned(), restartable.to_string());
    }

    pub fn terminal_spec(&self, cols: u16, rows: u16) -> TerminalSpec {
        TerminalSpec {
            session_id: self.id.clone(),
            host: self.host.clone(),
            selector: self.selector.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            cols,
            rows,
            output_frame_limit: self.output_frame_limit(),
        }
    }

    pub fn output_frame_limit(&self) -> usize {
        output_frame_limit_from_metadata(&self.metadata)
    }
}

impl PluginRecord {
    pub fn to_proto(&self) -> PluginDescriptor {
        PluginDescriptor {
            id: Some(self.id.clone()),
            kind: Some(self.kind.clone()),
            display_name: Some(self.display_name.clone()),
            description: Some(self.description.clone()),
            scopes: self.scopes.clone(),
            accepted_content_types: self.accepted_content_types.clone(),
            produced_content_types: self.produced_content_types.clone(),
            input_schema_json: Some(self.input_schema_json.clone()),
            output_schema_json: Some(self.output_schema_json.clone()),
            enabled: Some(self.enabled),
            metadata: self.metadata.clone(),
            ..Default::default()
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedPluginState {
    version: u32,
    plugins: Vec<PersistedPluginRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedPluginRecord {
    id: String,
    enabled: bool,
    #[serde(default)]
    metadata: HashMap<String, String>,
}

struct PluginStore {
    database: Arc<AppDatabase>,
}

impl PluginStore {
    fn new(database: Arc<AppDatabase>) -> Self {
        Self { database }
    }

    fn load(&self) -> io::Result<HashMap<String, PluginRecord>> {
        let mut plugins = builtin_plugins();
        let Some(bytes) = self.database.load_kv(KV_NAMESPACE_STATE, KV_KEY_PLUGINS)? else {
            return Ok(plugins);
        };
        let persisted = serde_json::from_slice::<PersistedPluginState>(&bytes)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
        for record in persisted.plugins {
            let id = record.id.trim();
            if id.is_empty() {
                continue;
            }
            let Some(plugin) = plugins.get_mut(id) else {
                warn!(plugin_id = %id, "ignored persisted settings for unknown plugin");
                continue;
            };
            plugin.enabled = record.enabled;
            plugin.metadata.extend(record.metadata);
        }
        Ok(plugins)
    }

    fn save(&self, plugins: &HashMap<String, PluginRecord>) -> io::Result<()> {
        let mut plugins = plugins
            .values()
            .map(|plugin| PersistedPluginRecord {
                id: plugin.id.clone(),
                enabled: plugin.enabled,
                metadata: plugin.metadata.clone(),
            })
            .collect::<Vec<_>>();
        plugins.sort_by(|left, right| left.id.cmp(&right.id));
        let persisted = PersistedPluginState {
            version: 1,
            plugins,
        };
        let bytes =
            serde_json::to_vec(&persisted).map_err(|err| io::Error::other(err.to_string()))?;
        self.database
            .store_kv(KV_NAMESPACE_STATE, KV_KEY_PLUGINS, &bytes)
    }
}

pub fn mark_session_status(state: &AppState, session_id: &str, status: &str) {
    state.sessions.mark_status(session_id, status);
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedSessionState {
    version: u32,
    sessions: Vec<SessionRecord>,
}

pub(crate) struct SessionStore {
    database: Arc<AppDatabase>,
}

impl SessionStore {
    pub(crate) fn new(database: Arc<AppDatabase>) -> Self {
        Self { database }
    }

    pub(crate) fn load(&self) -> io::Result<HashMap<String, SessionRecord>> {
        match self.database.load_kv(KV_NAMESPACE_STATE, KV_KEY_SESSIONS)? {
            Some(bytes) => {
                let sessions = Self::decode(&bytes)?;
                if let Err(err) = self.save(&sessions) {
                    warn!(error = %err, "failed to prune persisted terminal sessions");
                }
                Ok(sessions)
            }
            None => Ok(HashMap::new()),
        }
    }

    fn decode(bytes: &[u8]) -> io::Result<HashMap<String, SessionRecord>> {
        let persisted = serde_json::from_slice::<PersistedSessionState>(bytes)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
        let mut sessions = HashMap::new();
        for session in persisted.sessions {
            let session = session.normalize_for_startup();
            if session.status != "closed" && valid_persisted_session(&session) {
                sessions.insert(session.id.clone(), session);
            } else if session.status == "closed" {
                warn!(session_id = %session.id, "pruned closed persisted terminal session");
            } else {
                warn!(session_id = %session.id, "ignored invalid persisted terminal session");
            }
        }
        Ok(sessions)
    }

    pub(crate) fn save(&self, sessions: &HashMap<String, SessionRecord>) -> io::Result<()> {
        let sessions = persistable_sessions(sessions);
        if sessions.is_empty() {
            return self.database.delete_kv(KV_NAMESPACE_STATE, KV_KEY_SESSIONS);
        }
        let persisted = PersistedSessionState {
            version: 1,
            sessions,
        };
        let bytes =
            serde_json::to_vec(&persisted).map_err(|err| io::Error::other(err.to_string()))?;
        self.database
            .store_kv(KV_NAMESPACE_STATE, KV_KEY_SESSIONS, &bytes)
    }
}

fn persistable_sessions(sessions: &HashMap<String, SessionRecord>) -> Vec<SessionRecord> {
    let mut sessions = sessions
        .values()
        .filter(|session| session.status != "closed" && valid_persisted_session(session))
        .cloned()
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.id.cmp(&right.id));
    sessions
}

fn valid_persisted_session(session: &SessionRecord) -> bool {
    !session.id.trim().is_empty()
        && !session.host.trim().is_empty()
        && !session.command.trim().is_empty()
        && session.cols <= MAX_COLS
        && session.rows <= MAX_ROWS
        && validate_size(session.cols, session.rows).is_ok()
        && validate_selector(&session.selector).is_ok()
}

pub fn host_from_selector(selector: &str) -> String {
    selector
        .split_once('@')
        .map_or(selector, |(host, _)| host)
        .trim()
        .to_owned()
}

#[cfg(test)]
pub fn default_session_command(selector: &str) -> (String, Vec<String>) {
    default_session_command_for_user(selector, "")
}

pub fn default_session_command_for_user(selector: &str, login_user: &str) -> (String, Vec<String>) {
    session_command_with_script(selector, shell_bootstrap_script(login_user))
}

pub fn session_command_for_backend_id(
    selector: &str,
    login_user: &str,
    backend_id: &str,
) -> (String, Vec<String>) {
    match backend_id {
        "herdr" => program_session_command_for_user(selector, login_user, herdr_launch_script()),
        "zellij" => {
            program_session_command_for_user(selector, login_user, &zellij_launch_script(selector))
        }
        _ => default_session_command_for_user(selector, login_user),
    }
}

pub fn program_session_command_for_user(
    selector: &str,
    login_user: &str,
    program_script: &str,
) -> (String, Vec<String>) {
    let login_user = login_user.trim();
    let script = if login_user_needs_switch(login_user) {
        user_program_bootstrap_script(login_user, program_script)
    } else {
        current_user_program_bootstrap_script(program_script)
    };
    session_command_with_script(selector, script)
}

fn session_command_with_script(selector: &str, script: String) -> (String, Vec<String>) {
    (
        LIGHTOSCTL.to_owned(),
        vec![
            "exec".to_owned(),
            "-ti".to_owned(),
            selector.to_owned(),
            "/bin/sh".to_owned(),
            "-lc".to_owned(),
            script,
        ],
    )
}

pub fn sync_session_login_user(session: &mut SessionRecord, login_user: &str) -> bool {
    let normalized = login_user.trim();
    let backend_id = session
        .metadata
        .get(METADATA_SESSION_BACKEND)
        .map_or("webshell", String::as_str)
        .to_owned();
    let (command, args) =
        session_command_for_backend_id(&session.selector, normalized, &backend_id);
    let mut changed = false;
    if session.command != command {
        session.command = command;
        changed = true;
    }
    if session.args != args {
        session.args = args;
        changed = true;
    }
    match (
        normalized.is_empty(),
        session.metadata.get(METADATA_LOGIN_USER),
    ) {
        (true, Some(_)) => {
            session.metadata.remove(METADATA_LOGIN_USER);
            changed = true;
        }
        (false, Some(value)) if value == normalized => {}
        (false, _) => {
            session
                .metadata
                .insert(METADATA_LOGIN_USER.to_owned(), normalized.to_owned());
            changed = true;
        }
        (true, None) => {}
    }
    changed
}

fn herdr_launch_script() -> &'static str {
    r#"if command -v herdr >/dev/null 2>&1; then
  exec herdr
fi
if [ -n "${HOME:-}" ] && [ -x "$HOME/.local/bin/herdr" ]; then
  exec "$HOME/.local/bin/herdr"
fi
  echo "Herdr is not installed in this instance."
  exit 127
"#
}

fn zellij_launch_script(selector: &str) -> String {
    let session_name = format!("webshell-{}", zellij_session_suffix(selector));
    format!(
        r#"if ! command -v zellij >/dev/null 2>&1 || ! zellij --version >/dev/null 2>&1; then
  echo "zellij is not installed in this instance."
  exit 127
fi
exec zellij attach --create {}"#,
        shell_script_quote(&session_name),
    )
}

fn zellij_session_suffix(selector: &str) -> String {
    selector
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn shell_bootstrap_script(login_user: &str) -> String {
    let login_user = login_user.trim();
    if login_user_needs_switch(login_user) {
        return user_login_shell_bootstrap_script(login_user);
    }
    current_user_shell_bootstrap_script()
}

fn login_user_needs_switch(login_user: &str) -> bool {
    !matches!(login_user.trim(), "" | "root")
}

fn current_user_shell_bootstrap_script() -> String {
    current_user_bootstrap_script("exec \"$__webshell_shell\"")
}

fn current_user_program_bootstrap_script(program_script: &str) -> String {
    current_user_bootstrap_script(program_script)
}

fn current_user_bootstrap_script(final_script: &str) -> String {
    [
        "__webshell_user=\"$(id -un 2>/dev/null || true)\"",
        "__webshell_entry=\"$(getent passwd \"$__webshell_user\" 2>/dev/null || true)\"",
        "__webshell_home=\"$(printf '%s\\n' \"$__webshell_entry\" | cut -d: -f6)\"",
        "if [ -z \"$__webshell_home\" ]; then __webshell_home=\"${HOME:-}\"; fi",
        "if [ -n \"$__webshell_home\" ]; then export PATH=\"$__webshell_home/.local/bin:$__webshell_home/bin:$PATH\"; fi",
        "__webshell_shell=\"$(printf '%s\\n' \"$__webshell_entry\" | cut -d: -f7)\"",
        "if [ -z \"$__webshell_shell\" ]; then __webshell_shell=\"${SHELL:-/bin/sh}\"; fi",
        "case \"$__webshell_shell\" in */*) ;; *) __webshell_shell=\"$(command -v \"$__webshell_shell\" 2>/dev/null || printf '%s' \"$__webshell_shell\")\";; esac",
        terminal_session_bootstrap_script(),
        "unset __webshell_user __webshell_entry __webshell_home",
        final_script,
    ]
    .join("\n")
}

fn user_login_shell_bootstrap_script(login_user: &str) -> String {
    format!(
        r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
user={}
uid=$(id -u "$user" 2>/dev/null) || {{
  echo "webshell user was not found."
  exit 127
}}
gid=$(id -g "$user" 2>/dev/null) || {{
  echo "webshell user was not found."
  exit 127
}}
entry=$(getent passwd "$user" 2>/dev/null) || {{
  echo "webshell user entry was not found."
  exit 127
}}
home=$(printf '%s\n' "$entry" | cut -d: -f6)
shell=$(printf '%s\n' "$entry" | cut -d: -f7)
if [ -z "$home" ]; then
  home=/
fi
if [ -z "$shell" ]; then
  shell=/bin/sh
fi
PATH="$home/.local/bin:$home/bin:$PATH"
export PATH
if [ ! -d "$home" ]; then
  mkdir -p "$home"
fi
if [ "$(stat -c '%u' "$home" 2>/dev/null || true)" != "$uid" ] || [ "$(stat -c '%g' "$home" 2>/dev/null || true)" != "$gid" ]; then
  chown "$uid:$gid" "$home"
fi
xdg_config_home="$home/.config"
if [ ! -d "$xdg_config_home" ]; then
  mkdir -p "$xdg_config_home" 2>/dev/null || true
fi
if [ -d "$xdg_config_home" ]; then
  chown "$uid:$gid" "$xdg_config_home" 2>/dev/null || true
fi
xdg_runtime_dir="/run/user/$uid"
if [ ! -d "$xdg_runtime_dir" ]; then
  xdg_runtime_dir=""
fi
__webshell_shell="$shell"
{}
export XDG_CONFIG_HOME="$xdg_config_home"
if [ -n "$xdg_runtime_dir" ]; then
  export XDG_RUNTIME_DIR="$xdg_runtime_dir"
else
  unset XDG_RUNTIME_DIR
fi
if command -v setpriv >/dev/null 2>&1; then
  exec env HOME="$home" USER="$user" LOGNAME="$user" SHELL="$__webshell_shell" XDG_CONFIG_HOME="$xdg_config_home" setpriv --reuid "$uid" --regid "$gid" --init-groups "$__webshell_shell"
fi
if command -v su >/dev/null 2>&1; then
  export HOME="$home" USER="$user" LOGNAME="$user" SHELL="$__webshell_shell"
  exec su -s "$__webshell_shell" "$user"
fi
echo "setpriv or su is required for webshell login session."
exit 127"#,
        shell_script_quote(login_user),
        terminal_session_bootstrap_script(),
    )
}

fn user_program_bootstrap_script(login_user: &str, program_script: &str) -> String {
    format!(
        r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
user={}
program_script={}
uid=$(id -u "$user" 2>/dev/null) || {{
  echo "webshell user was not found."
  exit 127
}}
gid=$(id -g "$user" 2>/dev/null) || {{
  echo "webshell user was not found."
  exit 127
}}
entry=$(getent passwd "$user" 2>/dev/null) || {{
  echo "webshell user entry was not found."
  exit 127
}}
home=$(printf '%s\n' "$entry" | cut -d: -f6)
shell=$(printf '%s\n' "$entry" | cut -d: -f7)
if [ -z "$home" ]; then
  home=/
fi
if [ -z "$shell" ]; then
  shell=/bin/sh
fi
PATH="$home/.local/bin:$home/bin:$PATH"
export PATH
if [ ! -d "$home" ]; then
  mkdir -p "$home"
fi
if [ "$(stat -c '%u' "$home" 2>/dev/null || true)" != "$uid" ] || [ "$(stat -c '%g' "$home" 2>/dev/null || true)" != "$gid" ]; then
  chown "$uid:$gid" "$home"
fi
xdg_config_home="$home/.config"
if [ ! -d "$xdg_config_home" ]; then
  mkdir -p "$xdg_config_home" 2>/dev/null || true
fi
if [ -d "$xdg_config_home" ]; then
  chown "$uid:$gid" "$xdg_config_home" 2>/dev/null || true
fi
xdg_runtime_dir="/run/user/$uid"
if [ ! -d "$xdg_runtime_dir" ]; then
  xdg_runtime_dir=""
fi
__webshell_shell="$shell"
{}
export XDG_CONFIG_HOME="$xdg_config_home"
if [ -n "$xdg_runtime_dir" ]; then
  export XDG_RUNTIME_DIR="$xdg_runtime_dir"
else
  unset XDG_RUNTIME_DIR
fi
if command -v setpriv >/dev/null 2>&1; then
  exec env HOME="$home" USER="$user" LOGNAME="$user" SHELL="$__webshell_shell" XDG_CONFIG_HOME="$xdg_config_home" setpriv --reuid "$uid" --regid "$gid" --init-groups /bin/sh -lc "$program_script"
fi
if command -v su >/dev/null 2>&1; then
  export HOME="$home" USER="$user" LOGNAME="$user" SHELL="$__webshell_shell"
  exec su -s /bin/sh "$user" -c "$program_script"
fi
echo "setpriv or su is required for webshell login session."
exit 127"#,
        shell_script_quote(login_user),
        shell_script_quote(program_script),
        terminal_session_bootstrap_script(),
    )
}

fn terminal_session_bootstrap_script() -> &'static str {
    concat!(
        "if [ -z \"${LANG:-}\" ] || [ \"$LANG\" = C ] || [ \"$LANG\" = POSIX ]; then export LANG=C.UTF-8; fi\n",
        "if [ -f /run/catlink/shell-env.sh ]; then . /run/catlink/shell-env.sh; fi\n",
        "export SHELL=\"$__webshell_shell\""
    )
}

fn shell_script_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\"'\"'");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

pub fn bool_flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn output_frame_limit_from_metadata(metadata: &HashMap<String, String>) -> usize {
    let limit = metadata
        .get(METADATA_OUTPUT_BUFFER_LIMIT)
        .and_then(|value| value.trim().parse::<usize>().ok());
    normalize_output_frame_limit(limit)
}

fn builtin_plugins() -> HashMap<String, PluginRecord> {
    [
        PluginRecord {
            id: "file-transfer".to_owned(),
            kind: "transfer".to_owned(),
            display_name: "File Transfer Adapter".to_owned(),
            description: "Read, write, list, and inspect files in the selected LightOS instance through the current WebShell session boundary.".to_owned(),
            scopes: vec!["session".to_owned(), "filesystem".to_owned()],
            accepted_content_types: vec![
                "text/plain".to_owned(),
                "application/json".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            produced_content_types: vec![
                "text/plain".to_owned(),
                "application/json".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            input_schema_json: r#"{"sessionId":"string","operation":"list|stat|read|download|write|upload","metadata":{"path":"string"},"payload":"bytes for write/upload"}"#.to_owned(),
            output_schema_json: r#"{"status":"complete","contentType":"text/plain|application/json|application/octet-stream","payload":"file bytes, directory listing, stat output, or write summary"}"#.to_owned(),
            enabled: true,
            metadata: HashMap::from([
                ("builtin".to_owned(), "true".to_owned()),
                ("runtime".to_owned(), "lightosctl-exec".to_owned()),
            ]),
        },
        PluginRecord {
            id: "ai-chat".to_owned(),
            kind: "chat".to_owned(),
            display_name: "AI Chat".to_owned(),
            description: "Chat inside WebShell with optional recent terminal context. It does not control terminal input.".to_owned(),
            scopes: vec!["session".to_owned(), "ai".to_owned()],
            accepted_content_types: vec!["application/json".to_owned()],
            produced_content_types: vec!["application/json".to_owned()],
            input_schema_json: r#"{"operation":"chat|models|test","metadata":{"model":"string"},"payload":{"input":"string","ctx":"optional terminal context"}}"#.to_owned(),
            output_schema_json: r#"{"status":"complete","stream":"assistant response chunks","models":"optional model list"}"#.to_owned(),
            enabled: false,
            metadata: HashMap::from([
                ("builtin".to_owned(), "true".to_owned()),
                ("defaultEnabled".to_owned(), "false".to_owned()),
            ]),
        },
    ]
    .into_iter()
    .map(|plugin| (plugin.id.clone(), plugin))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DEFAULT_COLS, DEFAULT_ROWS};
    use crate::database::{KV_KEY_SESSIONS, KV_NAMESPACE_STATE};

    #[test]
    fn load_keeps_non_restartable_sessions_as_stopped() {
        let database = temp_database();
        let store = SessionStore::new(Arc::clone(&database));
        let persisted = PersistedSessionState {
            version: 1,
            sessions: vec![
                test_session("keep", "running", Some(true)),
                test_session("keep-non-restartable", "running", Some(false)),
                test_session("legacy-default", "running", None),
            ],
        };
        database
            .store_kv(
                KV_NAMESPACE_STATE,
                KV_KEY_SESSIONS,
                &serde_json::to_vec(&persisted).unwrap(),
            )
            .unwrap();

        let sessions = store.load().unwrap();

        assert_eq!(sessions.len(), 3);
        assert_eq!(
            sessions.get("keep").map(|session| session.status.as_str()),
            Some("stopped")
        );
        assert_eq!(
            sessions
                .get("keep-non-restartable")
                .map(|session| session.status.as_str()),
            Some("stopped")
        );
        assert_eq!(
            sessions
                .get("legacy-default")
                .and_then(|session| session.metadata.get("restartable"))
                .map(String::as_str),
            Some("false")
        );
        let persisted = serde_json::from_slice::<PersistedSessionState>(
            &database
                .load_kv(KV_NAMESPACE_STATE, KV_KEY_SESSIONS)
                .unwrap()
                .expect("persisted sessions"),
        )
        .unwrap();
        assert_eq!(persisted.sessions.len(), 3);
    }

    #[test]
    fn save_keeps_non_restartable_session_records() {
        let database = temp_database();
        let store = SessionStore::new(Arc::clone(&database));
        let sessions = HashMap::from([(
            "drop".to_owned(),
            test_session("drop", "running", Some(false)),
        )]);

        store.save(&sessions).unwrap();

        let persisted = serde_json::from_slice::<PersistedSessionState>(
            &database
                .load_kv(KV_NAMESPACE_STATE, KV_KEY_SESSIONS)
                .unwrap()
                .expect("persisted sessions"),
        )
        .unwrap();
        assert_eq!(persisted.sessions.len(), 1);
        assert_eq!(persisted.sessions[0].id, "drop");
        assert_eq!(
            persisted.sessions[0]
                .metadata
                .get("restartable")
                .map(String::as_str),
            Some("false")
        );
    }

    #[test]
    fn normalizes_output_frame_limit_from_metadata() {
        let metadata = HashMap::from([("outputBufferLimit".to_owned(), "64".to_owned())]);
        assert_eq!(output_frame_limit_from_metadata(&metadata), 128);

        let metadata = HashMap::from([("outputBufferLimit".to_owned(), "512".to_owned())]);
        assert_eq!(output_frame_limit_from_metadata(&metadata), 512);
    }

    #[test]
    fn default_session_command_resolves_login_shell_before_exec() {
        let (_, args) = default_session_command("demo@owner");
        let script = args.last().expect("bootstrap script argument");

        assert!(script.contains("__webshell_entry=\"$(getent passwd \"$__webshell_user\""));
        assert!(script.contains("export SHELL=\"$__webshell_shell\""));
        assert!(script.contains("exec \"$__webshell_shell\""));
        assert!(!script.contains("exec \"${SHELL:-/bin/sh}\""));
        assert!(!script.contains("LC_ALL"));
    }

    #[test]
    fn default_session_command_uses_configured_login_user() {
        let (_, args) = default_session_command_for_user("demo@owner", "admin");
        let script = args.last().expect("bootstrap script argument");

        assert!(script.contains("user='admin'"));
        assert!(script.contains("__webshell_shell=\"$shell\""));
        assert!(script.contains("export SHELL=\"$__webshell_shell\""));
        assert!(script.contains(
            "setpriv --reuid \"$uid\" --regid \"$gid\" --init-groups \"$__webshell_shell\""
        ));
        assert!(script.contains("exec su -s \"$__webshell_shell\" \"$user\""));
        assert!(script.contains("/run/catlink/shell-env.sh"));
        assert!(script.contains("XDG_CONFIG_HOME=\"$xdg_config_home\""));
        assert!(!script.contains("__webshell_user=\"$(id -un"));
    }

    #[test]
    fn default_session_command_shell_quotes_login_user() {
        let (_, args) = default_session_command_for_user("demo@owner", "dev'user");
        let script = args.last().expect("bootstrap script argument");

        assert!(script.contains("user='dev'\"'\"'user'"));
    }

    #[test]
    fn program_session_command_execs_program_without_native_shell() {
        let (_, args) = program_session_command_for_user(
            "demo@owner",
            "",
            "if ! command -v herdr >/dev/null 2>&1; then exit 127; fi\nexec herdr",
        );
        let script = args.last().expect("bootstrap script argument");

        assert!(script.contains("exec herdr"));
        assert!(!script.contains("exec \"$__webshell_shell\""));
    }

    #[test]
    fn program_session_command_switches_user_before_program() {
        let (_, args) = program_session_command_for_user(
            "demo@owner",
            "admin",
            "if ! command -v herdr >/dev/null 2>&1; then exit 127; fi\nexec herdr",
        );
        let script = args.last().expect("bootstrap script argument");

        assert!(script.contains("user='admin'"));
        assert!(script.contains("setpriv --reuid \"$uid\" --regid \"$gid\" --init-groups /bin/sh -lc \"$program_script\""));
        assert!(script.contains("exec su -s /bin/sh \"$user\" -c \"$program_script\""));
        assert!(script.contains("program_script='if ! command -v herdr"));
        assert!(!script.contains(
            "setpriv --reuid \"$uid\" --regid \"$gid\" --init-groups \"$__webshell_shell\""
        ));
    }

    #[test]
    fn sync_session_login_user_preserves_session_backend_command() {
        let selector = "demo@owner";
        let (command, args) = default_session_command_for_user(selector, "");
        let mut session = SessionRecord {
            id: "session-one".to_owned(),
            host: "demo".to_owned(),
            selector: selector.to_owned(),
            status: "running".to_owned(),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            command,
            args,
            control: None,
            metadata: HashMap::from([("sessionBackend".to_owned(), "herdr".to_owned())]),
        };

        assert!(sync_session_login_user(&mut session, ""));

        let script = session.args.last().expect("bootstrap script argument");
        assert!(script.contains("exec herdr"));
        assert!(!script.contains("exec \"$__webshell_shell\""));
    }

    #[test]
    fn output_buffers_are_session_scoped_until_removed() {
        let state = test_app_state();

        let first = state.output_buffer("session-one", 128);
        let second = state.output_buffer("session-one", 512);
        let other = state.output_buffer("session-two", 128);

        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));

        state.sessions.remove_output_buffer("session-one");
        let recreated = state.output_buffer("session-one", 128);

        assert!(!Arc::ptr_eq(&first, &recreated));
    }

    #[test]
    fn plugin_store_applies_persisted_builtin_settings() {
        let database = temp_database();
        let store = PluginStore::new(Arc::clone(&database));
        let mut plugins = builtin_plugins();
        let control = plugins.get_mut("ai-chat").expect("ai-chat builtin plugin");
        control.enabled = true;
        control
            .metadata
            .insert("operator".to_owned(), "codex".to_owned());

        store.save(&plugins).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(
            loaded.get("file-transfer").map(|plugin| plugin.enabled),
            Some(true)
        );
        let control = loaded.get("ai-chat").expect("ai-chat loaded");
        assert!(control.enabled);
        assert_eq!(
            control.metadata.get("operator").map(String::as_str),
            Some("codex")
        );
        assert_eq!(
            control.metadata.get("builtin").map(String::as_str),
            Some("true")
        );
    }

    fn test_session(id: &str, status: &str, restartable: Option<bool>) -> SessionRecord {
        let selector = format!("{id}@owner");
        let (command, args) = default_session_command(&selector);
        let mut metadata = HashMap::from([("host".to_owned(), id.to_owned())]);
        if let Some(restartable) = restartable {
            metadata.insert("restartable".to_owned(), restartable.to_string());
        }
        SessionRecord {
            id: id.to_owned(),
            host: id.to_owned(),
            selector,
            status: status.to_owned(),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            command,
            args,
            control: None,
            metadata,
        }
    }

    fn temp_database_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-sessions-{}.db",
            uuid::Uuid::new_v4()
        ))
    }

    fn temp_database() -> Arc<AppDatabase> {
        Arc::new(AppDatabase::open(temp_database_path()).unwrap())
    }

    fn test_app_state() -> AppState {
        AppState::new_for_test(temp_database_path())
    }
}
