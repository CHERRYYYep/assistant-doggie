use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params};
use work_memory_store::{RebuildBucketSummaryRequest, StoreError, WritableSqliteStore};

const BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const EMPTY_BUCKET_ID: &str = "33333333-3333-3333-3333-333333333333";
const SINGLE_SUMMARY_BUCKET_ID: &str = "22222222-2222-2222-2222-222222222222";
const MAX_ENTRIES: i64 = 4;
const MAX_CHARS: i64 = 1_200;
const EXPECTED_SUMMARY: &str = "Duplicate fact\nNewest fact";
const SUMMARY_ENTRY_FIXTURES: &[(&str, &str, &str, &str)] = &[
    (
        "12121212-1212-4121-8121-121212121212",
        "Older duplicate summary",
        "  Duplicate fact  ",
        "2026-08-04 13:00:00.000000",
    ),
    (
        "13131313-1313-4131-8131-131313131313",
        "Newer duplicate summary",
        "Duplicate fact",
        "2026-08-04 14:00:00.000000",
    ),
    (
        "14141414-1414-4141-8141-141414141414",
        "Whitespace-only summary",
        "   ",
        "2026-08-04 15:00:00.000000",
    ),
    (
        "15151515-1515-4151-8151-151515151515",
        "Newest summary",
        "Newest fact",
        "2026-08-04 16:00:00.000000",
    ),
];
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
            "work-memory-bucket-summary-rebuild-{label}-{}-{timestamp}-{sequence}.db",
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
fn rebuild_bucket_summary_request_matches_python_limits_and_exact_id() {
    let requested_id = format!(" {BUCKET_ID} ");
    let request = RebuildBucketSummaryRequest::with_limits(&requested_id, MAX_ENTRIES, -1).unwrap();
    assert_eq!(request.bucket_id(), requested_id);
    assert_eq!(request.max_entries(), MAX_ENTRIES);
    assert_eq!(request.max_chars(), -1);

    let defaults = RebuildBucketSummaryRequest::new(BUCKET_ID).unwrap();
    assert_eq!(defaults.max_entries(), 8);
    assert_eq!(defaults.max_chars(), 1_200);

    for max_entries in [0, -1] {
        assert!(matches!(
            RebuildBucketSummaryRequest::with_limits(BUCKET_ID, max_entries, MAX_CHARS),
            Err(StoreError::InvalidWriteField {
                field: "max_entries",
                reason: "must be at least 1",
            })
        ));
    }
}

#[test]
fn rebuild_bucket_summary_uses_newest_limited_cleaned_exact_unique_fragments() {
    let database = create_python_fixture("complete");
    seed_summary_entries(database.path());
    let before_counts = table_row_counts(database.path());
    let stable_before = bucket_stable_snapshot(database.path(), BUCKET_ID);
    let (_, updated_before) = bucket_summary_and_updated_at(database.path(), BUCKET_ID);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let summary = store
        .rebuild_bucket_summary(&rebuild_request(BUCKET_ID))
        .unwrap();
    drop(store);

    assert_eq!(summary, EXPECTED_SUMMARY);
    let (persisted_summary, updated_after) =
        bucket_summary_and_updated_at(database.path(), BUCKET_ID);
    assert_eq!(persisted_summary, EXPECTED_SUMMARY);
    assert_ne!(updated_after, updated_before);
    assert_eq!(
        bucket_stable_snapshot(database.path(), BUCKET_ID),
        stable_before
    );
    assert_eq!(table_row_counts(database.path()), before_counts);
}

#[test]
fn rebuild_bucket_summary_clears_a_stale_cache_when_no_entry_summaries_survive() {
    let database = create_python_fixture("empty");
    let stable_before = bucket_stable_snapshot(database.path(), EMPTY_BUCKET_ID);
    assert_ne!(
        bucket_summary_and_updated_at(database.path(), EMPTY_BUCKET_ID).0,
        ""
    );
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let summary = store
        .rebuild_bucket_summary(&RebuildBucketSummaryRequest::new(EMPTY_BUCKET_ID).unwrap())
        .unwrap();
    drop(store);

    assert_eq!(summary, "");
    assert_eq!(
        bucket_summary_and_updated_at(database.path(), EMPTY_BUCKET_ID).0,
        ""
    );
    assert_eq!(
        bucket_stable_snapshot(database.path(), EMPTY_BUCKET_ID),
        stable_before
    );
}

#[test]
fn rebuild_bucket_summary_preserves_python_unvalidated_max_chars_slicing() {
    let database = create_python_fixture("python-slice");
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let zero_limit =
        RebuildBucketSummaryRequest::with_limits(SINGLE_SUMMARY_BUCKET_ID, 1, 0).unwrap();
    assert_eq!(
        store.rebuild_bucket_summary(&zero_limit).unwrap(),
        "Prepare review…"
    );

    let negative_limit =
        RebuildBucketSummaryRequest::with_limits(SINGLE_SUMMARY_BUCKET_ID, 1, -100).unwrap();
    assert_eq!(store.rebuild_bucket_summary(&negative_limit).unwrap(), "…");
}

#[test]
fn rebuild_bucket_summary_preserves_exact_bucket_id_and_missing_target_changes_nothing() {
    let database = create_python_fixture("missing");
    let before = business_snapshot(database.path());
    let requested_id = format!(" {BUCKET_ID} ");
    let request = RebuildBucketSummaryRequest::new(&requested_id).unwrap();
    assert_eq!(request.bucket_id(), requested_id);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.rebuild_bucket_summary(&request),
        Err(StoreError::MissingRecord {
            table: "buckets",
            ref id,
        }) if id == &requested_id
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn bucket_summary_rebuild_failure_rolls_back_without_business_changes() {
    let database = create_python_fixture("rollback");
    seed_summary_entries(database.path());
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_bucket_summary_rebuild
             BEFORE UPDATE OF summary ON buckets
             WHEN OLD.id = '11111111-1111-1111-1111-111111111111'
             BEGIN
                 SELECT RAISE(ABORT, 'fixture rejects bucket summary rebuild');
             END;",
        )
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.rebuild_bucket_summary(&rebuild_request(BUCKET_ID)),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_bucket_summary_rebuild_matches_python_service_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    let python_stable_before = bucket_stable_snapshot(python_database.path(), BUCKET_ID);
    let rust_stable_before = bucket_stable_snapshot(rust_database.path(), BUCKET_ID);
    run_python_rebuild_fixture(python_database.path());
    seed_summary_entries(rust_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    let rust_summary = store
        .rebuild_bucket_summary(&rebuild_request(BUCKET_ID))
        .unwrap();
    drop(store);

    assert_eq!(rust_summary, EXPECTED_SUMMARY);
    assert_eq!(
        rust_summary,
        bucket_summary_and_updated_at(python_database.path(), BUCKET_ID).0
    );
    assert_eq!(
        bucket_summary_and_updated_at(rust_database.path(), BUCKET_ID).0,
        bucket_summary_and_updated_at(python_database.path(), BUCKET_ID).0
    );
    assert_eq!(
        bucket_stable_snapshot(python_database.path(), BUCKET_ID),
        python_stable_before
    );
    assert_eq!(
        bucket_stable_snapshot(rust_database.path(), BUCKET_ID),
        rust_stable_before
    );
    assert_eq!(
        seeded_entries_snapshot(rust_database.path()),
        seeded_entries_snapshot(python_database.path())
    );
    assert_eq!(
        table_row_counts(rust_database.path()),
        table_row_counts(python_database.path())
    );
}

fn rebuild_request(bucket_id: &str) -> RebuildBucketSummaryRequest {
    RebuildBucketSummaryRequest::with_limits(bucket_id, MAX_ENTRIES, MAX_CHARS).unwrap()
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
    );
    database
}

fn run_python_rebuild_fixture(database_path: &Path) {
    run_python_script(
        "tests/fixtures/apply_bucket_summary_rebuild_fixture.py",
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

fn seed_summary_entries(path: &Path) {
    let mut connection = Connection::open(path).unwrap();
    let transaction = connection.transaction().unwrap();
    for (id, raw_text, summary, created_at) in SUMMARY_ENTRY_FIXTURES {
        transaction
            .execute(
                "INSERT INTO entries (
                    id, bucket_id, raw_text, summary, content_type,
                    classification_confidence, classification_reason,
                    created_at, moved_from_bucket_id
                 ) VALUES (?1, ?2, ?3, ?4, 'note', NULL, NULL, ?5, NULL)",
                params![id, BUCKET_ID, raw_text, summary, created_at],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
}

fn bucket_summary_and_updated_at(path: &Path, bucket_id: &str) -> (String, String) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT summary, updated_at FROM buckets WHERE id = ?1",
            [bucket_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

fn bucket_stable_snapshot(path: &Path, bucket_id: &str) -> BucketStableSnapshot {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT title, type, status, tags, created_at, last_active_at
             FROM buckets
             WHERE id = ?1",
            [bucket_id],
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

fn seeded_entries_snapshot(path: &Path) -> Vec<Vec<SqlValue>> {
    let connection = Connection::open(path).unwrap();
    let ids = SUMMARY_ENTRY_FIXTURES
        .iter()
        .map(|(id, _, _, _)| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT * FROM entries WHERE id IN ({ids}) ORDER BY id");
    let mut statement = connection.prepare(&sql).unwrap();
    let column_count = statement.column_count();
    statement
        .query_map([], |row| {
            (0..column_count)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
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
