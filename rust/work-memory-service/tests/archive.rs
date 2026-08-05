mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use work_memory_core::{
    ArchiveResult, ArchiveStatus, BucketType, ClassificationAction, ClassificationResult,
    ExtractionResult, TimelineEventExtract,
};
use work_memory_service::{ArchiveService, CLASSIFICATION_PROMPT_VERSION, ServiceError};
use work_memory_store::{ClassificationAuditContext, SqliteStore, StoreError};

const ACTIVE_LATEST_ID: &str = "11111111-1111-1111-1111-111111111111";
const ACTIVE_TIE_NEWER_ID: &str = "22222222-2222-2222-2222-222222222222";
const ACTIVE_TIE_OLDER_ID: &str = "33333333-3333-3333-3333-333333333333";
const MODEL_NAME: &str = "archive-service-fixture-model";

const CONFIRMED_EXISTING: &str = "confirmed_existing";
const CONFIRMED_NEW: &str = "confirmed_new";
const NEEDS_CONFIRMATION: &str = "needs_confirmation";

const EXISTING_RAW_TEXT: &str = "Payment recovery review found the callback path stable.";
const EXISTING_SUMMARY: &str = "The callback path remained stable during the recovery review.";
const EXISTING_CONFIDENCE: f64 = 0.88;
const EXISTING_REASON: &str = "The update explicitly continues the active callback incident.";

const NEW_RAW_TEXT: &str = "Create a durable launch checklist for the API rollout.";
const NEW_TITLE: &str = "API rollout checklist";
const NEW_SUMMARY: &str = "A durable API rollout checklist is ready to track.";
const NEW_CONFIDENCE: f64 = 0.93;
const NEW_REASON: &str = "The user explicitly confirmed a new rollout checklist.";

const ASK_RAW_TEXT: &str = "Continue that rollout item.";
const ASK_TITLE: &str = "API rollout ambiguity";
const ASK_CONFIDENCE: f64 = 0.42;
const ASK_REASON: &str = "Multiple active Buckets could match the vague continuation.";
const ASK_QUESTION: &str = "Which active Bucket should receive this update?";

#[test]
fn confirmed_existing_service_matches_python_result_and_database_semantics() {
    let python_database = create_python_fixture("confirmed-existing-python");
    let rust_database = create_python_fixture("confirmed-existing-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_archive_service_fixture.py",
        python_database.path(),
        CONFIRMED_EXISTING,
    );

    let mut service = ArchiveService::open_existing(rust_database.path()).unwrap();
    let result = service
        .archive_confirmed_input(
            format!("  {EXISTING_RAW_TEXT}  "),
            ACTIVE_LATEST_ID,
            existing_extraction(),
            EXISTING_CONFIDENCE,
            EXISTING_REASON,
            MODEL_NAME,
        )
        .unwrap();
    assert_eq!(result.status(), ArchiveStatus::Archived);
    assert_eq!(result.action(), ClassificationAction::AppendExisting);
    assert_eq!(result.bucket_id(), Some(ACTIVE_LATEST_ID));
    assert_eq!(result.bucket_title(), Some("Payment callback incident"));
    assert_eq!(result.bucket_type(), Some(BucketType::Incident));
    assert!(result.entry_id().is_some());
    assert_eq!(result.extraction(), Some(&existing_extraction()));
    assert_eq!(
        archive_result_payload(&result, CONFIRMED_EXISTING),
        python_result
    );
    drop(service);

    assert_database_parity(&rust_database, &python_database, CONFIRMED_EXISTING);
}

#[test]
fn confirmed_new_service_matches_python_result_and_database_semantics() {
    let python_database = create_python_fixture("confirmed-new-python");
    let rust_database = create_python_fixture("confirmed-new-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_archive_service_fixture.py",
        python_database.path(),
        CONFIRMED_NEW,
    );

    let mut service = ArchiveService::open_existing(rust_database.path()).unwrap();
    let result = service
        .archive_confirmed_new_input(
            NEW_RAW_TEXT,
            format!("  {NEW_TITLE}  "),
            BucketType::Task,
            new_extraction(),
            NEW_CONFIDENCE,
            NEW_REASON,
            MODEL_NAME,
        )
        .unwrap();
    assert_eq!(result.status(), ArchiveStatus::Archived);
    assert_eq!(result.action(), ClassificationAction::CreateNew);
    assert!(result.bucket_id().is_some());
    assert_eq!(result.bucket_title(), Some(NEW_TITLE));
    assert_eq!(result.bucket_type(), Some(BucketType::Task));
    assert!(result.entry_id().is_some());
    assert_eq!(result.extraction(), Some(&new_extraction()));
    assert_eq!(
        archive_result_payload(&result, CONFIRMED_NEW),
        python_result
    );
    drop(service);

    assert_database_parity(&rust_database, &python_database, CONFIRMED_NEW);
}

#[test]
fn ask_user_service_matches_python_result_and_persists_only_the_audit() {
    let python_database = create_python_fixture("ask-user-python");
    let rust_database = create_python_fixture("ask-user-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_archive_service_fixture.py",
        python_database.path(),
        NEEDS_CONFIRMATION,
    );

    let classification = ClassificationResult::ask_user(
        Some(BucketType::Task),
        Some(ASK_TITLE.to_owned()),
        ASK_CONFIDENCE,
        ASK_REASON,
        ASK_QUESTION,
        vec![ACTIVE_LATEST_ID.to_owned(), ACTIVE_TIE_NEWER_ID.to_owned()],
    )
    .unwrap();
    let audit = ClassificationAuditContext::new(
        vec![
            ACTIVE_LATEST_ID.to_owned(),
            ACTIVE_TIE_NEWER_ID.to_owned(),
            ACTIVE_TIE_OLDER_ID.to_owned(),
        ],
        Some(ACTIVE_LATEST_ID.to_owned()),
        CLASSIFICATION_PROMPT_VERSION,
        MODEL_NAME,
    )
    .unwrap();
    let mut service = ArchiveService::open_existing(rust_database.path()).unwrap();
    let result = service
        .archive_classified_input(ASK_RAW_TEXT, classification, None, audit)
        .unwrap();
    assert_eq!(result.status(), ArchiveStatus::NeedsConfirmation);
    assert_eq!(result.action(), ClassificationAction::AskUser);
    assert_eq!(result.bucket_id(), None);
    assert_eq!(result.bucket_title(), Some(ASK_TITLE));
    assert_eq!(result.bucket_type(), Some(BucketType::Task));
    assert_eq!(result.entry_id(), None);
    assert_eq!(result.question(), Some(ASK_QUESTION));
    assert_eq!(
        result.candidate_bucket_ids(),
        [ACTIVE_LATEST_ID, ACTIVE_TIE_NEWER_ID]
    );
    assert_eq!(result.extraction(), None);
    assert_eq!(
        archive_result_payload(&result, NEEDS_CONFIRMATION),
        python_result
    );
    drop(service);

    assert_database_parity(&rust_database, &python_database, NEEDS_CONFIRMATION);
}

#[test]
fn archive_service_rejects_invalid_or_incomplete_attempts_before_writing() {
    let database = create_python_fixture("invalid-attempts");
    let mut service = ArchiveService::open_existing(database.path()).unwrap();

    let create_classification = ClassificationResult::create_new(
        BucketType::Task,
        NEW_TITLE,
        NEW_CONFIDENCE,
        NEW_REASON,
        vec![],
    )
    .unwrap();
    let audit = audit_context();
    assert!(matches!(
        service.archive_classified_input(NEW_RAW_TEXT, create_classification, None, audit.clone()),
        Err(ServiceError::MissingExtraction {
            action: "create_new"
        })
    ));

    let ask_classification = ClassificationResult::ask_user(
        None,
        None,
        ASK_CONFIDENCE,
        ASK_REASON,
        ASK_QUESTION,
        vec![],
    )
    .unwrap();
    assert!(matches!(
        service.archive_classified_input(
            ASK_RAW_TEXT,
            ask_classification,
            Some(ExtractionResult::minimal("must not persist").unwrap()),
            audit
        ),
        Err(ServiceError::UnexpectedExtraction)
    ));

    assert!(matches!(
        service.archive_confirmed_new_input(
            " \n\t ",
            NEW_TITLE,
            BucketType::Task,
            new_extraction(),
            NEW_CONFIDENCE,
            NEW_REASON,
            MODEL_NAME,
        ),
        Err(ServiceError::EmptyArchiveText)
    ));
    drop(service);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    assert_eq!(reader.list_active_buckets(10).unwrap().len(), 3);
    assert_eq!(
        reader.list_bucket_entries(ACTIVE_LATEST_ID).unwrap().len(),
        2
    );
}

#[test]
fn missing_confirmed_target_rolls_back_without_partial_archive_state() {
    let database = create_python_fixture("missing-target");
    let mut service = ArchiveService::open_existing(database.path()).unwrap();
    let error = service
        .archive_confirmed_input(
            EXISTING_RAW_TEXT,
            "missing-bucket",
            existing_extraction(),
            EXISTING_CONFIDENCE,
            EXISTING_REASON,
            MODEL_NAME,
        )
        .unwrap_err();
    assert!(matches!(
        error.store_error(),
        Some(StoreError::MissingRecord {
            table: "buckets",
            id
        }) if id == "missing-bucket"
    ));
    drop(service);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    assert_eq!(reader.list_active_buckets(10).unwrap().len(), 3);
    assert_eq!(
        reader.list_bucket_entries(ACTIVE_LATEST_ID).unwrap().len(),
        2
    );
}

fn existing_extraction() -> ExtractionResult {
    ExtractionResult::new(
        EXISTING_SUMMARY,
        vec!["Review callback dashboard.".to_owned()],
        vec!["The callback error rate stayed below 0.1%.".to_owned()],
        vec![
            TimelineEventExtract::new(
                Some("during review".to_owned()),
                "The callback path stayed stable.",
            )
            .unwrap(),
        ],
        vec!["Keep the recovery dashboard for one more day.".to_owned()],
        vec!["The proxy restart resolved the transient errors.".to_owned()],
        vec![
            "payment callback".to_owned(),
            "recovery dashboard".to_owned(),
        ],
        vec![
            "payments".to_owned(),
            "recovery".to_owned(),
            "稳定".to_owned(),
        ],
    )
    .unwrap()
}

fn new_extraction() -> ExtractionResult {
    ExtractionResult::new(
        NEW_SUMMARY,
        vec!["Verify the rollback owner before launch.".to_owned()],
        vec!["The rollout requires a durable checklist.".to_owned()],
        vec![
            TimelineEventExtract::new(
                Some("before launch".to_owned()),
                "The rollout checklist must be verified.",
            )
            .unwrap(),
        ],
        vec!["Track the rollout in a dedicated Bucket.".to_owned()],
        vec!["A checklist will reduce missed rollout steps.".to_owned()],
        vec!["API rollout".to_owned()],
        vec![
            "api".to_owned(),
            "rollout".to_owned(),
            "checklist".to_owned(),
        ],
    )
    .unwrap()
}

fn audit_context() -> ClassificationAuditContext {
    ClassificationAuditContext::new(vec![], None, CLASSIFICATION_PROMPT_VERSION, MODEL_NAME)
        .unwrap()
}

fn archive_result_payload(result: &ArchiveResult, scenario: &str) -> Value {
    let bucket_id_kind = match result.bucket_id() {
        None => Value::Null,
        Some(ACTIVE_LATEST_ID) if scenario == CONFIRMED_EXISTING => json!("existing"),
        Some(_) => json!("generated"),
    };
    json!({
        "status": result.status().as_str(),
        "action": result.action().as_str(),
        "bucket_title": result.bucket_title(),
        "bucket_type": result.bucket_type().map(BucketType::as_str),
        "confidence": result.confidence(),
        "reason": result.reason(),
        "question": result.question(),
        "candidate_bucket_ids": result.candidate_bucket_ids(),
        "extraction": result.extraction().map(extraction_payload),
        "bucket_id_kind": bucket_id_kind,
        "entry_id_present": result.entry_id().is_some(),
    })
}

fn extraction_payload(extraction: &ExtractionResult) -> Value {
    json!({
        "summary": extraction.summary(),
        "todos": extraction.todos(),
        "evidences": extraction.evidences(),
        "timeline_events": extraction
            .timeline_events()
            .iter()
            .map(|event| json!({
                "event_time": event.event_time(),
                "text": event.text(),
            }))
            .collect::<Vec<_>>(),
        "decisions": extraction.decisions(),
        "hypotheses": extraction.hypotheses(),
        "entities": extraction.entities(),
        "tags": extraction.tags(),
    })
}

fn assert_database_parity(
    rust_database: &TemporaryDatabase,
    python_database: &TemporaryDatabase,
    scenario: &str,
) {
    let rust_snapshot = run_python_json(
        "tests/fixtures/export_archive_service_fixture.py",
        rust_database.path(),
        scenario,
    );
    let python_snapshot = run_python_json(
        "tests/fixtures/export_archive_service_fixture.py",
        python_database.path(),
        scenario,
    );
    assert_eq!(rust_snapshot, python_snapshot);
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
        None,
    );
    database
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn python_command(relative_script: &str, database_path: &Path, scenario: Option<&str>) -> Command {
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
        .env("PYTHONPATH", &repository_root)
        .current_dir(repository_root);
    if let Some(scenario) = scenario {
        command.arg(scenario);
    }
    command
}

fn run_python_script(relative_script: &str, database_path: &Path, scenario: Option<&str>) {
    let output = python_command(relative_script, database_path, scenario)
        .output()
        .expect("Python fixture helper must start");
    assert!(
        output.status.success(),
        "Python fixture helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_python_json(relative_script: &str, database_path: &Path, scenario: &str) -> Value {
    let output = python_command(relative_script, database_path, Some(scenario))
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
