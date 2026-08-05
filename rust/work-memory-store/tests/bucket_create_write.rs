mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use work_memory_core::{BucketStatus, BucketType};
use work_memory_store::{CreateBucketRequest, StoreError, WritableSqliteStore};

const TITLE: &str = "R2j standalone bucket";
const SUMMARY: &str = "Initial standalone summary.";
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
#[derive(Debug, PartialEq, Eq)]
struct BucketSemanticSnapshot {
    title: String,
    bucket_type: String,
    status: String,
    summary: String,
    tags: Vec<String>,
}

#[test]
fn create_bucket_request_matches_python_text_and_tag_normalization() {
    let request = standalone_request();

    assert_eq!(request.title(), TITLE);
    assert_eq!(request.bucket_type(), BucketType::Incident);
    assert_eq!(request.summary(), SUMMARY);
    assert_eq!(request.tags(), ["alpha", "alpha", "beta"]);

    assert!(matches!(
        CreateBucketRequest::new("   ", BucketType::Idea, "", vec![]),
        Err(StoreError::InvalidWriteField {
            field: "title",
            reason: "must not be empty",
        })
    ));
}

#[test]
fn create_bucket_persists_one_active_bucket_and_no_related_rows() {
    let database = create_python_fixture("complete");
    let before_counts = table_row_counts(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let bucket = store.create_bucket(&standalone_request()).unwrap();
    assert_uuid_v4(&bucket.id);
    assert_eq!(bucket.title, TITLE);
    assert_eq!(bucket.bucket_type, BucketType::Incident);
    assert_eq!(bucket.status, BucketStatus::Active);
    assert_eq!(bucket.summary, SUMMARY);
    assert_eq!(bucket.tags, ["alpha", "alpha", "beta"]);
    assert!(!bucket.created_at.raw().is_empty());
    assert_eq!(bucket.created_at.raw(), bucket.updated_at.raw());
    assert_eq!(bucket.created_at.raw(), bucket.last_active_at.raw());
    drop(store);

    let after_counts = table_row_counts(database.path());
    for table in BUSINESS_TABLES {
        let expected = before_counts[*table] + i64::from(*table == "buckets");
        assert_eq!(after_counts[*table], expected, "table {table}");
    }
    assert_eq!(
        bucket_semantic_snapshot(database.path()),
        standalone_snapshot()
    );
}

#[test]
fn bucket_insert_failure_rolls_back_without_business_changes() {
    let database = create_python_fixture("rollback");
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_standalone_bucket
             BEFORE INSERT ON buckets
             WHEN NEW.title = 'R2j standalone bucket'
             BEGIN
                 SELECT RAISE(ABORT, 'fixture rejects standalone bucket');
             END;",
        )
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.create_bucket(&standalone_request()),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_bucket_create_matches_python_service_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    run_python_create_fixture(python_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    let bucket = store.create_bucket(&standalone_request()).unwrap();
    assert_uuid_v4(&bucket.id);
    drop(store);

    let python_id = bucket_id_by_title(python_database.path(), TITLE);
    assert_uuid_v4(&python_id);
    assert_eq!(
        bucket_semantic_snapshot(rust_database.path()),
        bucket_semantic_snapshot(python_database.path())
    );
    assert_eq!(
        table_row_counts(rust_database.path()),
        table_row_counts(python_database.path())
    );
}

fn standalone_request() -> CreateBucketRequest {
    CreateBucketRequest::new(
        format!("  {TITLE}  "),
        BucketType::Incident,
        format!("  {SUMMARY}  "),
        vec![
            " alpha ".to_owned(),
            String::new(),
            "alpha".to_owned(),
            " beta ".to_owned(),
        ],
    )
    .unwrap()
}

fn standalone_snapshot() -> BucketSemanticSnapshot {
    BucketSemanticSnapshot {
        title: TITLE.to_owned(),
        bucket_type: "incident".to_owned(),
        status: "active".to_owned(),
        summary: SUMMARY.to_owned(),
        tags: vec!["alpha".to_owned(), "alpha".to_owned(), "beta".to_owned()],
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

fn run_python_create_fixture(database_path: &Path) {
    run_python_script(
        "tests/fixtures/apply_bucket_create_fixture.py",
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

fn bucket_id_by_title(path: &Path, title: &str) -> String {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT id FROM buckets WHERE title = ?1", [title], |row| {
            row.get(0)
        })
        .unwrap()
}

fn bucket_semantic_snapshot(path: &Path) -> BucketSemanticSnapshot {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT title, type, status, summary, tags
             FROM buckets
             WHERE title = ?1",
            [TITLE],
            |row| {
                let tags_json: String = row.get(4)?;
                Ok(BucketSemanticSnapshot {
                    title: row.get(0)?,
                    bucket_type: row.get(1)?,
                    status: row.get(2)?,
                    summary: row.get(3)?,
                    tags: serde_json::from_str(&tags_json).unwrap(),
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
