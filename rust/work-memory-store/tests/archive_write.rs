mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;
use rusqlite::types::Value;
use work_memory_core::{
    ArchiveStatus, BucketType, ClassificationAction, ClassificationResult, ExtractionResult,
    TimelineEventExtract,
};
use work_memory_store::{
    ArchiveWriteRequest, ClassificationAuditContext, SqliteStore, StoreError, TodoStatus,
    WritableSqliteStore,
};

const ACTIVE_LATEST_ID: &str = "11111111-1111-1111-1111-111111111111";
const ACTIVE_TIE_NEWER_ID: &str = "22222222-2222-2222-2222-222222222222";
const RAW_TEXT: &str = "Payment recovery review found the callback path stable.";
const SUMMARY: &str = "The callback path remained stable during the recovery review.";
const CONFIDENCE: f64 = 0.88;
const REASON: &str = "The update explicitly continues the active callback incident.";
const PROMPT_VERSION: &str = "classification-v2";
const MODEL_NAME: &str = "fixture-model";
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
fn append_existing_persists_the_complete_archive_graph() {
    let database = create_python_fixture("append");
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = append_request(ACTIVE_LATEST_ID, append_extraction());

    let outcome = store.persist_archive_attempt(&request).unwrap();
    assert_eq!(outcome.status(), ArchiveStatus::Archived);
    assert_eq!(outcome.action(), ClassificationAction::AppendExisting);
    assert_eq!(outcome.bucket_id(), Some(ACTIVE_LATEST_ID));
    assert_eq!(outcome.bucket_title(), Some("Payment callback incident"));
    assert_eq!(outcome.bucket_type(), Some(BucketType::Incident));
    assert!(!outcome.created_bucket());
    assert_eq!(outcome.todo_ids().len(), 2);
    assert_eq!(outcome.evidence_ids().len(), 1);
    assert_eq!(outcome.timeline_event_ids().len(), 1);
    assert_eq!(outcome.decision_ids().len(), 1);
    assert_uuid_v4(outcome.classification_record_id());
    assert_uuid_v4(outcome.entry_id().unwrap());
    for id in outcome
        .todo_ids()
        .iter()
        .chain(outcome.evidence_ids())
        .chain(outcome.timeline_event_ids())
        .chain(outcome.decision_ids())
    {
        assert_uuid_v4(id);
    }
    drop(store);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    let bucket = reader.get_bucket(ACTIVE_LATEST_ID).unwrap().unwrap();
    assert_eq!(
        bucket.summary,
        format!("Investigating callback failures.\n{SUMMARY}")
    );
    assert_eq!(
        bucket.tags,
        ["payments", "callback", "支付", "recovery", "稳定"]
    );

    let entry_id = outcome.entry_id().unwrap();
    let entry = reader
        .list_bucket_entries(ACTIVE_LATEST_ID)
        .unwrap()
        .into_iter()
        .find(|entry| entry.id == entry_id)
        .unwrap();
    assert_eq!(entry.bucket_id, ACTIVE_LATEST_ID);
    assert_eq!(entry.raw_text, RAW_TEXT);
    assert_eq!(entry.summary.as_deref(), Some(SUMMARY));
    assert_eq!(entry.content_type, "note");
    assert_eq!(entry.classification_confidence, Some(CONFIDENCE));
    assert_eq!(entry.classification_reason.as_deref(), Some(REASON));
    assert_eq!(entry.moved_from_bucket_id, None);
    assert_eq!(entry.created_at.raw(), bucket.updated_at.raw());
    assert_eq!(entry.created_at.raw(), bucket.last_active_at.raw());

    let todos = reader.list_bucket_todos(ACTIVE_LATEST_ID).unwrap();
    let new_todos = todos
        .iter()
        .filter(|todo| todo.entry_id.as_deref() == Some(entry_id))
        .collect::<Vec<_>>();
    assert_eq!(new_todos.len(), 2);
    assert_eq!(
        new_todos
            .iter()
            .map(|todo| todo.text.as_str())
            .collect::<Vec<_>>(),
        ["Review callback dashboard.", "review   callback dashboard."]
    );
    assert!(new_todos.iter().all(|todo| todo.status == TodoStatus::Open));
    assert!(new_todos.iter().all(|todo| todo.due_date.is_none()));

    let evidences = reader.list_bucket_evidences(ACTIVE_LATEST_ID).unwrap();
    let new_evidence = evidences
        .iter()
        .find(|evidence| evidence.entry_id.as_deref() == Some(entry_id))
        .unwrap();
    assert_eq!(
        new_evidence.text,
        "The callback error rate stayed below 0.1%."
    );
    assert_eq!(new_evidence.source.as_deref(), Some("llm-extracted"));

    let timeline = reader
        .list_bucket_timeline_events(ACTIVE_LATEST_ID)
        .unwrap();
    let new_event = timeline
        .iter()
        .find(|event| event.entry_id.as_deref() == Some(entry_id))
        .unwrap();
    assert_eq!(new_event.event_time.as_deref(), Some("during review"));
    assert_eq!(new_event.text, "The callback path stayed stable.");

    let decisions = reader.list_bucket_decisions(ACTIVE_LATEST_ID).unwrap();
    let new_decision = decisions
        .iter()
        .find(|decision| decision.entry_id.as_deref() == Some(entry_id))
        .unwrap();
    assert_eq!(
        new_decision.text,
        "Keep the recovery dashboard for one more day."
    );
    assert_eq!(new_decision.reason, None);

    let classification = reader
        .get_classification_record(outcome.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(classification.raw_text, RAW_TEXT);
    assert_eq!(classification.action, ClassificationAction::AppendExisting);
    assert_eq!(classification.bucket_id.as_deref(), Some(ACTIVE_LATEST_ID));
    assert_eq!(classification.entry_id.as_deref(), Some(entry_id));
    assert_eq!(classification.confidence, CONFIDENCE);
    assert_eq!(classification.reason, REASON);
    assert_eq!(
        classification.candidate_bucket_ids,
        [ACTIVE_LATEST_ID, ACTIVE_TIE_NEWER_ID]
    );
    assert_eq!(
        classification.current_focus_bucket_id.as_deref(),
        Some(ACTIVE_LATEST_ID)
    );
    assert_eq!(classification.prompt_version, PROMPT_VERSION);
    assert_eq!(classification.model_name, MODEL_NAME);
    assert!(!classification.corrected);
    assert_eq!(classification.created_at.raw(), entry.created_at.raw());
}

#[test]
fn create_new_persists_a_new_bucket_and_merged_audit_candidates() {
    let database = create_python_fixture("create");
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let classification = ClassificationResult::create_new(
        BucketType::Task,
        "  Rust archive rollout  ",
        0.93,
        "The input explicitly starts a separate rollout task.",
        vec!["model-candidate".to_owned()],
    )
    .unwrap();
    let extraction = ExtractionResult::new(
        "Prepare the isolated Rust archive rollout.",
        vec!["Run archive parity tests.".to_owned()],
        vec!["The write API passed its isolated smoke test.".to_owned()],
        vec![
            TimelineEventExtract::new(Some("today".to_owned()), "The rollout task was created.")
                .unwrap(),
        ],
        vec!["Keep Python as the production writer.".to_owned()],
        vec![],
        vec![],
        vec!["Rust".to_owned(), "rust".to_owned(), "migration".to_owned()],
    )
    .unwrap();
    let audit = ClassificationAuditContext::new(
        vec!["audit-candidate".to_owned(), "model-candidate".to_owned()],
        None,
        PROMPT_VERSION,
        MODEL_NAME,
    )
    .unwrap();
    let request = ArchiveWriteRequest::archive(
        "  Start the isolated Rust archive rollout.  ",
        classification,
        extraction,
        audit,
    )
    .unwrap();

    let outcome = store.persist_archive_attempt(&request).unwrap();
    assert!(outcome.created_bucket());
    assert_eq!(outcome.action(), ClassificationAction::CreateNew);
    assert_eq!(outcome.status(), ArchiveStatus::Archived);
    assert_eq!(outcome.bucket_title(), Some("Rust archive rollout"));
    assert_eq!(outcome.bucket_type(), Some(BucketType::Task));
    let bucket_id = outcome.bucket_id().unwrap().to_owned();
    let entry_id = outcome.entry_id().unwrap().to_owned();
    assert_uuid_v4(&bucket_id);
    drop(store);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    let bucket = reader.get_bucket(&bucket_id).unwrap().unwrap();
    assert_eq!(bucket.title, "Rust archive rollout");
    assert_eq!(bucket.bucket_type, BucketType::Task);
    assert_eq!(bucket.summary, "Prepare the isolated Rust archive rollout.");
    assert_eq!(bucket.tags, ["Rust", "migration"]);

    let entries = reader.list_bucket_entries(&bucket_id).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].id, entry_id);
    assert_eq!(
        entries[0].raw_text,
        "Start the isolated Rust archive rollout."
    );
    assert_eq!(reader.list_bucket_todos(&bucket_id).unwrap().len(), 1);
    assert_eq!(reader.list_bucket_evidences(&bucket_id).unwrap().len(), 1);
    assert_eq!(
        reader
            .list_bucket_timeline_events(&bucket_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(reader.list_bucket_decisions(&bucket_id).unwrap().len(), 1);

    let classification = reader
        .get_classification_record(outcome.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(
        classification.bucket_id.as_deref(),
        Some(bucket_id.as_str())
    );
    assert_eq!(classification.entry_id.as_deref(), Some(entry_id.as_str()));
    assert_eq!(
        classification.candidate_bucket_ids,
        ["audit-candidate", "model-candidate"]
    );
}

#[test]
fn ask_user_writes_only_classification_audit_data() {
    let database = create_python_fixture("ask-user");
    let before = table_row_counts(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let classification = ClassificationResult::ask_user(
        Some(BucketType::Incident),
        Some("Payment callback".to_owned()),
        0.42,
        "Two possible contexts remain.",
        "Which Bucket should receive this update?",
        vec![ACTIVE_TIE_NEWER_ID.to_owned()],
    )
    .unwrap();
    let audit = ClassificationAuditContext::new(
        vec![ACTIVE_LATEST_ID.to_owned()],
        Some(ACTIVE_LATEST_ID.to_owned()),
        PROMPT_VERSION,
        MODEL_NAME,
    )
    .unwrap();
    let request = ArchiveWriteRequest::needs_confirmation(
        "  Put this callback note in the right place.  ",
        classification,
        audit,
    )
    .unwrap();

    let outcome = store.persist_archive_attempt(&request).unwrap();
    assert_eq!(outcome.status(), ArchiveStatus::NeedsConfirmation);
    assert_eq!(outcome.action(), ClassificationAction::AskUser);
    assert_eq!(outcome.bucket_id(), None);
    assert_eq!(outcome.bucket_title(), None);
    assert_eq!(outcome.bucket_type(), None);
    assert_eq!(outcome.entry_id(), None);
    assert!(!outcome.created_bucket());
    assert!(outcome.todo_ids().is_empty());
    assert!(outcome.evidence_ids().is_empty());
    assert!(outcome.timeline_event_ids().is_empty());
    assert!(outcome.decision_ids().is_empty());
    drop(store);

    let after = table_row_counts(database.path());
    for table in BUSINESS_TABLES {
        let expected_delta = i64::from(*table == "classification_records");
        assert_eq!(after[*table], before[*table] + expected_delta, "{table}");
    }

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    let record = reader
        .get_classification_record(outcome.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(
        record.raw_text,
        "Put this callback note in the right place."
    );
    assert_eq!(record.action, ClassificationAction::AskUser);
    assert_eq!(record.bucket_id, None);
    assert_eq!(record.entry_id, None);
    assert_eq!(
        record.candidate_bucket_ids,
        [ACTIVE_LATEST_ID, ACTIVE_TIE_NEWER_ID]
    );
}

#[test]
fn missing_append_target_rolls_back_without_any_business_changes() {
    let database = create_python_fixture("missing-target");
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = append_request(
        "99999999-9999-9999-9999-999999999999",
        ExtractionResult::minimal("This write must not survive.").unwrap(),
    );

    let error = store.persist_archive_attempt(&request).unwrap_err();
    assert!(matches!(
        error,
        StoreError::MissingRecord { table: "buckets", id }
            if id == "99999999-9999-9999-9999-999999999999"
    ));
    drop(store);

    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn mid_archive_sqlite_failure_rolls_back_entry_children_bucket_cache_and_audit() {
    let database = create_python_fixture("trigger-rollback");
    Connection::open(database.path())
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_forced_archive_decision
             BEFORE INSERT ON decisions
             WHEN NEW.text = 'Force the archive transaction to fail.'
             BEGIN
                 SELECT RAISE(ABORT, 'forced archive failure');
             END;",
        )
        .unwrap();
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let extraction = ExtractionResult::new(
        "No part of this archive should survive.",
        vec!["Temporary todo.".to_owned()],
        vec!["Temporary evidence.".to_owned()],
        vec![TimelineEventExtract::new(None, "Temporary event.").unwrap()],
        vec!["Force the archive transaction to fail.".to_owned()],
        vec![],
        vec![],
        vec!["temporary".to_owned()],
    )
    .unwrap();

    assert!(matches!(
        store.persist_archive_attempt(&append_request(ACTIVE_LATEST_ID, extraction)),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);

    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_archive_write_matches_python_final_business_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    run_python_archive_fixture(python_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    let outcome = store
        .persist_archive_attempt(&confirmed_append_request(append_extraction()))
        .unwrap();
    assert_eq!(outcome.status(), ArchiveStatus::Archived);
    drop(store);

    assert_eq!(
        archive_semantic_snapshot(rust_database.path()),
        archive_semantic_snapshot(python_database.path())
    );
}

fn confirmed_append_request(extraction: ExtractionResult) -> ArchiveWriteRequest {
    let classification = ClassificationResult::append_existing(
        ACTIVE_LATEST_ID,
        Some(BucketType::Incident),
        CONFIDENCE,
        REASON,
        vec![],
    )
    .unwrap();
    let audit = ClassificationAuditContext::new(
        vec![ACTIVE_LATEST_ID.to_owned()],
        Some(ACTIVE_LATEST_ID.to_owned()),
        PROMPT_VERSION,
        MODEL_NAME,
    )
    .unwrap();
    ArchiveWriteRequest::archive(RAW_TEXT, classification, extraction, audit).unwrap()
}

fn append_request(bucket_id: &str, extraction: ExtractionResult) -> ArchiveWriteRequest {
    let classification = ClassificationResult::append_existing(
        bucket_id,
        Some(BucketType::Incident),
        CONFIDENCE,
        REASON,
        vec![ACTIVE_TIE_NEWER_ID.to_owned()],
    )
    .unwrap();
    let audit = ClassificationAuditContext::new(
        vec![ACTIVE_LATEST_ID.to_owned(), ACTIVE_TIE_NEWER_ID.to_owned()],
        Some(ACTIVE_LATEST_ID.to_owned()),
        PROMPT_VERSION,
        MODEL_NAME,
    )
    .unwrap();
    ArchiveWriteRequest::archive(RAW_TEXT, classification, extraction, audit).unwrap()
}

fn append_extraction() -> ExtractionResult {
    ExtractionResult::new(
        SUMMARY,
        vec![
            "Confirm callback retries remain healthy.".to_owned(),
            "Review callback dashboard.".to_owned(),
            "review   callback dashboard.".to_owned(),
        ],
        vec![
            "THE RETRY SUCCESS RATE RETURNED TO 99.9%.".to_owned(),
            "The callback error rate stayed below 0.1%.".to_owned(),
        ],
        vec![
            TimelineEventExtract::new(
                Some("2026-08-04T10:00:00Z".to_owned()),
                "Proxy restarted and callback retries recovered.",
            )
            .unwrap(),
            TimelineEventExtract::new(
                Some("during review".to_owned()),
                "The callback path stayed stable.",
            )
            .unwrap(),
        ],
        vec![
            "RETAIN THE EXISTING ALERT THRESHOLD.".to_owned(),
            "Keep the recovery dashboard for one more day.".to_owned(),
        ],
        vec!["The proxy restart resolved the transient callback errors.".to_owned()],
        vec![
            "payment callback".to_owned(),
            "recovery dashboard".to_owned(),
        ],
        vec![
            "Payments".to_owned(),
            "recovery".to_owned(),
            "RECOVERY".to_owned(),
            "稳定".to_owned(),
        ],
    )
    .unwrap()
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

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
    );
    database
}

fn run_python_archive_fixture(database_path: &Path) {
    run_python_script(
        "tests/fixtures/apply_archive_write_fixture.py",
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

fn business_snapshot(path: &Path) -> BTreeMap<String, Vec<Vec<Value>>> {
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
                        .map(|index| row.get::<_, Value>(index))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            ((*table).to_owned(), rows)
        })
        .collect()
}

#[derive(Debug, PartialEq)]
struct ArchiveSemanticSnapshot {
    bucket: BucketSnapshot,
    entry: EntrySnapshot,
    todos: Vec<(String, String, Option<String>)>,
    evidences: Vec<(String, Option<String>)>,
    timeline_events: Vec<(Option<String>, String)>,
    decisions: Vec<(String, Option<String>)>,
    classification: ClassificationSnapshot,
}

#[derive(Debug, PartialEq)]
struct BucketSnapshot {
    title: String,
    bucket_type: String,
    status: String,
    summary: String,
    tags: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct EntrySnapshot {
    raw_text: String,
    summary: Option<String>,
    content_type: String,
    confidence: Option<f64>,
    reason: Option<String>,
    moved_from_bucket_id: Option<String>,
}

#[derive(Debug, PartialEq)]
struct ClassificationSnapshot {
    raw_text: String,
    action: String,
    confidence: f64,
    reason: String,
    candidate_bucket_ids: Vec<String>,
    current_focus_bucket_id: Option<String>,
    prompt_version: String,
    model_name: String,
    corrected: i64,
}

fn archive_semantic_snapshot(path: &Path) -> ArchiveSemanticSnapshot {
    let connection = Connection::open(path).unwrap();
    let bucket = connection
        .query_row(
            "SELECT title, type, status, summary, tags FROM buckets WHERE id = ?1",
            [ACTIVE_LATEST_ID],
            |row| {
                let tags_json: String = row.get(4)?;
                Ok(BucketSnapshot {
                    title: row.get(0)?,
                    bucket_type: row.get(1)?,
                    status: row.get(2)?,
                    summary: row.get(3)?,
                    tags: serde_json::from_str(&tags_json).unwrap(),
                })
            },
        )
        .unwrap();

    let (entry_id, entry) = connection
        .query_row(
            "SELECT id, bucket_id, raw_text, summary, content_type,
                    classification_confidence, classification_reason, moved_from_bucket_id
             FROM entries
             WHERE bucket_id = ?1 AND raw_text = ?2",
            [ACTIVE_LATEST_ID, RAW_TEXT],
            |row| {
                let bucket_id: String = row.get(1)?;
                assert_eq!(bucket_id, ACTIVE_LATEST_ID);
                Ok((
                    row.get::<_, String>(0)?,
                    EntrySnapshot {
                        raw_text: row.get(2)?,
                        summary: row.get(3)?,
                        content_type: row.get(4)?,
                        confidence: row.get(5)?,
                        reason: row.get(6)?,
                        moved_from_bucket_id: row.get(7)?,
                    },
                ))
            },
        )
        .unwrap();

    let mut todos = query_child_rows(
        &connection,
        "SELECT bucket_id, text, status, due_date FROM todos WHERE entry_id = ?1",
        &entry_id,
        |row| Ok((row.get(1)?, row.get(2)?, row.get(3)?)),
    );
    todos.sort();
    let mut evidences = query_child_rows(
        &connection,
        "SELECT bucket_id, text, source FROM evidences WHERE entry_id = ?1",
        &entry_id,
        |row| Ok((row.get(1)?, row.get(2)?)),
    );
    evidences.sort();
    let mut timeline_events = query_child_rows(
        &connection,
        "SELECT bucket_id, event_time, text FROM timeline_events WHERE entry_id = ?1",
        &entry_id,
        |row| Ok((row.get(1)?, row.get(2)?)),
    );
    timeline_events.sort();
    let mut decisions = query_child_rows(
        &connection,
        "SELECT bucket_id, text, reason FROM decisions WHERE entry_id = ?1",
        &entry_id,
        |row| Ok((row.get(1)?, row.get(2)?)),
    );
    decisions.sort();

    let classification = connection
        .query_row(
            "SELECT bucket_id, raw_text, action, confidence, reason,
                    candidate_bucket_ids, current_focus_bucket_id,
                    prompt_version, model_name, corrected
             FROM classification_records
             WHERE entry_id = ?1",
            [&entry_id],
            |row| {
                let bucket_id: Option<String> = row.get(0)?;
                assert_eq!(bucket_id.as_deref(), Some(ACTIVE_LATEST_ID));
                let candidates_json: String = row.get(5)?;
                Ok(ClassificationSnapshot {
                    raw_text: row.get(1)?,
                    action: row.get(2)?,
                    confidence: row.get(3)?,
                    reason: row.get(4)?,
                    candidate_bucket_ids: serde_json::from_str(&candidates_json).unwrap(),
                    current_focus_bucket_id: row.get(6)?,
                    prompt_version: row.get(7)?,
                    model_name: row.get(8)?,
                    corrected: row.get(9)?,
                })
            },
        )
        .unwrap();

    ArchiveSemanticSnapshot {
        bucket,
        entry,
        todos,
        evidences,
        timeline_events,
        decisions,
        classification,
    }
}

fn query_child_rows<T>(
    connection: &Connection,
    sql: &str,
    entry_id: &str,
    decode: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Vec<T> {
    let mut statement = connection.prepare(sql).unwrap();
    statement
        .query_map([entry_id], |row| {
            let bucket_id: String = row.get(0)?;
            assert_eq!(bucket_id, ACTIVE_LATEST_ID);
            decode(row)
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}
