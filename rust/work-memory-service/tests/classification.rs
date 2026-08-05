mod support;

use support::{TemporaryPath as TemporaryDatabase, is_uuid_v4};

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use work_memory_core::{BucketType, ClassificationAction, ClassificationResult};
use work_memory_service::{
    ClassificationAuditSaveResult, ClassificationAuditService, ServiceError,
};
use work_memory_store::{SqliteStore, StoreError};

const RAW_TEXT_INPUT: &str = "  Callback retries stayed healthy after the proxy recovery.  ";
const RAW_TEXT: &str = "Callback retries stayed healthy after the proxy recovery.";
const TARGET_BUCKET_ID: &str = "missing-audit-bucket";
const CURRENT_FOCUS_BUCKET_ID: &str = " focus-bucket ";
const PROMPT_VERSION: &str = "classification-v2";
const MODEL_NAME: &str = " fixture-model ";
const REASON: &str = "The note continues the callback recovery investigation.";
const CREATE_MODEL_NAME: &str = " create-model ";
const ASK_MODEL_NAME: &str = " ask-model ";
const ASK_FOCUS_BUCKET_ID: &str = " ask-focus ";
const APPEND_TWICE: &str = "append_twice";
const ALL_ACTIONS: &str = "all_actions";
const INSTALL_FAILURE_TRIGGER: &str = "install_failure_trigger";

#[test]
fn repeated_append_audits_match_python_results_and_database_semantics() {
    let python_database = create_python_fixture("append-python");
    let rust_database = create_python_fixture("append-rust");
    let before = export_database(rust_database.path());
    let python_result = run_python_json(
        "tests/fixtures/apply_classification_audit_service_fixture.py",
        python_database.path(),
        &[APPEND_TWICE],
    );

    let mut service = ClassificationAuditService::open_existing(rust_database.path()).unwrap();
    let first = service
        .save_classification_record(
            RAW_TEXT_INPUT,
            append_classification(),
            server_candidate_bucket_ids(),
            Some(CURRENT_FOCUS_BUCKET_ID.to_owned()),
            PROMPT_VERSION,
            MODEL_NAME,
        )
        .unwrap();
    let duplicate = service
        .save_classification_record(
            RAW_TEXT_INPUT,
            append_classification(),
            server_candidate_bucket_ids(),
            Some(CURRENT_FOCUS_BUCKET_ID.to_owned()),
            PROMPT_VERSION,
            MODEL_NAME,
        )
        .unwrap();
    assert_eq!(
        json!({
            "first": result_payload(&first),
            "duplicate": result_payload(&duplicate),
            "ids_are_distinct": first.classification_record_id()
                != duplicate.classification_record_id(),
        }),
        python_result
    );
    assert_ne!(
        first.classification_record_id(),
        duplicate.classification_record_id()
    );
    drop(service);

    let reader = SqliteStore::open_read_only(rust_database.path()).unwrap();
    let record = reader
        .get_classification_record(first.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(record.raw_text, RAW_TEXT);
    assert_eq!(record.action, ClassificationAction::AppendExisting);
    assert_eq!(record.bucket_id.as_deref(), Some(TARGET_BUCKET_ID));
    assert_eq!(record.entry_id, None);
    assert_eq!(record.confidence, 0.87);
    assert_eq!(record.reason, REASON);
    assert_eq!(
        record.candidate_bucket_ids,
        [
            "server-candidate",
            "shared",
            "",
            " spaced ",
            "model-candidate",
            "spaced",
            "SHARED",
        ]
    );
    assert_eq!(
        record.current_focus_bucket_id.as_deref(),
        Some(CURRENT_FOCUS_BUCKET_ID)
    );
    assert_eq!(record.prompt_version, PROMPT_VERSION);
    assert_eq!(record.model_name, MODEL_NAME);
    assert!(!record.corrected);
    drop(reader);

    let after = export_database(rust_database.path());
    assert_only_classification_records_changed(&before, &after);
    assert_database_parity(&rust_database, &python_database);
}

#[test]
fn create_and_ask_user_audits_match_python_metadata_boundaries() {
    let python_database = create_python_fixture("actions-python");
    let rust_database = create_python_fixture("actions-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_classification_audit_service_fixture.py",
        python_database.path(),
        &[ALL_ACTIONS],
    );

    let mut service = ClassificationAuditService::open_existing(rust_database.path()).unwrap();
    let created = service
        .save_classification_record(
            " \t\n ",
            create_classification(),
            vec!["created-server".to_owned(), "shared".to_owned()],
            None,
            PROMPT_VERSION,
            CREATE_MODEL_NAME,
        )
        .unwrap();
    let asked = service
        .save_classification_record(
            "  Which recovery Bucket does this belong to?  ",
            ask_user_classification(),
            vec!["server-choice".to_owned(), "shared".to_owned()],
            Some(ASK_FOCUS_BUCKET_ID.to_owned()),
            PROMPT_VERSION,
            ASK_MODEL_NAME,
        )
        .unwrap();
    assert_eq!(
        json!({
            "created": result_payload(&created),
            "asked": result_payload(&asked),
        }),
        python_result
    );
    drop(service);

    let reader = SqliteStore::open_read_only(rust_database.path()).unwrap();
    let create_record = reader
        .get_classification_record(created.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(create_record.raw_text, "");
    assert_eq!(create_record.action, ClassificationAction::CreateNew);
    assert_eq!(create_record.bucket_id, None);
    assert_eq!(
        create_record.candidate_bucket_ids,
        ["created-server", "shared", "created-model"]
    );
    assert_eq!(create_record.current_focus_bucket_id, None);
    assert_eq!(create_record.model_name, CREATE_MODEL_NAME);

    let ask_record = reader
        .get_classification_record(asked.classification_record_id())
        .unwrap()
        .unwrap();
    assert_eq!(
        ask_record.raw_text,
        "Which recovery Bucket does this belong to?"
    );
    assert_eq!(ask_record.action, ClassificationAction::AskUser);
    assert_eq!(ask_record.bucket_id.as_deref(), Some("suggested-bucket"));
    assert_eq!(
        ask_record.candidate_bucket_ids,
        ["server-choice", "shared", "model-choice"]
    );
    assert_eq!(
        ask_record.current_focus_bucket_id.as_deref(),
        Some(ASK_FOCUS_BUCKET_ID)
    );
    assert_eq!(ask_record.model_name, ASK_MODEL_NAME);
    drop(reader);

    assert_database_parity(&rust_database, &python_database);
}

#[test]
fn classification_insert_failure_leaves_the_database_unchanged() {
    let database = create_python_fixture("failure");
    run_python_json(
        "tests/fixtures/apply_classification_audit_service_fixture.py",
        database.path(),
        &[INSTALL_FAILURE_TRIGGER],
    );
    let before = export_database(database.path());
    let mut service = ClassificationAuditService::open_existing(database.path()).unwrap();

    assert!(matches!(
        service.save_classification_record(
            RAW_TEXT_INPUT,
            append_classification(),
            server_candidate_bucket_ids(),
            Some(CURRENT_FOCUS_BUCKET_ID.to_owned()),
            PROMPT_VERSION,
            MODEL_NAME,
        ),
        Err(ServiceError::Store(StoreError::Sqlite(_)))
    ));
    drop(service);

    assert_eq!(export_database(database.path()), before);
}

fn append_classification() -> ClassificationResult {
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

fn create_classification() -> ClassificationResult {
    ClassificationResult::create_new(
        BucketType::Knowledge,
        "Callback recovery notes",
        0.76,
        "The note establishes a standalone recovery reference.",
        vec![" created-model ".to_owned(), "shared".to_owned()],
    )
    .unwrap()
}

fn ask_user_classification() -> ClassificationResult {
    ClassificationResult::try_new(
        ClassificationAction::AskUser,
        Some("suggested-bucket".to_owned()),
        None,
        None,
        0.41,
        "The intended Bucket remains ambiguous.",
        true,
        Some("Which Bucket should receive this note?".to_owned()),
        vec!["model-choice".to_owned(), "shared".to_owned()],
    )
    .unwrap()
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

fn result_payload(result: &ClassificationAuditSaveResult) -> Value {
    json!({
        "classification_record_id_is_uuid_v4": is_uuid_v4(
            result.classification_record_id()
        ),
    })
}

fn assert_only_classification_records_changed(before: &Value, after: &Value) {
    let before_rows = before["rows"].as_object().unwrap();
    let after_rows = after["rows"].as_object().unwrap();
    for (table, rows) in before_rows {
        if table != "classification_records" {
            assert_eq!(after_rows.get(table), Some(rows), "table changed: {table}");
        }
    }
    assert_ne!(
        before_rows.get("classification_records"),
        after_rows.get("classification_records")
    );
}

fn assert_database_parity(rust_database: &TemporaryDatabase, python_database: &TemporaryDatabase) {
    assert_eq!(
        export_database(rust_database.path()),
        export_database(python_database.path())
    );
}

fn export_database(database_path: &Path) -> Value {
    run_python_json(
        "tests/fixtures/export_classification_audit_service_fixture.py",
        database_path,
        &[],
    )
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
        &[],
    );
    database
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn python_command(relative_script: &str, database_path: &Path, args: &[&str]) -> Command {
    let repository_root = repository_root();
    let virtualenv_python = repository_root.join(".venv/bin/python");
    let python = if virtualenv_python.is_file() {
        virtualenv_python
    } else {
        PathBuf::from("python3")
    };
    let mut command = Command::new(python);
    command
        .arg(repository_root.join(relative_script))
        .arg(database_path)
        .args(args)
        .env("PYTHONPATH", &repository_root)
        .current_dir(repository_root);
    command
}

fn run_python_script(relative_script: &str, database_path: &Path, args: &[&str]) {
    let output = python_command(relative_script, database_path, args)
        .output()
        .expect("Python fixture helper must start");
    assert!(
        output.status.success(),
        "Python fixture helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_python_json(relative_script: &str, database_path: &Path, args: &[&str]) -> Value {
    let output = python_command(relative_script, database_path, args)
        .output()
        .expect("Python parity helper must start");
    assert!(
        output.status.success(),
        "Python parity helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("Python helper must emit JSON")
}
