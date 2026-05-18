use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::{fs, io};

use buffa::MessageField;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::config::{
    DEFAULT_SESSION_STATE_FILE, LIGHTOSCTL, MAX_COLS, MAX_ROWS, SHELL_BOOTSTRAP_SCRIPT,
};
use crate::proto::lazycat::webshell::v1::{ControlLease, PluginDescriptor, Session};
use crate::terminal_manager::{OutputBuffer, TerminalRegistry, TerminalSpec};
use crate::validation::{normalize_output_frame_limit, validate_selector, validate_size};
use crate::workspace::{WorkspaceRecord, WorkspaceStore, default_workspace_store};

const METADATA_RESTARTABLE: &str = "restartable";
const METADATA_HOST: &str = "host";
const METADATA_OUTPUT_BUFFER_LIMIT: &str = "outputBufferLimit";

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    pub plugins: Arc<RwLock<HashMap<String, PluginRecord>>>,
    pub terminals: Arc<TerminalRegistry>,
    output_buffers: Arc<RwLock<HashMap<String, Arc<OutputBuffer>>>>,
    session_store: Arc<SessionStore>,
    pub workspaces: Arc<RwLock<HashMap<String, WorkspaceRecord>>>,
    workspace_store: Arc<WorkspaceStore>,
}

impl AppState {
    pub fn new() -> Self {
        let session_store = Arc::new(SessionStore::new(session_state_path()));
        let workspace_store = Arc::new(default_workspace_store());
        let workspaces = workspace_store.load().unwrap_or_else(|err| {
            warn!(error = %err, "failed to load persisted terminal workspaces");
            HashMap::new()
        });
        let mut sessions = session_store.load().unwrap_or_else(|err| {
            warn!(error = %err, "failed to load persisted terminal sessions");
            HashMap::new()
        });
        prune_unreferenced_sessions(&mut sessions, &workspaces);
        if let Err(err) = session_store.save(&sessions) {
            warn!(error = %err, "failed to prune unreferenced terminal sessions");
        }
        Self {
            sessions: Arc::new(RwLock::new(sessions)),
            plugins: Arc::new(RwLock::new(builtin_plugins())),
            terminals: Arc::new(TerminalRegistry::new()),
            output_buffers: Arc::new(RwLock::new(HashMap::new())),
            session_store,
            workspaces: Arc::new(RwLock::new(workspaces)),
            workspace_store,
        }
    }

    pub fn persist_sessions_snapshot(
        &self,
        sessions: &HashMap<String, SessionRecord>,
    ) -> io::Result<()> {
        self.session_store.save(sessions)
    }

    pub fn persist_workspaces_snapshot(
        &self,
        workspaces: &HashMap<String, WorkspaceRecord>,
    ) -> io::Result<()> {
        self.workspace_store.save(workspaces)
    }

    pub fn output_buffer(&self, session_id: &str, limit: usize) -> Arc<OutputBuffer> {
        let normalized_limit = normalize_output_frame_limit(Some(limit));
        let buffer = self
            .output_buffers
            .write()
            .expect("terminal output buffer registry poisoned")
            .entry(session_id.to_owned())
            .or_insert_with(|| Arc::new(OutputBuffer::new(normalized_limit)))
            .clone();
        buffer.set_limit(normalized_limit);
        buffer
    }

    pub fn remove_output_buffer(&self, session_id: &str) {
        if let Ok(mut buffers) = self.output_buffers.write() {
            buffers.remove(session_id);
        }
    }
}

fn prune_unreferenced_sessions(
    sessions: &mut HashMap<String, SessionRecord>,
    workspaces: &HashMap<String, WorkspaceRecord>,
) {
    let referenced = workspaces
        .values()
        .flat_map(|workspace| &workspace.tabs)
        .flat_map(|tab| &tab.panes)
        .map(|pane| pane.session_id.as_str())
        .collect::<HashSet<_>>();
    sessions.retain(|session_id, _| referenced.contains(session_id.as_str()));
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
        if self.command.trim().is_empty() {
            let (command, args) = default_session_command(&self.selector);
            self.command = command;
            self.args = args;
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

pub fn mark_session_status(state: &AppState, session_id: &str, status: &str) {
    let snapshot = {
        let Ok(mut sessions) = state.sessions.write() else {
            return;
        };
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        status.clone_into(&mut session.status);
        sessions.clone()
    };
    if let Err(err) = state.persist_sessions_snapshot(&snapshot) {
        warn!(error = %err, "failed to persist terminal session status");
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedSessionState {
    version: u32,
    sessions: Vec<SessionRecord>,
}

struct SessionStore {
    path: PathBuf,
}

impl SessionStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn load(&self) -> io::Result<HashMap<String, SessionRecord>> {
        match fs::read(&self.path) {
            Ok(bytes) => {
                let sessions = Self::decode(&bytes)?;
                if let Err(err) = self.save(&sessions) {
                    warn!(error = %err, "failed to prune persisted terminal sessions");
                }
                Ok(sessions)
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(err) => Err(err),
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

    fn save(&self, sessions: &HashMap<String, SessionRecord>) -> io::Result<()> {
        let sessions = persistable_sessions(sessions);
        if sessions.is_empty() {
            return remove_session_file(&self.path);
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let persisted = PersistedSessionState {
            version: 1,
            sessions,
        };
        let bytes = serde_json::to_vec_pretty(&persisted)
            .map_err(|err| io::Error::other(err.to_string()))?;
        let temp = temp_path_for(&self.path);
        fs::write(&temp, bytes)?;
        fs::rename(temp, &self.path)?;
        Ok(())
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

fn remove_session_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
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

fn session_state_path() -> PathBuf {
    std::env::var_os("PURE_TERMINAL_SESSION_STATE_FILE")
        .map_or_else(|| PathBuf::from(DEFAULT_SESSION_STATE_FILE), PathBuf::from)
}

fn temp_path_for(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("sessions.json");
    path.with_file_name(format!("{filename}.tmp"))
}

pub fn host_from_selector(selector: &str) -> String {
    selector
        .split_once('@')
        .map_or(selector, |(host, _)| host)
        .trim()
        .to_owned()
}

pub fn session_id_for_host(host: &str) -> String {
    let mut clean = host
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '-') {
                char
            } else {
                '-'
            }
        })
        .collect::<String>();
    clean.truncate(64);
    let clean = clean.trim_matches('-');
    let prefix = if clean.is_empty() { "host" } else { clean };
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

pub fn default_session_command(selector: &str) -> (String, Vec<String>) {
    (
        LIGHTOSCTL.to_owned(),
        vec![
            "exec".to_owned(),
            "-ti".to_owned(),
            selector.to_owned(),
            "/bin/sh".to_owned(),
            "-lc".to_owned(),
            SHELL_BOOTSTRAP_SCRIPT.to_owned(),
        ],
    )
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
            description: "Generic adapter placeholder for sz/rz and tssh-style uploads and downloads.".to_owned(),
            scopes: vec!["session".to_owned(), "filesystem".to_owned()],
            accepted_content_types: vec![
                "application/json".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            produced_content_types: vec![
                "application/json".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            input_schema_json: r#"{"operation":"upload|download|attach","path":"string","transport":"sz-rz|tssh|custom","payload":"bytes"}"#.to_owned(),
            output_schema_json: r#"{"jobId":"string","status":"queued|running|complete|failed","message":"string"}"#.to_owned(),
            enabled: true,
            metadata: HashMap::from([
                ("builtin".to_owned(), "true".to_owned()),
                ("stage".to_owned(), "reserved".to_owned()),
            ]),
        },
        PluginRecord {
            id: "ai-control".to_owned(),
            kind: "control".to_owned(),
            display_name: "AI Shell Control".to_owned(),
            description: "Generic control plugin placeholder for future AI-assisted shell delegation and supervision.".to_owned(),
            scopes: vec!["session".to_owned(), "control".to_owned()],
            accepted_content_types: vec!["application/json".to_owned()],
            produced_content_types: vec!["application/json".to_owned()],
            input_schema_json: r#"{"mode":"observe|suggest|operate","leaseId":"string","prompt":"string"}"#.to_owned(),
            output_schema_json: r#"{"invocationId":"string","status":"accepted|running|complete|failed"}"#.to_owned(),
            enabled: false,
            metadata: HashMap::from([
                ("builtin".to_owned(), "true".to_owned()),
                ("stage".to_owned(), "reserved".to_owned()),
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

    #[test]
    fn load_keeps_non_restartable_sessions_as_stopped() {
        let path = temp_session_path();
        let store = SessionStore::new(path.clone());
        let persisted = PersistedSessionState {
            version: 1,
            sessions: vec![
                test_session("keep", "running", Some(true)),
                test_session("keep-non-restartable", "running", Some(false)),
                test_session("legacy-default", "running", None),
            ],
        };
        fs::write(&path, serde_json::to_vec(&persisted).unwrap()).unwrap();

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
        let persisted =
            serde_json::from_slice::<PersistedSessionState>(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted.sessions.len(), 3);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn save_keeps_non_restartable_session_records() {
        let path = temp_session_path();
        let store = SessionStore::new(path.clone());
        fs::write(&path, b"stale").unwrap();
        let sessions = HashMap::from([(
            "drop".to_owned(),
            test_session("drop", "running", Some(false)),
        )]);

        store.save(&sessions).unwrap();

        let persisted =
            serde_json::from_slice::<PersistedSessionState>(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted.sessions.len(), 1);
        assert_eq!(persisted.sessions[0].id, "drop");
        assert_eq!(
            persisted.sessions[0]
                .metadata
                .get("restartable")
                .map(String::as_str),
            Some("false")
        );

        let _ = fs::remove_file(path);
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
    fn output_buffers_are_session_scoped_until_removed() {
        let state = test_app_state();

        let first = state.output_buffer("session-one", 128);
        let second = state.output_buffer("session-one", 512);
        let other = state.output_buffer("session-two", 128);

        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &other));

        state.remove_output_buffer("session-one");
        let recreated = state.output_buffer("session-one", 128);

        assert!(!Arc::ptr_eq(&first, &recreated));
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

    fn temp_session_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "lazycat-neko-webshell-sessions-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    fn test_app_state() -> AppState {
        AppState {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            plugins: Arc::new(RwLock::new(HashMap::new())),
            terminals: Arc::new(TerminalRegistry::new()),
            output_buffers: Arc::new(RwLock::new(HashMap::new())),
            session_store: Arc::new(SessionStore::new(temp_session_path())),
            workspaces: Arc::new(RwLock::new(HashMap::new())),
            workspace_store: Arc::new(WorkspaceStore::new(temp_session_path())),
        }
    }
}
