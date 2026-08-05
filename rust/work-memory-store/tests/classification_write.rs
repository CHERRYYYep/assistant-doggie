mod support;

use support::{TemporaryPath as TemporaryDatabase, assert_uuid_v4};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use work_memory_core::{BucketType, ClassificationAction, ClassificationResult};
use work_memory_store::{
    SaveClassificationRecordRequest, SqliteStore, StoreError, WritableSqliteStore,
};

const RAW_TEXT_INPUT: &str = "  Callback retries stayed healthy after the proxy recovery.  ";
const RAW_TEXT: &str = "Callback retries stayed healthy after the proxy recovery.";
const TARGET_BUCKET_ID: &str = "missing-audit-bucket";
const CURRENT_FOCUS_BUCKET_ID: &str = " focus-bucket ";
const PROMPT_VERSION: &str = "classification-v2";
const MODEL_NAME: &str = " fixture-model ";
const REASON: &str = "The note continues the callback recovery investigation.";
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
#[derive(Debug, PartialEq)]
struct ClassificationSemanticSnapshot {
    raw_text: String,
    action: String,
    bucket_id: Option<String>,
    entry_id: Option<String>,
    confidence: f64,
    reason: String,
    candidate_bucket_ids: Vec<String>,
    current_focus_bucket_id: Option<String>,
    prompt_version: String,
    model_name: String,
    corrected: i64,
    table_counts: BTreeMap<String, i64>,
}

#[test]
fn save_classification_request_matches_python_input_and_metadata_boundaries() {
    let classification = classification_fixture();
    let server_candidates = server_candidate_bucket_ids();
    let request = SaveClassificationRecordRequest::new(
        RAW_TEXT_INPUT,
        classification.clone(),
        server_candidates.clone(),
        Some(CURRENT_FOCUS_BUCKET_ID.to_owned()),
        PROMPT_VERSION,
        MODEL_NAME,
    );

    assert_eq!(request.raw_text(), RAW_TEXT);
    assert_eq!(request.classification(), &classification);
    assert_eq!(request.server_candidate_bucket_ids(), server_candidates);
    assert_eq!(
        request.current_focus_bucket_id(),
        Some(CURRENT_FOCUS_BUCKET_ID)
    );
    assert_eq!(request.prompt_version(), PROMPT_VERSION);
    assert_eq!(request.model_name(), MODEL_NAME);

    let blank = SaveClassificationRecordRequest::new(
        " \t\n ",
        ask_user_fixture(),
        vec![],
        None,
        PROMPT_VERSION,
        MODEL_NAME,
    );
    assert_eq!(blank.raw_text(), "");
}

#[test]
fn save_classification_persists_one_complete_audit_row_only() {
    let database = create_python_fixture("complete");
    let before_counts = table_row_counts(database.path());
    let unaffected_before = unaffected_business_snapshot(database.path());
    let request = classification_request();
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let outcome = store.save_classification_record(&request).unwrap();
    assert_uuid_v4(outcome.classification_record_id());
    drop(store);

    let after_counts = table_row_counts(database.path());
    for table in BUSINESS_TABLES {
        let expected_increment = i64::from(*table == "classification_records");
        assert_eq!(
            after_counts[*table],
            before_counts[*table] + expected_increment
        );
    }
    assert_eq!(
        unaffected_business_snapshot(database.path()),
        unaffected_before
    );

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    let record = reader
        .get_classification_record(outcome.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(record.raw_text, RAW_TEXT);
    assert_eq!(record.action, ClassificationAction::AppendExisting);
    assert_eq!(record.bucket_id.as_deref(), Some(TARGET_BUCKET_ID));
    assert_eq!(record.entry_id, None);
    assert_eq!(record.confidence, 0.87);
    assert_eq!(record.reason, REASON);
    assert_eq!(record.candidate_bucket_ids, expected_candidate_bucket_ids());
    assert_eq!(
        record.current_focus_bucket_id.as_deref(),
        Some(CURRENT_FOCUS_BUCKET_ID)
    );
    assert_eq!(record.prompt_version, PROMPT_VERSION);
    assert_eq!(record.model_name, MODEL_NAME);
    assert!(!record.corrected);
}

#[test]
fn save_classification_supports_all_actions_empty_text_and_repeated_audits() {
    let database = create_python_fixture("actions");
    let before_counts = table_row_counts(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let append_request = classification_request();
    let first_append = store.save_classification_record(&append_request).unwrap();
    let second_append = store.save_classification_record(&append_request).unwrap();
    assert_ne!(
        first_append.classification_record_id(),
        second_append.classification_record_id()
    );

    let create_request = SaveClassificationRecordRequest::new(
        "  ",
        ClassificationResult::create_new(
            BucketType::Task,
            "Audit-only task",
            0.72,
            "A separate task was suggested.",
            vec![],
        )
        .unwrap(),
        vec![],
        None,
        PROMPT_VERSION,
        "fixture-model",
    );
    let create = store.save_classification_record(&create_request).unwrap();

    let ask_request = SaveClassificationRecordRequest::new(
        "Needs a destination.",
        ask_user_fixture(),
        vec!["server-choice".to_owned()],
        None,
        PROMPT_VERSION,
        "fixture-model",
    );
    let ask = store.save_classification_record(&ask_request).unwrap();
    drop(store);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    let create_record = reader
        .get_classification_record(create.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(create_record.raw_text, "");
    assert_eq!(create_record.action, ClassificationAction::CreateNew);
    assert_eq!(create_record.bucket_id, None);
    assert_eq!(create_record.entry_id, None);

    let ask_record = reader
        .get_classification_record(ask.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(ask_record.action, ClassificationAction::AskUser);
    assert_eq!(ask_record.bucket_id.as_deref(), Some("suggested-bucket"));
    assert_eq!(ask_record.entry_id, None);
    assert_eq!(
        ask_record.candidate_bucket_ids,
        ["server-choice", "model-choice"]
    );

    let after_counts = table_row_counts(database.path());
    assert_eq!(
        after_counts["classification_records"],
        before_counts["classification_records"] + 4
    );
    for table in BUSINESS_TABLES
        .iter()
        .copied()
        .filter(|table| *table != "classification_records")
    {
        assert_eq!(after_counts[table], before_counts[table]);
    }
}

#[test]
fn save_classification_failure_rolls_back_without_business_changes() {
    let database = create_python_fixture("rollback");
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fail_classification_insert
             BEFORE INSERT ON classification_records
             BEGIN
                 SELECT RAISE(ABORT, 'simulated classification insert failure');
             END;",
        )
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    assert!(matches!(
        store.save_classification_record(&classification_request()),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);

    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_save_classification_matches_python_service_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    run_python_script(
        "tests/fixtures/apply_save_classification_fixture.py",
        python_database.path(),
    );

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    store
        .save_classification_record(&classification_request())
        .unwrap();
    drop(store);

    assert_eq!(
        classification_semantic_snapshot(rust_database.path()),
        classification_semantic_snapshot(python_database.path())
    );
    assert_eq!(
        unaffected_business_snapshot(rust_database.path()),
        unaffected_business_snapshot(python_database.path())
    );
}

fn classification_fixture() -> ClassificationResult {
    ClassificationResult::append_existing(
        TARGET_BUCKET_ID,
        None,
        0.87,
        REASON,
        vec![
            " shared ".to_owned(),
            "model-candidate".to_owned(),
            "spaced".to_owned(),
            "SHARED".to_owned(),
        ],
    )
    .unwrap()
}

fn ask_user_fixture() -> ClassificationResult {
    ClassificationResult::try_new(
        ClassificationAction::AskUser,
        Some("suggested-bucket".to_owned()),
        None,
        None,
        0.41,
        "The target remains ambiguous.",
        true,
        Some("Which Bucket should receive this note?".to_owned()),
        vec!["model-choice".to_owned()],
    )
    .unwrap()
}

fn classification_request() -> SaveClassificationRecordRequest {
    SaveClassificationRecordRequest::new(
        RAW_TEXT_INPUT,
        classification_fixture(),
        server_candidate_bucket_ids(),
        Some(CURRENT_FOCUS_BUCKET_ID.to_owned()),
        PROMPT_VERSION,
        MODEL_NAME,
    )
}

fn server_candidate_bucket_ids() -> Vec<String> {
    vec![
        "server-candidate".to_owned(),
        "shared".to_owned(),
        "server-candidate".to_owned(),
        String::new(),
        " spaced ".to_owned(),
    ]
}

fn expected_candidate_bucket_ids() -> Vec<String> {
    vec![
        "server-candidate".to_owned(),
        "shared".to_owned(),
        String::new(),
        " spaced ".to_owned(),
        "model-candidate".to_owned(),
        "spaced".to_owned(),
        "SHARED".to_owned(),
    ]
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
    );
    database
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

fn classification_semantic_snapshot(path: &Path) -> ClassificationSemanticSnapshot {
    let connection = Connection::open(path).unwrap();
    connection
        .query_row(
            "SELECT raw_text, action, bucket_id, entry_id, confidence, reason,
                    candidate_bucket_ids, current_focus_bucket_id, prompt_version,
                    model_name, corrected
             FROM classification_records
             WHERE raw_text = ?1 AND model_name = ?2
             ORDER BY created_at DESC, id DESC
             LIMIT 1",
            [RAW_TEXT, MODEL_NAME],
            |row| {
                let candidates_json: String = row.get(6)?;
                Ok(ClassificationSemanticSnapshot {
                    raw_text: row.get(0)?,
                    action: row.get(1)?,
                    bucket_id: row.get(2)?,
                    entry_id: row.get(3)?,
                    confidence: row.get(4)?,
                    reason: row.get(5)?,
                    candidate_bucket_ids: serde_json::from_str(&candidates_json).unwrap(),
                    current_focus_bucket_id: row.get(7)?,
                    prompt_version: row.get(8)?,
                    model_name: row.get(9)?,
                    corrected: row.get(10)?,
                    table_counts: table_row_counts(path),
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

fn unaffected_business_snapshot(path: &Path) -> BTreeMap<String, Vec<Vec<SqlValue>>> {
    let connection = Connection::open(path).unwrap();
    BUSINESS_TABLES
        .iter()
        .copied()
        .filter(|table| *table != "classification_records")
        .map(|table| (table.to_owned(), table_snapshot(&connection, table)))
        .collect()
}

fn business_snapshot(path: &Path) -> BTreeMap<String, Vec<Vec<SqlValue>>> {
    let connection = Connection::open(path).unwrap();
    BUSINESS_TABLES
        .iter()
        .map(|table| ((*table).to_owned(), table_snapshot(&connection, table)))
        .collect()
}

fn table_snapshot(connection: &Connection, table: &str) -> Vec<Vec<SqlValue>> {
    let sql = format!("SELECT * FROM {table} ORDER BY id");
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
