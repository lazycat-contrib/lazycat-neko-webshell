use std::fs;
use std::io;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

            CREATE TABLE IF NOT EXISTS herdr_output_sequences (
                session_id TEXT NOT NULL PRIMARY KEY,
                sequence INTEGER NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
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

    pub fn append_output_frame(
        &self,
        session_id: &str,
        frame: &OutputFrame,
        first_retained_sequence: u64,
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
        tx.commit().map_err(TO_IO_ERROR)
    }

    pub fn replace_output_history(
        &self,
        session_id: &str,
        frames: &[OutputFrame],
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
        tx.commit().map_err(TO_IO_ERROR)
    }

    pub fn delete_output_history(&self, session_id: &str) -> io::Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "DELETE FROM terminal_output_frames WHERE session_id = ?1",
            params![session_id],
        )
        .map(|_| ())
        .map_err(TO_IO_ERROR)
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

    fn lock(&self) -> io::Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| io::Error::other("database lock poisoned"))
    }
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

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{AppDatabase, remove_database_file};

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
}
