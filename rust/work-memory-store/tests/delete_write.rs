mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params};
use work_memory_store::{DeleteBucketRequest, StoreError, WritableSqliteStore};

const SOURCE_BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const TARGET_BUCKET_ID: &str = "22222222-2222-2222-2222-222222222222";
const SOURCE_ENTRY_ID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LINKED_CLASSIFICATION_ID: &str = "13131313-1313-1313-1313-131313131313";
const CROSS_TODO_ID: &str = "71717171-7171-7171-7171-717171717171";
const CROSS_EVIDENCE_ID: &str = "72727272-7272-7272-7272-727272727272";
const CROSS_TIMELINE_ID: &str = "73737373-7373-7373-7373-737373737373";
const CROSS_DECISION_ID: &str = "74747474-7474-7474-7474-747474747474";
const CROSS_TODO_INITIAL_UPDATED_AT: &str = "2000-01-01 00:00:00.000000";
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
#[test]
fn delete_bucket_cascades_the_owned_aggregate_and_preserves_audits() {
    let database = create_python_fixture("cascade");
    let expected_entries = ids_by_bucket(database.path(), "entries", SOURCE_BUCKET_ID);
    let expected_todos = ids_by_bucket(database.path(), "todos", SOURCE_BUCKET_ID);
    let expected_evidences = ids_by_bucket(database.path(), "evidences", SOURCE_BUCKET_ID);
    let expected_timeline = ids_by_bucket(database.path(), "timeline_events", SOURCE_BUCKET_ID);
    let expected_decisions = ids_by_bucket(database.path(), "decisions", SOURCE_BUCKET_ID);
    let before_counts = table_row_counts(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let outcome = store
        .delete_bucket(&DeleteBucketRequest::new(SOURCE_BUCKET_ID))
        .unwrap();
    assert_eq!(outcome.bucket_id(), SOURCE_BUCKET_ID);
    assert_eq!(outcome.entry_ids(), expected_entries);
    assert_eq!(outcome.todo_ids(), expected_todos);
    assert_eq!(outcome.evidence_ids(), expected_evidences);
    assert_eq!(outcome.timeline_event_ids(), expected_timeline);
    assert_eq!(outcome.decision_ids(), expected_decisions);
    assert_eq!(
        outcome.cleared_classification_entry_ids(),
        [LINKED_CLASSIFICATION_ID]
    );
    drop(store);

    let connection = Connection::open(database.path()).unwrap();
    for table in [
        "buckets",
        "entries",
        "todos",
        "evidences",
        "timeline_events",
        "decisions",
    ] {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE bucket_id = ?1");
        let count: i64 = if table == "buckets" {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM buckets WHERE id = ?1",
                    [SOURCE_BUCKET_ID],
                    |row| row.get(0),
                )
                .unwrap()
        } else {
            connection
                .query_row(&sql, [SOURCE_BUCKET_ID], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(count, 0, "{table} rows must be deleted");
    }
    let classification_link = connection
        .query_row(
            "SELECT bucket_id, entry_id
             FROM classification_records
             WHERE id = ?1",
            [LINKED_CLASSIFICATION_ID],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        classification_link,
        (Some(SOURCE_BUCKET_ID.to_owned()), None)
    );
    drop(connection);

    let after_counts = table_row_counts(database.path());
    assert_eq!(
        after_counts["classification_records"],
        before_counts["classification_records"]
    );
    assert_eq!(after_counts["corrections"], before_counts["corrections"]);
    assert_eq!(
        after_counts["chat_messages"],
        before_counts["chat_messages"]
    );
}

#[test]
fn delete_bucket_nulls_entry_links_without_deleting_other_bucket_rows() {
    let database = create_python_fixture("cross-bucket-links");
    add_cross_bucket_linked_rows(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    store
        .delete_bucket(&DeleteBucketRequest::new(SOURCE_BUCKET_ID))
        .unwrap();
    drop(store);

    let connection = Connection::open(database.path()).unwrap();
    let todo = connection
        .query_row(
            "SELECT bucket_id, entry_id, updated_at FROM todos WHERE id = ?1",
            [CROSS_TODO_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(todo.0, TARGET_BUCKET_ID);
    assert_eq!(todo.1, None);
    assert_ne!(todo.2, CROSS_TODO_INITIAL_UPDATED_AT);

    for (table, id) in [
        ("evidences", CROSS_EVIDENCE_ID),
        ("timeline_events", CROSS_TIMELINE_ID),
        ("decisions", CROSS_DECISION_ID),
    ] {
        let sql = format!("SELECT bucket_id, entry_id FROM {table} WHERE id = ?1");
        let row = connection
            .query_row(&sql, [id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .unwrap();
        assert_eq!(row, (TARGET_BUCKET_ID.to_owned(), None), "row {id}");
    }
}

#[test]
fn missing_bucket_is_rejected_without_business_changes() {
    let database = create_python_fixture("missing");
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.delete_bucket(&DeleteBucketRequest::new("missing-bucket")),
        Err(StoreError::MissingRecord {
            table: "buckets",
            ref id,
        }) if id == "missing-bucket"
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn delete_bucket_preserves_the_exact_requested_id() {
    let database = create_python_fixture("exact-id");
    let before = business_snapshot(database.path());
    let requested_id = format!(" {SOURCE_BUCKET_ID} ");
    let request = DeleteBucketRequest::new(&requested_id);
    assert_eq!(request.bucket_id(), requested_id);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.delete_bucket(&request),
        Err(StoreError::MissingRecord {
            table: "buckets",
            ref id,
        }) if id == &requested_id
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn cascade_failure_rolls_back_the_entire_bucket_delete() {
    let database = create_python_fixture("rollback");
    add_cross_bucket_linked_rows(database.path());
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_entry_delete
             BEFORE DELETE ON entries
             WHEN OLD.bucket_id = '11111111-1111-1111-1111-111111111111'
             BEGIN
                 SELECT RAISE(ABORT, 'fixture rejects entry deletion');
             END;",
        )
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.delete_bucket(&DeleteBucketRequest::new(SOURCE_BUCKET_ID)),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_bucket_delete_matches_python_final_business_state() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    add_cross_bucket_linked_rows(python_database.path());
    add_cross_bucket_linked_rows(rust_database.path());
    run_python_delete_fixture(python_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    store
        .delete_bucket(&DeleteBucketRequest::new(SOURCE_BUCKET_ID))
        .unwrap();
    drop(store);

    assert_ne!(
        todo_updated_at(rust_database.path(), CROSS_TODO_ID),
        CROSS_TODO_INITIAL_UPDATED_AT
    );
    assert_ne!(
        todo_updated_at(python_database.path(), CROSS_TODO_ID),
        CROSS_TODO_INITIAL_UPDATED_AT
    );
    assert_eq!(
        delete_parity_snapshot(rust_database.path()),
        delete_parity_snapshot(python_database.path())
    );
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
    );
    database
}

fn run_python_delete_fixture(database_path: &Path) {
    run_python_script(
        "tests/fixtures/apply_bucket_delete_fixture.py",
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

fn add_cross_bucket_linked_rows(path: &Path) {
    let connection = Connection::open(path).unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    connection
        .execute(
            "INSERT INTO todos (
                id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'Cross-bucket todo.', 'open', NULL, ?4, ?4)",
            params![
                CROSS_TODO_ID,
                TARGET_BUCKET_ID,
                SOURCE_ENTRY_ID,
                CROSS_TODO_INITIAL_UPDATED_AT
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO evidences (id, bucket_id, entry_id, text, source, created_at)
             VALUES (?1, ?2, ?3, 'Cross-bucket evidence.', 'fixture', ?4)",
            params![
                CROSS_EVIDENCE_ID,
                TARGET_BUCKET_ID,
                SOURCE_ENTRY_ID,
                "2026-08-04 11:01:00.000000"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO timeline_events (
                id, bucket_id, entry_id, event_time, text, created_at
             ) VALUES (?1, ?2, ?3, 'during review', 'Cross-bucket event.', ?4)",
            params![
                CROSS_TIMELINE_ID,
                TARGET_BUCKET_ID,
                SOURCE_ENTRY_ID,
                "2026-08-04 11:02:00.000000"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO decisions (id, bucket_id, entry_id, text, reason, created_at)
             VALUES (?1, ?2, ?3, 'Cross-bucket decision.', NULL, ?4)",
            params![
                CROSS_DECISION_ID,
                TARGET_BUCKET_ID,
                SOURCE_ENTRY_ID,
                "2026-08-04 11:03:00.000000"
            ],
        )
        .unwrap();
}

fn ids_by_bucket(path: &Path, table: &str, bucket_id: &str) -> Vec<String> {
    let connection = Connection::open(path).unwrap();
    let sql = format!("SELECT id FROM {table} WHERE bucket_id = ?1 ORDER BY id");
    connection
        .prepare(&sql)
        .unwrap()
        .query_map([bucket_id], |row| row.get::<_, String>(0))
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

fn todo_updated_at(path: &Path, todo_id: &str) -> String {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT updated_at FROM todos WHERE id = ?1",
            [todo_id],
            |row| row.get(0),
        )
        .unwrap()
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

fn delete_parity_snapshot(path: &Path) -> BTreeMap<String, Vec<Vec<SqlValue>>> {
    let mut snapshot = business_snapshot(path);
    let todo_rows = snapshot
        .get_mut("todos")
        .expect("business snapshot must contain todos");
    for row in todo_rows {
        if matches!(row.first(), Some(SqlValue::Text(id)) if id == CROSS_TODO_ID) {
            let updated_at = row
                .last_mut()
                .expect("Todo snapshot must contain updated_at");
            assert!(matches!(updated_at, SqlValue::Text(_)));
            *updated_at = SqlValue::Text("<updated-by-bucket-delete>".to_owned());
        }
    }
    snapshot
}
