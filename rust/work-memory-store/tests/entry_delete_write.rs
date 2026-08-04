use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params};
use work_memory_store::{DeleteEntryRequest, StoreError, WritableSqliteStore};

const SOURCE_BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const TARGET_BUCKET_ID: &str = "22222222-2222-2222-2222-222222222222";
const ENTRY_ID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BASE_TODO_ID: &str = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BASE_EVIDENCE_ID: &str = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const BASE_CLASSIFICATION_ID: &str = "13131313-1313-1313-1313-131313131313";
const CROSS_TODO_ID: &str = "71717171-7171-7171-7171-717171717171";
const CROSS_EVIDENCE_ID: &str = "72727272-7272-7272-7272-727272727272";
const CROSS_TIMELINE_ID: &str = "73737373-7373-7373-7373-737373737373";
const CROSS_DECISION_ID: &str = "74747474-7474-7474-7474-747474747474";
const SAME_TIMELINE_ID: &str = "75757575-7575-7575-7575-757575757575";
const SAME_DECISION_ID: &str = "76767676-7676-7676-7676-767676767676";
const ENTRY_CORRECTION_ID: &str = "78787878-7878-7878-7878-787878787878";
const CROSS_CLASSIFICATION_ID: &str = "79797979-7979-7979-7979-797979797979";
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
            "work-memory-entry-delete-{label}-{}-{timestamp}-{sequence}.db",
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

#[test]
fn delete_entry_clears_links_and_preserves_bucket_children_and_audits() {
    let database = create_python_fixture("links");
    add_entry_linked_rows(database.path());
    let expected_todos = ids_by_entry(database.path(), "todos", ENTRY_ID);
    let expected_evidences = ids_by_entry(database.path(), "evidences", ENTRY_ID);
    let expected_timeline = ids_by_entry(database.path(), "timeline_events", ENTRY_ID);
    let expected_decisions = ids_by_entry(database.path(), "decisions", ENTRY_ID);
    let expected_classifications =
        ids_by_entry(database.path(), "classification_records", ENTRY_ID);
    let before_counts = table_row_counts(database.path());
    let bucket_before = row_by_id(database.path(), "buckets", SOURCE_BUCKET_ID);
    let correction_before = row_by_id(database.path(), "corrections", ENTRY_CORRECTION_ID);
    let todo_timestamps_before = todo_timestamps(database.path(), &expected_todos);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let outcome = store
        .delete_entry(&DeleteEntryRequest::new(ENTRY_ID))
        .unwrap();
    assert_eq!(outcome.entry_id(), ENTRY_ID);
    assert_eq!(outcome.bucket_id(), SOURCE_BUCKET_ID);
    assert_eq!(outcome.cleared_todo_ids(), expected_todos);
    assert_eq!(outcome.cleared_evidence_ids(), expected_evidences);
    assert_eq!(outcome.cleared_timeline_event_ids(), expected_timeline);
    assert_eq!(outcome.cleared_decision_ids(), expected_decisions);
    assert_eq!(
        outcome.cleared_classification_entry_ids(),
        expected_classifications
    );
    drop(store);

    assert_eq!(row_count_by_id(database.path(), "entries", ENTRY_ID), 0);
    assert_eq!(
        row_by_id(database.path(), "buckets", SOURCE_BUCKET_ID),
        bucket_before
    );
    assert_eq!(
        row_by_id(database.path(), "corrections", ENTRY_CORRECTION_ID),
        correction_before
    );

    for (table, id, bucket_id) in [
        ("todos", BASE_TODO_ID, SOURCE_BUCKET_ID),
        ("todos", CROSS_TODO_ID, TARGET_BUCKET_ID),
        ("evidences", BASE_EVIDENCE_ID, SOURCE_BUCKET_ID),
        ("evidences", CROSS_EVIDENCE_ID, TARGET_BUCKET_ID),
        ("timeline_events", SAME_TIMELINE_ID, SOURCE_BUCKET_ID),
        ("timeline_events", CROSS_TIMELINE_ID, TARGET_BUCKET_ID),
        ("decisions", SAME_DECISION_ID, SOURCE_BUCKET_ID),
        ("decisions", CROSS_DECISION_ID, TARGET_BUCKET_ID),
    ] {
        assert_eq!(
            bucket_and_entry_link(database.path(), table, id),
            (bucket_id.to_owned(), None),
            "row {id}"
        );
    }
    for (id, bucket_id) in [
        (BASE_CLASSIFICATION_ID, SOURCE_BUCKET_ID),
        (CROSS_CLASSIFICATION_ID, TARGET_BUCKET_ID),
    ] {
        assert_eq!(
            classification_link(database.path(), id),
            (Some(bucket_id.to_owned()), None),
            "classification {id}"
        );
    }

    let todo_timestamps_after = todo_timestamps(database.path(), &expected_todos);
    for todo_id in &expected_todos {
        assert_ne!(
            todo_timestamps_after[todo_id], todo_timestamps_before[todo_id],
            "Todo {todo_id} must receive its SQLAlchemy-compatible update timestamp"
        );
    }

    let after_counts = table_row_counts(database.path());
    for table in BUSINESS_TABLES {
        let expected = if *table == "entries" {
            before_counts[*table] - 1
        } else {
            before_counts[*table]
        };
        assert_eq!(after_counts[*table], expected, "table {table}");
    }
}

#[test]
fn delete_entry_preserves_the_exact_requested_id() {
    let database = create_python_fixture("exact-id");
    let before = business_snapshot(database.path());
    let requested_id = format!(" {ENTRY_ID} ");
    let request = DeleteEntryRequest::new(&requested_id);
    assert_eq!(request.entry_id(), requested_id);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.delete_entry(&request),
        Err(StoreError::MissingRecord {
            table: "entries",
            ref id,
        }) if id == &requested_id
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn missing_entry_is_rejected_without_business_changes() {
    let database = create_python_fixture("missing");
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.delete_entry(&DeleteEntryRequest::new("missing-entry")),
        Err(StoreError::MissingRecord {
            table: "entries",
            ref id,
        }) if id == "missing-entry"
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn entry_delete_failure_rolls_back_all_link_clearing() {
    let database = create_python_fixture("rollback");
    add_entry_linked_rows(database.path());
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_entry_delete
             BEFORE DELETE ON entries
             WHEN OLD.id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
             BEGIN
                 SELECT RAISE(ABORT, 'fixture rejects entry deletion');
             END;",
        )
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.delete_entry(&DeleteEntryRequest::new(ENTRY_ID)),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_entry_delete_matches_python_final_business_state() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    add_entry_linked_rows(python_database.path());
    add_entry_linked_rows(rust_database.path());
    let linked_todo_ids = ids_by_entry(python_database.path(), "todos", ENTRY_ID);
    let python_timestamps_before = todo_timestamps(python_database.path(), &linked_todo_ids);
    let rust_timestamps_before = todo_timestamps(rust_database.path(), &linked_todo_ids);
    run_python_delete_fixture(python_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    store
        .delete_entry(&DeleteEntryRequest::new(ENTRY_ID))
        .unwrap();
    drop(store);

    for (path, before) in [
        (python_database.path(), &python_timestamps_before),
        (rust_database.path(), &rust_timestamps_before),
    ] {
        let after = todo_timestamps(path, &linked_todo_ids);
        for todo_id in &linked_todo_ids {
            assert_ne!(after[todo_id], before[todo_id], "Todo {todo_id}");
        }
    }
    assert_eq!(
        delete_parity_snapshot(rust_database.path(), &linked_todo_ids),
        delete_parity_snapshot(python_database.path(), &linked_todo_ids)
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
        "tests/fixtures/apply_entry_delete_fixture.py",
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

fn add_entry_linked_rows(path: &Path) {
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
                ENTRY_ID,
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
                ENTRY_ID,
                "2000-01-01 00:01:00.000000"
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
                ENTRY_ID,
                "2000-01-01 00:02:00.000000"
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
                ENTRY_ID,
                "2000-01-01 00:03:00.000000"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO timeline_events (
                id, bucket_id, entry_id, event_time, text, created_at
             ) VALUES (?1, ?2, ?3, 'after recovery', 'Same-bucket event.', ?4)",
            params![
                SAME_TIMELINE_ID,
                SOURCE_BUCKET_ID,
                ENTRY_ID,
                "2000-01-01 00:04:00.000000"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO decisions (id, bucket_id, entry_id, text, reason, created_at)
             VALUES (?1, ?2, ?3, 'Same-bucket decision.', 'fixture', ?4)",
            params![
                SAME_DECISION_ID,
                SOURCE_BUCKET_ID,
                ENTRY_ID,
                "2000-01-01 00:05:00.000000"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO corrections (
                id, command_text, action, target_type, target_id,
                before_json, after_json, created_at
             ) VALUES (
                ?1, 'Review this entry audit.', 'review_entry', 'entry', ?2,
                '{\"entry_id\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"}',
                NULL, ?3
             )",
            params![ENTRY_CORRECTION_ID, ENTRY_ID, "2000-01-01 00:06:00.000000"],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO classification_records (
                id, raw_text, action, bucket_id, entry_id, confidence, reason,
                candidate_bucket_ids, current_focus_bucket_id, prompt_version,
                model_name, corrected, created_at
             ) VALUES (
                ?1, 'Cross-bucket classification audit.', 'append_existing', ?2, ?3,
                0.88, 'Fixture audit.', '[]', ?2, 'classification-v1',
                'fixture-model', 0, ?4
             )",
            params![
                CROSS_CLASSIFICATION_ID,
                TARGET_BUCKET_ID,
                ENTRY_ID,
                "2000-01-01 00:07:00.000000"
            ],
        )
        .unwrap();
}

fn ids_by_entry(path: &Path, table: &str, entry_id: &str) -> Vec<String> {
    let connection = Connection::open(path).unwrap();
    let sql = format!("SELECT id FROM {table} WHERE entry_id = ?1 ORDER BY id");
    connection
        .prepare(&sql)
        .unwrap()
        .query_map([entry_id], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn row_count_by_id(path: &Path, table: &str, id: &str) -> i64 {
    let connection = Connection::open(path).unwrap();
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE id = ?1");
    connection.query_row(&sql, [id], |row| row.get(0)).unwrap()
}

fn bucket_and_entry_link(path: &Path, table: &str, id: &str) -> (String, Option<String>) {
    let connection = Connection::open(path).unwrap();
    let sql = format!("SELECT bucket_id, entry_id FROM {table} WHERE id = ?1");
    connection
        .query_row(&sql, [id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
}

fn classification_link(path: &Path, id: &str) -> (Option<String>, Option<String>) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT bucket_id, entry_id FROM classification_records WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

fn todo_timestamps(path: &Path, todo_ids: &[String]) -> BTreeMap<String, String> {
    let connection = Connection::open(path).unwrap();
    todo_ids
        .iter()
        .map(|id| {
            let timestamp = connection
                .query_row("SELECT updated_at FROM todos WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .unwrap();
            (id.clone(), timestamp)
        })
        .collect()
}

fn row_by_id(path: &Path, table: &str, id: &str) -> Vec<SqlValue> {
    let connection = Connection::open(path).unwrap();
    let sql = format!("SELECT * FROM {table} WHERE id = ?1");
    let mut statement = connection.prepare(&sql).unwrap();
    let column_count = statement.column_count();
    statement
        .query_row([id], |row| {
            (0..column_count)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<Result<Vec<_>, _>>()
        })
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

fn delete_parity_snapshot(
    path: &Path,
    linked_todo_ids: &[String],
) -> BTreeMap<String, Vec<Vec<SqlValue>>> {
    let mut snapshot = business_snapshot(path);
    let todo_rows = snapshot
        .get_mut("todos")
        .expect("business snapshot must contain todos");
    for row in todo_rows {
        if matches!(row.first(), Some(SqlValue::Text(id)) if linked_todo_ids.contains(id)) {
            let updated_at = row
                .last_mut()
                .expect("Todo snapshot must contain updated_at");
            assert!(matches!(updated_at, SqlValue::Text(_)));
            *updated_at = SqlValue::Text("<updated-by-entry-delete>".to_owned());
        }
    }
    snapshot
}
