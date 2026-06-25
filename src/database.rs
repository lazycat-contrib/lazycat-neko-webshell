use std::collections::HashMap;
use std::fs;
use std::io;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};

use crate::config::{DEFAULT_DATABASE_FILE, ENV_DATABASE_FILE};
use crate::terminal_manager::OutputFrame;

const TO_IO_ERROR: fn(rusqlite::Error) -> io::Error = |err| io::Error::other(err.to_string());

pub const KV_NAMESPACE_STATE: &str = "state";
pub const KV_NAMESPACE_PREFERENCES: &str = "preferences";
pub const KV_KEY_PLUGINS: &str = "plugins";
pub const KV_KEY_SESSIONS: &str = "sessions";
pub const KV_KEY_WORKSPACES: &str = "workspaces";
pub const KV_KEY_SETTINGS: &str = "settings";

#[derive(Clone)]
pub struct AppDatabase {
    conn: Arc<Mutex<Connection>>,
}

impl AppDatabase {
    pub fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).map_err(TO_IO_ERROR)?;
        conn.execute_batch(
            r"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS app_kv (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value BLOB NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                PRIMARY KEY (namespace, key)
            );

            CREATE TABLE IF NOT EXISTS terminal_output_frames (
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                data BLOB NOT NULL,
                PRIMARY KEY (session_id, sequence)
            );

            CREATE TABLE IF NOT EXISTS terminal_output_history_meta (
                session_id TEXT NOT NULL PRIMARY KEY,
                protocol_version TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS herdr_output_sequences (
                session_id TEXT NOT NULL PRIMARY KEY,
                sequence INTEGER NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS tunnel_provider_profiles (
                id TEXT NOT NULL PRIMARY KEY,
                provider TEXT NOT NULL,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                config_json TEXT NOT NULL DEFAULT '{}',
                secret_json TEXT NOT NULL DEFAULT '{}',
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                last_used_at_ms INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_tunnel_provider_profiles_provider
                ON tunnel_provider_profiles(provider);
            ",
        )
        .map_err(TO_IO_ERROR)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn load_kv(&self, namespace: &str, key: &str) -> io::Result<Option<Vec<u8>>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT value FROM app_kv WHERE namespace = ?1 AND key = ?2",
            params![namespace, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(TO_IO_ERROR)
    }

    pub fn store_kv(&self, namespace: &str, key: &str, value: &[u8]) -> io::Result<()> {
        let conn = self.lock()?;
        conn.execute(
            r"
            INSERT INTO app_kv (namespace, key, value, updated_at)
            VALUES (?1, ?2, ?3, unixepoch())
            ON CONFLICT(namespace, key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            ",
            params![namespace, key, value],
        )
        .map(|_| ())
        .map_err(TO_IO_ERROR)
    }

    pub fn delete_kv(&self, namespace: &str, key: &str) -> io::Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "DELETE FROM app_kv WHERE namespace = ?1 AND key = ?2",
            params![namespace, key],
        )
        .map(|_| ())
        .map_err(TO_IO_ERROR)
    }

    pub fn load_output_history(&self, session_id: &str) -> io::Result<Vec<OutputFrame>> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT sequence, data FROM terminal_output_frames WHERE session_id = ?1 ORDER BY sequence",
            )
            .map_err(TO_IO_ERROR)?;
        let rows = stmt
            .query_map(params![session_id], |row| {
                let sequence = row.get::<_, i64>(0)?;
                let data = row.get::<_, Vec<u8>>(1)?;
                Ok((sequence, data))
            })
            .map_err(TO_IO_ERROR)?;
        let mut frames = Vec::new();
        for row in rows {
            let (sequence, data) = row.map_err(TO_IO_ERROR)?;
            frames.push(OutputFrame {
                sequence: u64_from_i64(sequence)?,
                data,
            });
        }
        Ok(frames)
    }

    pub fn load_output_history_protocol_version(
        &self,
        session_id: &str,
    ) -> io::Result<Option<String>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT protocol_version FROM terminal_output_history_meta WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(TO_IO_ERROR)
    }

    pub fn append_output_frame(
        &self,
        session_id: &str,
        frame: &OutputFrame,
        first_retained_sequence: u64,
        protocol_version: &str,
    ) -> io::Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(TO_IO_ERROR)?;
        tx.execute(
            r"
            INSERT OR REPLACE INTO terminal_output_frames (session_id, sequence, data)
            VALUES (?1, ?2, ?3)
            ",
            params![session_id, i64_from_u64(frame.sequence)?, &frame.data],
        )
        .map_err(TO_IO_ERROR)?;
        tx.execute(
            "DELETE FROM terminal_output_frames WHERE session_id = ?1 AND sequence < ?2",
            params![session_id, i64_from_u64(first_retained_sequence)?],
        )
        .map_err(TO_IO_ERROR)?;
        store_output_history_protocol_version_tx(&tx, session_id, protocol_version)?;
        tx.commit().map_err(TO_IO_ERROR)
    }

    pub fn replace_output_history(
        &self,
        session_id: &str,
        frames: &[OutputFrame],
        protocol_version: &str,
    ) -> io::Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(TO_IO_ERROR)?;
        tx.execute(
            "DELETE FROM terminal_output_frames WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(TO_IO_ERROR)?;
        for frame in frames {
            tx.execute(
                r"
                INSERT INTO terminal_output_frames (session_id, sequence, data)
                VALUES (?1, ?2, ?3)
                ",
                params![session_id, i64_from_u64(frame.sequence)?, &frame.data],
            )
            .map_err(TO_IO_ERROR)?;
        }
        store_output_history_protocol_version_tx(&tx, session_id, protocol_version)?;
        tx.commit().map_err(TO_IO_ERROR)
    }

    pub fn delete_output_history(&self, session_id: &str) -> io::Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(TO_IO_ERROR)?;
        tx.execute(
            "DELETE FROM terminal_output_frames WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(TO_IO_ERROR)?;
        tx.execute(
            "DELETE FROM terminal_output_history_meta WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(TO_IO_ERROR)?;
        tx.commit().map_err(TO_IO_ERROR)
    }

    pub fn load_herdr_output_sequence(&self, session_id: &str) -> io::Result<Option<u64>> {
        let conn = self.lock()?;
        let sequence = conn
            .query_row(
                "SELECT sequence FROM herdr_output_sequences WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(TO_IO_ERROR)?;
        sequence.map(u64_from_i64).transpose()
    }

    pub fn store_herdr_output_sequence(&self, session_id: &str, sequence: u64) -> io::Result<u64> {
        let sequence = i64_from_u64(sequence)?;
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(TO_IO_ERROR)?;
        let current = tx
            .query_row(
                "SELECT sequence FROM herdr_output_sequences WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(TO_IO_ERROR)?;
        let next = current.map_or(sequence, |current| current.max(sequence));
        tx.execute(
            r"
            INSERT INTO herdr_output_sequences (session_id, sequence, updated_at)
            VALUES (?1, ?2, unixepoch())
            ON CONFLICT(session_id) DO UPDATE SET
                sequence = excluded.sequence,
                updated_at = excluded.updated_at
            ",
            params![session_id, next],
        )
        .map_err(TO_IO_ERROR)?;
        tx.commit().map_err(TO_IO_ERROR)?;
        u64_from_i64(next)
    }

    pub fn delete_herdr_output_sequence(&self, session_id: &str) -> io::Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "DELETE FROM herdr_output_sequences WHERE session_id = ?1",
            params![session_id],
        )
        .map(|_| ())
        .map_err(TO_IO_ERROR)
    }

    pub fn list_tunnel_provider_profiles(
        &self,
        provider: Option<&str>,
    ) -> io::Result<Vec<TunnelProviderProfile>> {
        let conn = self.lock()?;
        let mut profiles = Vec::new();
        if let Some(provider) = provider {
            let mut stmt = conn
                .prepare(
                    r"
                    SELECT id, provider, name, enabled, config_json, secret_json,
                           created_at_ms, updated_at_ms, last_used_at_ms
                    FROM tunnel_provider_profiles
                    WHERE provider = ?1
                    ORDER BY name COLLATE NOCASE, created_at_ms, id
                    ",
                )
                .map_err(TO_IO_ERROR)?;
            let rows = stmt
                .query_map(params![provider], tunnel_provider_profile_from_row)
                .map_err(TO_IO_ERROR)?;
            for row in rows {
                profiles.push(row.map_err(TO_IO_ERROR)?);
            }
        } else {
            let mut stmt = conn
                .prepare(
                    r"
                    SELECT id, provider, name, enabled, config_json, secret_json,
                           created_at_ms, updated_at_ms, last_used_at_ms
                    FROM tunnel_provider_profiles
                    ORDER BY provider, name COLLATE NOCASE, created_at_ms, id
                    ",
                )
                .map_err(TO_IO_ERROR)?;
            let rows = stmt
                .query_map([], tunnel_provider_profile_from_row)
                .map_err(TO_IO_ERROR)?;
            for row in rows {
                profiles.push(row.map_err(TO_IO_ERROR)?);
            }
        }
        Ok(profiles)
    }

    pub fn load_tunnel_provider_profile(
        &self,
        id: &str,
    ) -> io::Result<Option<TunnelProviderProfile>> {
        let conn = self.lock()?;
        conn.query_row(
            r"
            SELECT id, provider, name, enabled, config_json, secret_json,
                   created_at_ms, updated_at_ms, last_used_at_ms
            FROM tunnel_provider_profiles
            WHERE id = ?1
            ",
            params![id],
            tunnel_provider_profile_from_row,
        )
        .optional()
        .map_err(TO_IO_ERROR)
    }

    pub fn replace_tunnel_provider_profiles(
        &self,
        provider: &str,
        profiles: &[TunnelProviderProfileUpsert],
    ) -> io::Result<()> {
        let now = now_ms();
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(TO_IO_ERROR)?;
        let existing = {
            let mut stmt = tx
                .prepare(
                    r"
                    SELECT id, secret_json, created_at_ms, last_used_at_ms
                    FROM tunnel_provider_profiles
                    WHERE provider = ?1
                    ",
                )
                .map_err(TO_IO_ERROR)?;
            let rows = stmt
                .query_map(params![provider], |row| {
                    let id = row.get::<_, String>(0)?;
                    let created_at_ms = row.get::<_, i64>(2).and_then(|value| {
                        u64_from_i64(value).map_err(|err| {
                            rusqlite::Error::FromSqlConversionFailure(
                                2,
                                rusqlite::types::Type::Integer,
                                Box::new(err),
                            )
                        })
                    })?;
                    let last_used_at_ms = row
                        .get::<_, Option<i64>>(3)?
                        .map(u64_from_i64)
                        .transpose()
                        .map_err(|err| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Integer,
                                Box::new(err),
                            )
                        })?;
                    Ok((
                        id,
                        ExistingTunnelProviderProfile {
                            secret_json: row.get(1)?,
                            created_at_ms,
                            last_used_at_ms,
                        },
                    ))
                })
                .map_err(TO_IO_ERROR)?;
            let mut existing = HashMap::new();
            for row in rows {
                let (id, profile) = row.map_err(TO_IO_ERROR)?;
                existing.insert(id, profile);
            }
            existing
        };

        tx.execute(
            "DELETE FROM tunnel_provider_profiles WHERE provider = ?1",
            params![provider],
        )
        .map_err(TO_IO_ERROR)?;

        for profile in profiles {
            let existing = existing.get(&profile.id);
            let secret_json = profile
                .secret_json
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| existing.map(|profile| profile.secret_json.clone()))
                .unwrap_or_else(|| "{}".to_owned());
            let created_at_ms = existing.map_or(now, |profile| profile.created_at_ms);
            let last_used_at_ms = existing.and_then(|profile| profile.last_used_at_ms);
            tx.execute(
                r"
                INSERT INTO tunnel_provider_profiles (
                    id, provider, name, enabled, config_json, secret_json,
                    created_at_ms, updated_at_ms, last_used_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ",
                params![
                    profile.id,
                    profile.provider,
                    profile.name,
                    if profile.enabled { 1 } else { 0 },
                    profile.config_json,
                    secret_json,
                    i64_from_u64(created_at_ms)?,
                    i64_from_u64(now)?,
                    last_used_at_ms.map(i64_from_u64).transpose()?,
                ],
            )
            .map_err(TO_IO_ERROR)?;
        }
        tx.commit().map_err(TO_IO_ERROR)
    }

    pub fn mark_tunnel_provider_profile_used(&self, id: &str) -> io::Result<()> {
        let conn = self.lock()?;
        conn.execute(
            r"
            UPDATE tunnel_provider_profiles
            SET last_used_at_ms = ?2, updated_at_ms = ?2
            WHERE id = ?1
            ",
            params![id, i64_from_u64(now_ms())?],
        )
        .map(|_| ())
        .map_err(TO_IO_ERROR)
    }

    fn lock(&self) -> io::Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| io::Error::other("database lock poisoned"))
    }
}

#[derive(Clone, Debug)]
pub struct TunnelProviderProfile {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub enabled: bool,
    pub config_json: String,
    pub secret_json: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_used_at_ms: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct TunnelProviderProfileUpsert {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub enabled: bool,
    pub config_json: String,
    pub secret_json: Option<String>,
}

struct ExistingTunnelProviderProfile {
    secret_json: String,
    created_at_ms: u64,
    last_used_at_ms: Option<u64>,
}

pub fn database_path() -> PathBuf {
    std::env::var_os(ENV_DATABASE_FILE)
        .map_or_else(|| PathBuf::from(DEFAULT_DATABASE_FILE), PathBuf::from)
}

#[cfg(test)]
pub fn remove_database_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn i64_from_u64(value: u64) -> io::Result<i64> {
    i64::try_from(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "terminal output sequence exceeds SQLite integer range",
        )
    })
}

fn u64_from_i64(value: i64) -> io::Result<u64> {
    u64::try_from(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "terminal output sequence must not be negative",
        )
    })
}

fn store_output_history_protocol_version_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    protocol_version: &str,
) -> io::Result<()> {
    tx.execute(
        r"
        INSERT INTO terminal_output_history_meta (session_id, protocol_version, updated_at)
        VALUES (?1, ?2, unixepoch())
        ON CONFLICT(session_id) DO UPDATE SET
            protocol_version = excluded.protocol_version,
            updated_at = excluded.updated_at
        ",
        params![session_id, protocol_version],
    )
    .map(|_| ())
    .map_err(TO_IO_ERROR)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn tunnel_provider_profile_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<TunnelProviderProfile> {
    Ok(TunnelProviderProfile {
        id: row.get(0)?,
        provider: row.get(1)?,
        name: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
        config_json: row.get(4)?,
        secret_json: row.get(5)?,
        created_at_ms: u64_from_i64(row.get(6)?).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Integer,
                Box::new(err),
            )
        })?,
        updated_at_ms: u64_from_i64(row.get(7)?).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Integer,
                Box::new(err),
            )
        })?,
        last_used_at_ms: row
            .get::<_, Option<i64>>(8)?
            .map(u64_from_i64)
            .transpose()
            .map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Integer,
                    Box::new(err),
                )
            })?,
    })
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{AppDatabase, TunnelProviderProfileUpsert, remove_database_file};

    fn temp_database() -> (AppDatabase, std::path::PathBuf) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("lazycat-neko-webshell-database-test-{suffix}.db"));
        let _ = remove_database_file(&path);
        let database = AppDatabase::open(path.clone()).expect("test database");
        (database, path)
    }

    #[test]
    fn herdr_output_sequence_cursor_is_monotonic() {
        let (database, path) = temp_database();
        assert_eq!(
            database.load_herdr_output_sequence("session-one").unwrap(),
            None
        );
        assert_eq!(
            database
                .store_herdr_output_sequence("session-one", 8)
                .unwrap(),
            8
        );
        assert_eq!(
            database
                .store_herdr_output_sequence("session-one", 5)
                .unwrap(),
            8
        );
        assert_eq!(
            database
                .store_herdr_output_sequence("session-one", 12)
                .unwrap(),
            12
        );
        assert_eq!(
            database.load_herdr_output_sequence("session-one").unwrap(),
            Some(12)
        );
        database
            .delete_herdr_output_sequence("session-one")
            .unwrap();
        assert_eq!(
            database.load_herdr_output_sequence("session-one").unwrap(),
            None
        );
        drop(database);
        let _ = remove_database_file(&path);
    }

    #[test]
    fn tunnel_provider_profiles_replace_preserves_existing_secret() {
        let (database, path) = temp_database();
        database
            .replace_tunnel_provider_profiles(
                "ngrok",
                &[TunnelProviderProfileUpsert {
                    id: "profile-one".to_owned(),
                    provider: "ngrok".to_owned(),
                    name: "Primary".to_owned(),
                    enabled: true,
                    config_json: "{}".to_owned(),
                    secret_json: Some(r#"{"authtoken":"token-one"}"#.to_owned()),
                }],
            )
            .unwrap();
        let original = database
            .load_tunnel_provider_profile("profile-one")
            .unwrap()
            .expect("profile");
        database
            .mark_tunnel_provider_profile_used("profile-one")
            .unwrap();
        database
            .replace_tunnel_provider_profiles(
                "ngrok",
                &[TunnelProviderProfileUpsert {
                    id: "profile-one".to_owned(),
                    provider: "ngrok".to_owned(),
                    name: "Renamed".to_owned(),
                    enabled: false,
                    config_json: "{}".to_owned(),
                    secret_json: None,
                }],
            )
            .unwrap();

        let updated = database
            .load_tunnel_provider_profile("profile-one")
            .unwrap()
            .expect("profile");
        assert_eq!(updated.name, "Renamed");
        assert!(!updated.enabled);
        assert_eq!(updated.secret_json, r#"{"authtoken":"token-one"}"#);
        assert_eq!(updated.created_at_ms, original.created_at_ms);
        assert!(updated.last_used_at_ms.is_some());

        database
            .replace_tunnel_provider_profiles("ngrok", &[])
            .unwrap();
        assert!(
            database
                .list_tunnel_provider_profiles(Some("ngrok"))
                .unwrap()
                .is_empty()
        );
        drop(database);
        let _ = remove_database_file(&path);
    }
}
