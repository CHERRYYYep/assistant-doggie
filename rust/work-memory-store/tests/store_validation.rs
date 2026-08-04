use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use work_memory_store::{SqliteStore, StoreError};

static NEXT_DATABASE_ID: AtomicU64 = AtomicU64::new(0);

struct TemporaryDatabase {
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new(label: &str) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after the Unix epoch")
            .as_nanos();
        let sequence = NEXT_DATABASE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "work-memory-store-{label}-{}-{timestamp}-{sequence}.db",
            std::process::id()
        ));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal"] {
            let candidate = PathBuf::from(format!("{}{suffix}", self.path.display()));
            let _ = fs::remove_file(candidate);
        }
    }
}

#[test]
fn rejects_a_missing_required_table() {
    let database = TemporaryDatabase::new("missing-table");
    let connection = Connection::open(database.path()).expect("test database must open");
    create_buckets_table(&connection);
    drop(connection);

    assert!(matches!(
        SqliteStore::open_read_only(database.path()),
        Err(StoreError::MissingTable("entries"))
    ));
}

#[test]
fn rejects_a_missing_required_column() {
    let database = TemporaryDatabase::new("missing-column");
    let connection = Connection::open(database.path()).expect("test database must open");
    create_buckets_table(&connection);
    connection
        .execute_batch(
            "CREATE TABLE entries (
                id TEXT PRIMARY KEY,
                bucket_id TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                summary TEXT,
                content_type TEXT NOT NULL,
                classification_confidence REAL,
                classification_reason TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .expect("partial entries table must be created");
    drop(connection);

    assert!(matches!(
        SqliteStore::open_read_only(database.path()),
        Err(StoreError::MissingColumn {
            table: "entries",
            column: "moved_from_bucket_id"
        })
    ));
}

#[test]
fn distinguishes_invalid_persisted_values() {
    let database = TemporaryDatabase::new("invalid-values");
    let connection = Connection::open(database.path()).expect("test database must open");
    create_current_tables(&connection);
    insert_bucket(
        &connection,
        "invalid-type",
        "unsupported",
        "active",
        "[]",
        valid_time(),
    );
    insert_bucket(
        &connection,
        "invalid-status",
        "task",
        "unknown",
        "[]",
        valid_time(),
    );
    insert_bucket(
        &connection,
        "invalid-tags",
        "task",
        "active",
        "not-json",
        valid_time(),
    );
    insert_bucket(
        &connection,
        "invalid-time",
        "task",
        "active",
        "[]",
        "yesterday",
    );
    drop(connection);

    let store = SqliteStore::open_read_only(database.path()).expect("schema must be valid");
    assert!(matches!(
        store.get_bucket("invalid-type"),
        Err(StoreError::InvalidBucketType { bucket_id, value })
            if bucket_id == "invalid-type" && value == "unsupported"
    ));
    assert!(matches!(
        store.get_bucket("invalid-status"),
        Err(StoreError::InvalidBucketStatus { bucket_id, value })
            if bucket_id == "invalid-status" && value == "unknown"
    ));
    assert!(matches!(
        store.get_bucket("invalid-tags"),
        Err(StoreError::InvalidJson {
            table: "buckets",
            column: "tags",
            record_id,
            ..
        }) if record_id == "invalid-tags"
    ));
    assert!(matches!(
        store.get_bucket("invalid-time"),
        Err(StoreError::InvalidTimestamp {
            table: "buckets",
            column: "created_at",
            record_id,
            value
        }) if record_id == "invalid-time" && value == "yesterday"
    ));
}

fn create_current_tables(connection: &Connection) {
    create_buckets_table(connection);
    connection
        .execute_batch(
            "CREATE TABLE entries (
                id TEXT PRIMARY KEY,
                bucket_id TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                summary TEXT,
                content_type TEXT NOT NULL,
                classification_confidence REAL,
                classification_reason TEXT,
                created_at TEXT NOT NULL,
                moved_from_bucket_id TEXT
            );",
        )
        .expect("entries table must be created");
}

fn create_buckets_table(connection: &Connection) {
    connection
        .execute_batch(
            "CREATE TABLE buckets (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                type TEXT NOT NULL,
                status TEXT NOT NULL,
                summary TEXT NOT NULL,
                tags TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL
            );",
        )
        .expect("buckets table must be created");
}

fn insert_bucket(
    connection: &Connection,
    id: &str,
    bucket_type: &str,
    status: &str,
    tags: &str,
    created_at: &str,
) {
    connection
        .execute(
            "INSERT INTO buckets (
                id, title, type, status, summary, tags,
                created_at, updated_at, last_active_at
             ) VALUES (?1, 'Fixture', ?2, ?3, '', ?4, ?5, ?6, ?6)",
            params![id, bucket_type, status, tags, created_at, valid_time()],
        )
        .expect("fixture bucket must be inserted");
}

const fn valid_time() -> &'static str {
    "2026-08-04 10:20:00.000000"
}
