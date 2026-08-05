mod support;

use support::{TemporaryPath as TemporaryDatabase, assert_uuid_v4};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params};
use serde_json::{Value as JsonValue, json};
use work_memory_store::{
    MoveEntryRequest, MoveLatestEntryRequest, SqliteStore, StoreError, WritableSqliteStore,
};

const SOURCE_BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const TARGET_BUCKET_ID: &str = "22222222-2222-2222-2222-222222222222";
const ENTRY_ID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TODO_ID: &str = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const SECOND_TODO_ID: &str = "d3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3";
const EVIDENCE_ID: &str = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const TIMELINE_EVENT_ID: &str = "f3f3f3f3-f3f3-f3f3-f3f3-f3f3f3f3f3f3";
const DECISION_ID: &str = "12333333-3333-3333-3333-333333333333";
const CLASSIFICATION_ID: &str = "13131313-1313-1313-1313-131313131313";
const SECOND_CLASSIFICATION_ID: &str = "13333333-3333-3333-3333-333333333333";
const COMMAND_TEXT: &str = "Move the callback failure into the review Bucket.";
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
fn move_entry_updates_the_complete_aggregate_and_writes_audit() {
    let database = create_python_fixture("complete");
    add_extra_linked_rows(database.path());
    let before_activity = bucket_activity(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request =
        MoveEntryRequest::new(ENTRY_ID, TARGET_BUCKET_ID, format!("  {COMMAND_TEXT}  ")).unwrap();

    let outcome = store.move_entry(&request).unwrap();
    assert_uuid_v4(outcome.correction_id());
    assert_eq!(outcome.entry_id(), ENTRY_ID);
    assert_eq!(outcome.source_bucket_id(), SOURCE_BUCKET_ID);
    assert_eq!(outcome.target_bucket_id(), TARGET_BUCKET_ID);
    assert_eq!(outcome.todo_ids(), [TODO_ID, SECOND_TODO_ID]);
    assert_eq!(outcome.evidence_ids(), [EVIDENCE_ID]);
    assert_eq!(outcome.timeline_event_ids(), [TIMELINE_EVENT_ID]);
    assert_eq!(outcome.decision_ids(), [DECISION_ID]);
    assert_eq!(
        outcome.corrected_classification_record_ids(),
        [CLASSIFICATION_ID, SECOND_CLASSIFICATION_ID]
    );
    drop(store);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    let moved_entry = reader
        .list_bucket_entries(TARGET_BUCKET_ID)
        .unwrap()
        .into_iter()
        .find(|entry| entry.id == ENTRY_ID)
        .unwrap();
    assert_eq!(moved_entry.bucket_id, TARGET_BUCKET_ID);
    assert_eq!(
        moved_entry.moved_from_bucket_id.as_deref(),
        Some(SOURCE_BUCKET_ID)
    );
    assert!(
        reader
            .list_bucket_entries(SOURCE_BUCKET_ID)
            .unwrap()
            .iter()
            .all(|entry| entry.id != ENTRY_ID)
    );
    assert_eq!(
        reader
            .get_bucket(SOURCE_BUCKET_ID)
            .unwrap()
            .unwrap()
            .summary,
        ""
    );
    assert_eq!(
        reader
            .get_bucket(TARGET_BUCKET_ID)
            .unwrap()
            .unwrap()
            .summary,
        "Callback returned 502.\nPrepare review."
    );
    for id in [TODO_ID, SECOND_TODO_ID] {
        assert_eq!(
            reader.get_todo(id).unwrap().unwrap().bucket_id,
            TARGET_BUCKET_ID
        );
    }
    assert_eq!(
        reader.get_evidence(EVIDENCE_ID).unwrap().unwrap().bucket_id,
        TARGET_BUCKET_ID
    );
    assert_eq!(
        reader
            .get_timeline_event(TIMELINE_EVENT_ID)
            .unwrap()
            .unwrap()
            .bucket_id,
        TARGET_BUCKET_ID
    );
    assert_eq!(
        reader.get_decision(DECISION_ID).unwrap().unwrap().bucket_id,
        TARGET_BUCKET_ID
    );
    for id in [CLASSIFICATION_ID, SECOND_CLASSIFICATION_ID] {
        let classification = reader.get_classification_record(id).unwrap().unwrap();
        assert!(classification.corrected);
        assert_eq!(classification.bucket_id.as_deref(), Some(SOURCE_BUCKET_ID));
    }
    let correction = reader
        .get_correction(outcome.correction_id())
        .unwrap()
        .unwrap();
    assert_eq!(correction.command_text, COMMAND_TEXT);
    assert_eq!(correction.action, "move_entry");
    assert_eq!(correction.target_type, "entry");
    assert_eq!(correction.target_id, ENTRY_ID);
    assert_eq!(
        correction.before_json,
        Some(json!({
            "entry_id": ENTRY_ID,
            "bucket_id": SOURCE_BUCKET_ID,
            "todo_ids": [TODO_ID, SECOND_TODO_ID],
            "evidence_ids": [EVIDENCE_ID],
            "timeline_event_ids": [TIMELINE_EVENT_ID],
            "decision_ids": [DECISION_ID],
        }))
    );
    assert_eq!(
        correction.after_json,
        Some(json!({
            "entry_id": ENTRY_ID,
            "bucket_id": TARGET_BUCKET_ID,
            "todo_ids": [TODO_ID, SECOND_TODO_ID],
            "evidence_ids": [EVIDENCE_ID],
            "timeline_event_ids": [TIMELINE_EVENT_ID],
            "decision_ids": [DECISION_ID],
        }))
    );
    drop(reader);

    let after_activity = bucket_activity(database.path());
    for bucket_id in [SOURCE_BUCKET_ID, TARGET_BUCKET_ID] {
        assert_ne!(after_activity[bucket_id].0, before_activity[bucket_id].0);
        assert_ne!(after_activity[bucket_id].1, before_activity[bucket_id].1);
    }
}

#[test]
fn missing_entry_leaves_all_business_rows_unchanged() {
    let database = create_python_fixture("missing-entry");
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = MoveEntryRequest::new("missing-entry", TARGET_BUCKET_ID, COMMAND_TEXT).unwrap();

    assert!(matches!(
        store.move_entry(&request),
        Err(StoreError::MissingRecord {
            table: "entries",
            id
        }) if id == "missing-entry"
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn missing_target_bucket_leaves_all_business_rows_unchanged() {
    let database = create_python_fixture("missing-target");
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = MoveEntryRequest::new(ENTRY_ID, "missing-bucket", COMMAND_TEXT).unwrap();

    assert!(matches!(
        store.move_entry(&request),
        Err(StoreError::MissingRecord {
            table: "buckets",
            id
        }) if id == "missing-bucket"
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn same_bucket_move_is_a_typed_validation_error_without_changes() {
    let database = create_python_fixture("same-target");
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = MoveEntryRequest::new(ENTRY_ID, SOURCE_BUCKET_ID, COMMAND_TEXT).unwrap();

    assert!(matches!(
        store.move_entry(&request),
        Err(StoreError::InvalidCorrectionWrite {
            action: "move_entry",
            reason: "entry already belongs to the target bucket"
        })
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn latest_move_prefers_one_exact_title_over_additional_fuzzy_matches() {
    let database = create_python_fixture("latest-exact-title");
    Connection::open(database.path())
        .unwrap()
        .execute(
            "INSERT INTO buckets (
                id, title, type, status, summary, tags,
                created_at, updated_at, last_active_at
             ) VALUES (
                '55555555-5555-5555-5555-555555555555',
                'Newer tie-break update archive', 'task', 'active', '', '[]',
                '2026-08-04 08:30:00.000000',
                '2026-08-04 08:30:00.000000',
                '2026-08-04 08:30:00.000000'
             )",
            [],
        )
        .unwrap();
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = MoveLatestEntryRequest::for_bucket_title_contains(
        "Newer tie-break update",
        "Move the latest entry",
    )
    .unwrap();

    assert!(matches!(
        store.move_latest_entry(&request),
        Err(StoreError::InvalidCorrectionWrite {
            action: "move_entry",
            reason: "entry already belongs to the target bucket"
        })
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn latest_move_rejects_a_database_without_entries_before_writing() {
    let database = create_python_fixture("latest-empty");
    Connection::open(database.path())
        .unwrap()
        .execute("DELETE FROM entries", [])
        .unwrap();
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = MoveLatestEntryRequest::for_bucket_id(TARGET_BUCKET_ID, "Move latest").unwrap();

    assert!(matches!(
        store.move_latest_entry(&request),
        Err(StoreError::NoEntryAvailableToCorrect)
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn late_sqlite_failure_rolls_back_move_children_audit_classification_and_caches() {
    let database = create_python_fixture("rollback");
    Connection::open(database.path())
        .unwrap()
        .execute_batch(&format!(
            "CREATE TRIGGER reject_target_summary_rebuild
             BEFORE UPDATE OF summary ON buckets
             WHEN NEW.id = '{TARGET_BUCKET_ID}'
             BEGIN
                 SELECT RAISE(ABORT, 'forced correction failure');
             END;"
        ))
        .unwrap();
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = MoveEntryRequest::new(ENTRY_ID, TARGET_BUCKET_ID, COMMAND_TEXT).unwrap();

    assert!(matches!(
        store.move_entry(&request),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_entry_move_matches_python_final_business_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    run_python_correction_fixture(python_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    let request =
        MoveEntryRequest::new(ENTRY_ID, TARGET_BUCKET_ID, format!("  {COMMAND_TEXT}  ")).unwrap();
    store.move_entry(&request).unwrap();
    drop(store);

    assert_eq!(
        correction_semantic_snapshot(rust_database.path()),
        correction_semantic_snapshot(python_database.path())
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

fn run_python_correction_fixture(database_path: &Path) {
    run_python_script(
        "tests/fixtures/apply_correction_write_fixture.py",
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

fn add_extra_linked_rows(path: &Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute(
            "INSERT INTO todos (
                id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'Second linked todo.', 'open', NULL, ?4, ?4)",
            params![
                SECOND_TODO_ID,
                SOURCE_BUCKET_ID,
                ENTRY_ID,
                "2026-08-04 10:06:00.000000"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO timeline_events (
                id, bucket_id, entry_id, event_time, text, created_at
             ) VALUES (?1, ?2, ?3, 'during review', 'Linked timeline event.', ?4)",
            params![
                TIMELINE_EVENT_ID,
                SOURCE_BUCKET_ID,
                ENTRY_ID,
                "2026-08-04 10:20:00.000000"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO decisions (id, bucket_id, entry_id, text, reason, created_at)
             VALUES (?1, ?2, ?3, 'Linked decision.', NULL, ?4)",
            params![
                DECISION_ID,
                SOURCE_BUCKET_ID,
                ENTRY_ID,
                "2026-08-04 10:25:00.000000"
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO classification_records (
                id, raw_text, action, bucket_id, entry_id, confidence, reason,
                candidate_bucket_ids, current_focus_bucket_id, prompt_version,
                model_name, corrected, created_at
             ) VALUES (?1, 'Second classification.', 'append_existing', ?2, ?3, 0.8,
                       'Second audit.', '[]', NULL, 'test', 'fixture-model', 0, ?4)",
            params![
                SECOND_CLASSIFICATION_ID,
                SOURCE_BUCKET_ID,
                ENTRY_ID,
                "2026-08-04 09:03:00.000000"
            ],
        )
        .unwrap();
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

fn bucket_activity(path: &Path) -> BTreeMap<String, (String, String)> {
    let connection = Connection::open(path).unwrap();
    [SOURCE_BUCKET_ID, TARGET_BUCKET_ID]
        .into_iter()
        .map(|bucket_id| {
            let activity = connection
                .query_row(
                    "SELECT updated_at, last_active_at FROM buckets WHERE id = ?1",
                    [bucket_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            (bucket_id.to_owned(), activity)
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
struct CorrectionSemanticSnapshot {
    source_summary: String,
    target_summary: String,
    source_activity_changed: bool,
    target_activity_changed: bool,
    entry_bucket_id: String,
    moved_from_bucket_id: Option<String>,
    child_bucket_ids: BTreeMap<String, Vec<(String, String)>>,
    classification_rows: Vec<(String, Option<String>, i64)>,
    correction: CorrectionSemanticRow,
}

#[derive(Debug, PartialEq, Eq)]
struct CorrectionSemanticRow {
    command_text: String,
    action: String,
    target_type: String,
    target_id: String,
    before_json: JsonValue,
    after_json: JsonValue,
}

fn correction_semantic_snapshot(path: &Path) -> CorrectionSemanticSnapshot {
    let connection = Connection::open(path).unwrap();
    let source = connection
        .query_row(
            "SELECT summary, updated_at, last_active_at FROM buckets WHERE id = ?1",
            [SOURCE_BUCKET_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    let target = connection
        .query_row(
            "SELECT summary, updated_at, last_active_at FROM buckets WHERE id = ?1",
            [TARGET_BUCKET_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    let (entry_bucket_id, moved_from_bucket_id) = connection
        .query_row(
            "SELECT bucket_id, moved_from_bucket_id FROM entries WHERE id = ?1",
            [ENTRY_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    let child_bucket_ids = ["todos", "evidences", "timeline_events", "decisions"]
        .into_iter()
        .map(|table| {
            let sql = format!(
                "SELECT id, bucket_id FROM {table} WHERE entry_id = ?1 ORDER BY created_at, id"
            );
            let mut statement = connection.prepare(&sql).unwrap();
            let rows = statement
                .query_map([ENTRY_ID], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (table.to_owned(), rows)
        })
        .collect();

    let mut statement = connection
        .prepare(
            "SELECT id, bucket_id, corrected FROM classification_records
             WHERE entry_id = ?1 ORDER BY created_at, id",
        )
        .unwrap();
    let classification_rows = statement
        .query_map([ENTRY_ID], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(statement);

    let correction = connection
        .query_row(
            "SELECT command_text, action, target_type, target_id, before_json, after_json
             FROM corrections
             WHERE target_type = 'entry' AND target_id = ?1 AND command_text = ?2",
            params![ENTRY_ID, COMMAND_TEXT],
            |row| {
                let before_json: String = row.get(4)?;
                let after_json: String = row.get(5)?;
                Ok(CorrectionSemanticRow {
                    command_text: row.get(0)?,
                    action: row.get(1)?,
                    target_type: row.get(2)?,
                    target_id: row.get(3)?,
                    before_json: serde_json::from_str(&before_json).unwrap(),
                    after_json: serde_json::from_str(&after_json).unwrap(),
                })
            },
        )
        .unwrap();

    CorrectionSemanticSnapshot {
        source_summary: source.0,
        target_summary: target.0,
        source_activity_changed: source.1 != "2026-08-04 12:15:00.000000"
            && source.2 != "2026-08-04 12:00:00.000000",
        target_activity_changed: target.1 != "2026-08-04 11:45:00.000000"
            && target.2 != "2026-08-04 11:00:00.000000",
        entry_bucket_id,
        moved_from_bucket_id,
        child_bucket_ids,
        classification_rows,
        correction,
    }
}
