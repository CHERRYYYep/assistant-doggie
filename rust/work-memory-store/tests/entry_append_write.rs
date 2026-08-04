use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use work_memory_store::{AppendEntryRequest, StoreError, WritableSqliteStore};

const BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const RAW_TEXT: &str = "R2k standalone entry.";
const SUMMARY: &str = "Standalone entry summary.";
const CONTENT_TYPE: &str = "log";
const CONFIDENCE: f64 = 0.82;
const REASON: &str = "Explicit standalone append.";
const BUSINESS_TABLES: &[&str] = &[
    "buckets",
    "entries",
    "todos",
    "evidences",
    "timeline_events",
    "decisions",
    "classification_records",
    "corrections",
    "chat_messages",
];
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
            "work-memory-entry-append-{label}-{}-{timestamp}-{sequence}.db",
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
        for suffix in ["", "-shm", "-wal", "-journal"] {
            let candidate = PathBuf::from(format!("{}{suffix}", self.path.display()));
            let _ = fs::remove_file(candidate);
        }
    }
}

#[derive(Debug, PartialEq)]
struct EntrySemanticSnapshot {
    bucket_id: String,
    raw_text: String,
    summary: Option<String>,
    content_type: String,
    confidence: Option<f64>,
    reason: Option<String>,
    moved_from_bucket_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct BucketStableSnapshot {
    title: String,
    bucket_type: String,
    status: String,
    summary: String,
    tags_json: String,
    created_at: String,
}

#[test]
fn append_entry_request_matches_python_normalization_and_validation() {
    let request = AppendEntryRequest::new(
        format!(" {BUCKET_ID} "),
        format!("  {RAW_TEXT}  "),
        Some("   ".to_owned()),
        " log ",
        Some(CONFIDENCE),
        Some("   ".to_owned()),
    )
    .unwrap();
    assert_eq!(request.bucket_id(), format!(" {BUCKET_ID} "));
    assert_eq!(request.raw_text(), RAW_TEXT);
    assert_eq!(request.summary(), Some(""));
    assert_eq!(request.content_type(), CONTENT_TYPE);
    assert_eq!(request.classification_confidence(), Some(CONFIDENCE));
    assert_eq!(request.classification_reason(), Some(""));

    let empty_optionals = AppendEntryRequest::new(
        BUCKET_ID,
        RAW_TEXT,
        Some(String::new()),
        "note",
        None,
        Some(String::new()),
    )
    .unwrap();
    assert_eq!(empty_optionals.summary(), None);
    assert_eq!(empty_optionals.classification_reason(), None);

    for confidence in [-0.1, 1.1, f64::NAN] {
        assert!(matches!(
            AppendEntryRequest::new(BUCKET_ID, RAW_TEXT, None, "note", Some(confidence), None,),
            Err(StoreError::InvalidWriteField {
                field: "classification_confidence",
                reason: "must be between 0 and 1",
            })
        ));
    }
    for (raw_text, content_type, field) in [
        ("   ", "note", "raw_text"),
        (RAW_TEXT, "   ", "content_type"),
    ] {
        assert!(matches!(
            AppendEntryRequest::new(BUCKET_ID, raw_text, None, content_type, None, None),
            Err(StoreError::InvalidWriteField {
                field: actual_field,
                reason: "must not be empty",
            }) if actual_field == field
        ));
    }
}

#[test]
fn append_entry_persists_one_entry_and_only_refreshes_bucket_activity() {
    let database = create_python_fixture("complete");
    let before_counts = table_row_counts(database.path());
    let bucket_before = bucket_stable_snapshot(database.path());
    let activity_before = bucket_activity(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let entry = store.append_entry(&standalone_request()).unwrap();
    assert_uuid_v4(&entry.id);
    assert_eq!(entry.bucket_id, BUCKET_ID);
    assert_eq!(entry.raw_text, RAW_TEXT);
    assert_eq!(entry.summary.as_deref(), Some(SUMMARY));
    assert_eq!(entry.content_type, CONTENT_TYPE);
    assert_eq!(entry.classification_confidence, Some(CONFIDENCE));
    assert_eq!(entry.classification_reason.as_deref(), Some(REASON));
    assert_eq!(entry.moved_from_bucket_id, None);
    drop(store);

    assert_eq!(bucket_stable_snapshot(database.path()), bucket_before);
    let activity_after = bucket_activity(database.path());
    assert_ne!(activity_after, activity_before);
    assert_eq!(activity_after.0, entry.created_at.raw());
    assert_eq!(activity_after.1, entry.created_at.raw());
    assert_eq!(
        entry_semantic_snapshot(database.path()),
        standalone_snapshot()
    );

    let after_counts = table_row_counts(database.path());
    for table in BUSINESS_TABLES {
        let expected = before_counts[*table] + i64::from(*table == "entries");
        assert_eq!(after_counts[*table], expected, "table {table}");
    }
}

#[test]
fn append_entry_preserves_exact_bucket_id_and_missing_bucket_changes_nothing() {
    let database = create_python_fixture("missing");
    let before = business_snapshot(database.path());
    let requested_id = format!(" {BUCKET_ID} ");
    let request =
        AppendEntryRequest::new(&requested_id, RAW_TEXT, None, "note", None, None).unwrap();
    assert_eq!(request.bucket_id(), requested_id);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.append_entry(&request),
        Err(StoreError::MissingRecord {
            table: "buckets",
            ref id,
        }) if id == &requested_id
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn late_bucket_activity_failure_rolls_back_the_inserted_entry() {
    let database = create_python_fixture("rollback");
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_entry_activity_refresh
             BEFORE UPDATE OF updated_at ON buckets
             WHEN OLD.id = '11111111-1111-1111-1111-111111111111'
             BEGIN
                 SELECT RAISE(ABORT, 'fixture rejects bucket activity refresh');
             END;",
        )
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.append_entry(&standalone_request()),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_entry_append_matches_python_service_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    run_python_append_fixture(python_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    let rust_entry = store.append_entry(&standalone_request()).unwrap();
    assert_uuid_v4(&rust_entry.id);
    drop(store);

    let python_entry_id = entry_id_by_raw_text(python_database.path());
    assert_uuid_v4(&python_entry_id);
    assert_eq!(
        entry_semantic_snapshot(rust_database.path()),
        entry_semantic_snapshot(python_database.path())
    );
    assert_eq!(
        bucket_stable_snapshot(rust_database.path()),
        bucket_stable_snapshot(python_database.path())
    );
    for path in [python_database.path(), rust_database.path()] {
        let entry_created_at = entry_created_at(path);
        let activity = bucket_activity(path);
        assert_eq!(activity.0, entry_created_at);
        assert_eq!(activity.1, entry_created_at);
    }
    assert_eq!(
        table_row_counts(rust_database.path()),
        table_row_counts(python_database.path())
    );
}

fn standalone_request() -> AppendEntryRequest {
    AppendEntryRequest::new(
        BUCKET_ID,
        format!("  {RAW_TEXT}  "),
        Some(format!("  {SUMMARY}  ")),
        format!("  {CONTENT_TYPE}  "),
        Some(CONFIDENCE),
        Some(format!("  {REASON}  ")),
    )
    .unwrap()
}

fn standalone_snapshot() -> EntrySemanticSnapshot {
    EntrySemanticSnapshot {
        bucket_id: BUCKET_ID.to_owned(),
        raw_text: RAW_TEXT.to_owned(),
        summary: Some(SUMMARY.to_owned()),
        content_type: CONTENT_TYPE.to_owned(),
        confidence: Some(CONFIDENCE),
        reason: Some(REASON.to_owned()),
        moved_from_bucket_id: None,
    }
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
    );
    database
}

fn run_python_append_fixture(database_path: &Path) {
    run_python_script(
        "tests/fixtures/apply_entry_append_fixture.py",
        database_path,
    );
}

fn run_python_script(relative_script: &str, database_path: &Path) {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let virtualenv_python = repository_root.join(".venv/bin/python");
    let python = if virtualenv_python.is_file() {
        virtualenv_python
    } else {
        PathBuf::from("python3")
    };
    let output = Command::new(python)
        .arg(repository_root.join(relative_script))
        .arg(database_path)
        .env("PYTHONPATH", &repository_root)
        .current_dir(&repository_root)
        .output()
        .expect("Python fixture helper must start");
    assert!(
        output.status.success(),
        "Python fixture helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn entry_id_by_raw_text(path: &Path) -> String {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT id FROM entries WHERE bucket_id = ?1 AND raw_text = ?2",
            [BUCKET_ID, RAW_TEXT],
            |row| row.get(0),
        )
        .unwrap()
}

fn entry_created_at(path: &Path) -> String {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT created_at FROM entries WHERE bucket_id = ?1 AND raw_text = ?2",
            [BUCKET_ID, RAW_TEXT],
            |row| row.get(0),
        )
        .unwrap()
}

fn entry_semantic_snapshot(path: &Path) -> EntrySemanticSnapshot {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT bucket_id, raw_text, summary, content_type,
                    classification_confidence, classification_reason,
                    moved_from_bucket_id
             FROM entries
             WHERE bucket_id = ?1 AND raw_text = ?2",
            [BUCKET_ID, RAW_TEXT],
            |row| {
                Ok(EntrySemanticSnapshot {
                    bucket_id: row.get(0)?,
                    raw_text: row.get(1)?,
                    summary: row.get(2)?,
                    content_type: row.get(3)?,
                    confidence: row.get(4)?,
                    reason: row.get(5)?,
                    moved_from_bucket_id: row.get(6)?,
                })
            },
        )
        .unwrap()
}

fn bucket_stable_snapshot(path: &Path) -> BucketStableSnapshot {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT title, type, status, summary, tags, created_at
             FROM buckets
             WHERE id = ?1",
            [BUCKET_ID],
            |row| {
                Ok(BucketStableSnapshot {
                    title: row.get(0)?,
                    bucket_type: row.get(1)?,
                    status: row.get(2)?,
                    summary: row.get(3)?,
                    tags_json: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .unwrap()
}

fn bucket_activity(path: &Path) -> (String, String) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT updated_at, last_active_at FROM buckets WHERE id = ?1",
            [BUCKET_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

fn table_row_counts(path: &Path) -> BTreeMap<String, i64> {
    let connection = Connection::open(path).unwrap();
    BUSINESS_TABLES
        .iter()
        .map(|table| {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let count = connection.query_row(&sql, [], |row| row.get(0)).unwrap();
            ((*table).to_owned(), count)
        })
        .collect()
}

fn business_snapshot(path: &Path) -> BTreeMap<String, Vec<Vec<SqlValue>>> {
    let connection = Connection::open(path).unwrap();
    BUSINESS_TABLES
        .iter()
        .map(|table| {
            let sql = format!("SELECT * FROM {table} ORDER BY id");
            let mut statement = connection.prepare(&sql).unwrap();
            let column_count = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..column_count)
                        .map(|index| row.get::<_, SqlValue>(index))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            ((*table).to_owned(), rows)
        })
        .collect()
}

fn assert_uuid_v4(value: &str) {
    assert_eq!(value.len(), 36);
    assert_eq!(value.as_bytes()[8], b'-');
    assert_eq!(value.as_bytes()[13], b'-');
    assert_eq!(value.as_bytes()[18], b'-');
    assert_eq!(value.as_bytes()[23], b'-');
    assert_eq!(value.as_bytes()[14], b'4');
    assert!(matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    assert!(
        value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
    );
}
