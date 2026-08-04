use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use work_memory_store::{StoreError, UpdateBucketSummaryRequest, WritableSqliteStore};

const BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const INITIAL_SUMMARY: &str = "Investigating callback failures.";
const SHORT_FRAGMENT: &str = "Newest standalone summary fragment.";
const LONG_FRAGMENT: &str = "Standalone summary update with enough detail to exercise the bounded rolling summary behavior safely.";
const MAX_CHARS: usize = 100;
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
            "work-memory-bucket-summary-{label}-{}-{timestamp}-{sequence}.db",
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

#[derive(Debug, PartialEq, Eq)]
struct BucketStableSnapshot {
    title: String,
    bucket_type: String,
    status: String,
    tags_json: String,
    created_at: String,
    last_active_at: String,
}

#[test]
fn update_bucket_summary_request_matches_python_normalization_and_validation() {
    let requested_id = format!(" {BUCKET_ID} ");
    let request = UpdateBucketSummaryRequest::with_max_chars(
        &requested_id,
        format!("  {SHORT_FRAGMENT}  "),
        MAX_CHARS,
    )
    .unwrap();
    assert_eq!(request.bucket_id(), requested_id);
    assert_eq!(request.entry_summary(), SHORT_FRAGMENT);
    assert_eq!(request.max_chars(), MAX_CHARS);

    let default_request = UpdateBucketSummaryRequest::new(BUCKET_ID, SHORT_FRAGMENT).unwrap();
    assert_eq!(default_request.max_chars(), 1_200);

    assert!(matches!(
        UpdateBucketSummaryRequest::with_max_chars(BUCKET_ID, "   ", 99),
        Err(StoreError::InvalidWriteField {
            field: "entry_summary",
            reason: "must not be empty",
        })
    ));
    assert!(matches!(
        UpdateBucketSummaryRequest::with_max_chars(BUCKET_ID, SHORT_FRAGMENT, 99),
        Err(StoreError::InvalidWriteField {
            field: "max_chars",
            reason: "must be at least 100",
        })
    ));
}

#[test]
fn update_bucket_summary_deduplicates_and_changes_only_the_bucket_cache() {
    let database = create_python_fixture("complete");
    let before_counts = table_row_counts(database.path());
    let stable_before = bucket_stable_snapshot(database.path());
    let (_, updated_before) = bucket_summary_and_updated_at(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let request =
        UpdateBucketSummaryRequest::new(BUCKET_ID, format!("  {SHORT_FRAGMENT}  ")).unwrap();
    let expected = format!("{INITIAL_SUMMARY}\n{SHORT_FRAGMENT}");
    assert_eq!(store.update_bucket_summary(&request).unwrap(), expected);

    let duplicate =
        UpdateBucketSummaryRequest::new(BUCKET_ID, "  newest   STANDALONE summary fragment.  ")
            .unwrap();
    assert_eq!(store.update_bucket_summary(&duplicate).unwrap(), expected);
    drop(store);

    let (summary_after, updated_after) = bucket_summary_and_updated_at(database.path());
    assert_eq!(summary_after, expected);
    assert_ne!(updated_after, updated_before);
    assert_eq!(bucket_stable_snapshot(database.path()), stable_before);
    assert_eq!(table_row_counts(database.path()), before_counts);
}

#[test]
fn update_bucket_summary_applies_the_python_character_bound() {
    let database = create_python_fixture("bounded");
    let stable_before = bucket_stable_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let summary = store.update_bucket_summary(&bounded_request()).unwrap();
    drop(store);

    assert_eq!(summary.chars().count(), MAX_CHARS);
    assert!(summary.starts_with(&format!("{INITIAL_SUMMARY}\n")));
    assert!(summary.ends_with('…'));
    assert_eq!(bucket_summary_and_updated_at(database.path()).0, summary);
    assert_eq!(bucket_stable_snapshot(database.path()), stable_before);
}

#[test]
fn update_bucket_summary_preserves_exact_bucket_id_and_missing_target_changes_nothing() {
    let database = create_python_fixture("missing");
    let before = business_snapshot(database.path());
    let requested_id = format!(" {BUCKET_ID} ");
    let request = UpdateBucketSummaryRequest::new(&requested_id, SHORT_FRAGMENT).unwrap();
    assert_eq!(request.bucket_id(), requested_id);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.update_bucket_summary(&request),
        Err(StoreError::MissingRecord {
            table: "buckets",
            ref id,
        }) if id == &requested_id
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn bucket_summary_update_failure_rolls_back_without_business_changes() {
    let database = create_python_fixture("rollback");
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_bucket_summary_update
             BEFORE UPDATE OF summary ON buckets
             WHEN OLD.id = '11111111-1111-1111-1111-111111111111'
             BEGIN
                 SELECT RAISE(ABORT, 'fixture rejects bucket summary update');
             END;",
        )
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.update_bucket_summary(&bounded_request()),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_bucket_summary_update_matches_python_service_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    let python_stable_before = bucket_stable_snapshot(python_database.path());
    let rust_stable_before = bucket_stable_snapshot(rust_database.path());
    run_python_summary_fixture(python_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    let rust_summary = store.update_bucket_summary(&bounded_request()).unwrap();
    drop(store);

    assert_eq!(
        rust_summary,
        bucket_summary_and_updated_at(python_database.path()).0
    );
    assert_eq!(
        bucket_summary_and_updated_at(rust_database.path()).0,
        bucket_summary_and_updated_at(python_database.path()).0
    );
    assert_eq!(
        bucket_stable_snapshot(python_database.path()),
        python_stable_before
    );
    assert_eq!(
        bucket_stable_snapshot(rust_database.path()),
        rust_stable_before
    );
    assert_eq!(
        table_row_counts(rust_database.path()),
        table_row_counts(python_database.path())
    );
}

fn bounded_request() -> UpdateBucketSummaryRequest {
    UpdateBucketSummaryRequest::with_max_chars(BUCKET_ID, format!("  {LONG_FRAGMENT}  "), MAX_CHARS)
        .unwrap()
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
    );
    database
}

fn run_python_summary_fixture(database_path: &Path) {
    run_python_script(
        "tests/fixtures/apply_bucket_summary_update_fixture.py",
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

fn bucket_summary_and_updated_at(path: &Path) -> (String, String) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT summary, updated_at FROM buckets WHERE id = ?1",
            [BUCKET_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

fn bucket_stable_snapshot(path: &Path) -> BucketStableSnapshot {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT title, type, status, tags, created_at, last_active_at
             FROM buckets
             WHERE id = ?1",
            [BUCKET_ID],
            |row| {
                Ok(BucketStableSnapshot {
                    title: row.get(0)?,
                    bucket_type: row.get(1)?,
                    status: row.get(2)?,
                    tags_json: row.get(3)?,
                    created_at: row.get(4)?,
                    last_active_at: row.get(5)?,
                })
            },
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
