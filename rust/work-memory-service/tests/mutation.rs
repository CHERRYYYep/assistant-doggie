mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use work_memory_core::BucketType;
use work_memory_service::{MemoryMutationService, ServiceError};
use work_memory_store::{
    DeleteBucketOutcome, DeleteEntryOutcome, SqliteStore, StoreError, StoredBucket, StoredEntry,
};

const ACTIVE_LATEST_ID: &str = "11111111-1111-1111-1111-111111111111";
const ENTRY_ID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TODO_ID: &str = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const EVIDENCE_ID: &str = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CLASSIFICATION_ID: &str = "13131313-1313-1313-1313-131313131313";

const CREATE_TITLE: &str = "R3e standalone Bucket";
const CREATE_SUMMARY: &str = "Initial standalone summary.";
const APPEND_RAW_TEXT: &str = "R3e standalone Entry.";
const APPEND_SUMMARY: &str = "Standalone entry summary.";
const APPEND_CONTENT_TYPE: &str = "log";
const APPEND_CONFIDENCE: f64 = 0.82;
const APPEND_REASON: &str = "Explicit standalone append.";

const CREATE: &str = "create";
const APPEND: &str = "append";
const DELETE_ENTRY: &str = "delete_entry";
const DELETE_BUCKET: &str = "delete_bucket";

#[test]
fn create_bucket_matches_python_result_and_database_semantics() {
    let python_database = create_python_fixture("create-python");
    let rust_database = create_python_fixture("create-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_memory_mutation_service_fixture.py",
        python_database.path(),
        CREATE,
    );

    let mut service = MemoryMutationService::open_existing(rust_database.path()).unwrap();
    let bucket = service
        .create_bucket(
            format!("  {CREATE_TITLE}  "),
            BucketType::Task,
            format!("  {CREATE_SUMMARY}  "),
            vec![
                " rust ".to_owned(),
                String::new(),
                "migration".to_owned(),
                "rust".to_owned(),
            ],
        )
        .unwrap();
    assert_eq!(bucket.title, CREATE_TITLE);
    assert_eq!(bucket.summary, CREATE_SUMMARY);
    assert_eq!(bucket.tags, ["rust", "migration", "rust"]);
    assert_eq!(bucket_result_payload(&bucket), python_result);
    drop(service);

    assert_database_parity(&rust_database, &python_database, CREATE);
}

#[test]
fn append_entry_matches_python_result_and_database_semantics() {
    let python_database = create_python_fixture("append-python");
    let rust_database = create_python_fixture("append-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_memory_mutation_service_fixture.py",
        python_database.path(),
        APPEND,
    );

    let mut service = MemoryMutationService::open_existing(rust_database.path()).unwrap();
    let entry = service
        .append_entry(
            ACTIVE_LATEST_ID,
            format!("  {APPEND_RAW_TEXT}  "),
            Some(format!("  {APPEND_SUMMARY}  ")),
            format!("  {APPEND_CONTENT_TYPE}  "),
            Some(APPEND_CONFIDENCE),
            Some(format!("  {APPEND_REASON}  ")),
        )
        .unwrap();
    drop(service);

    let reader = SqliteStore::open_read_only(rust_database.path()).unwrap();
    let bucket = reader.get_bucket(ACTIVE_LATEST_ID).unwrap().unwrap();
    assert_eq!(entry.raw_text, APPEND_RAW_TEXT);
    assert_eq!(entry.summary.as_deref(), Some(APPEND_SUMMARY));
    assert_eq!(entry.content_type, APPEND_CONTENT_TYPE);
    assert_eq!(entry.classification_reason.as_deref(), Some(APPEND_REASON));
    assert_eq!(entry_result_payload(&entry, &bucket), python_result);
    drop(reader);

    assert_database_parity(&rust_database, &python_database, APPEND);
}

#[test]
fn delete_entry_matches_python_outcome_and_database_semantics() {
    let python_database = create_python_fixture("delete-entry-python");
    let rust_database = create_python_fixture("delete-entry-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_memory_mutation_service_fixture.py",
        python_database.path(),
        DELETE_ENTRY,
    );

    let mut service = MemoryMutationService::open_existing(rust_database.path()).unwrap();
    let outcome = service.delete_entry(ENTRY_ID).unwrap();
    assert_eq!(outcome.entry_id(), ENTRY_ID);
    assert_eq!(outcome.bucket_id(), ACTIVE_LATEST_ID);
    assert_eq!(outcome.cleared_todo_ids(), [TODO_ID]);
    assert_eq!(outcome.cleared_evidence_ids(), [EVIDENCE_ID]);
    assert_eq!(outcome.cleared_timeline_event_ids(), [] as [&str; 0]);
    assert_eq!(outcome.cleared_decision_ids(), [] as [&str; 0]);
    assert_eq!(
        outcome.cleared_classification_entry_ids(),
        [CLASSIFICATION_ID]
    );
    assert_eq!(delete_entry_result_payload(&outcome), python_result);
    drop(service);

    assert_database_parity(&rust_database, &python_database, DELETE_ENTRY);
}

#[test]
fn delete_bucket_matches_python_outcome_and_database_semantics() {
    let python_database = create_python_fixture("delete-bucket-python");
    let rust_database = create_python_fixture("delete-bucket-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_memory_mutation_service_fixture.py",
        python_database.path(),
        DELETE_BUCKET,
    );

    let mut service = MemoryMutationService::open_existing(rust_database.path()).unwrap();
    let outcome = service.delete_bucket(ACTIVE_LATEST_ID).unwrap();
    assert_eq!(outcome.bucket_id(), ACTIVE_LATEST_ID);
    assert_eq!(outcome.entry_ids().len(), 2);
    assert_eq!(outcome.todo_ids().len(), 2);
    assert_eq!(outcome.evidence_ids().len(), 2);
    assert_eq!(outcome.timeline_event_ids().len(), 2);
    assert_eq!(outcome.decision_ids().len(), 2);
    assert_eq!(
        outcome.cleared_classification_entry_ids(),
        [CLASSIFICATION_ID]
    );
    assert_eq!(delete_bucket_result_payload(&outcome), python_result);
    drop(service);

    assert_database_parity(&rust_database, &python_database, DELETE_BUCKET);
}

#[test]
fn invalid_and_missing_mutations_leave_the_database_unchanged() {
    let database = create_python_fixture("failures");
    let mut service = MemoryMutationService::open_existing(database.path()).unwrap();

    assert!(matches!(
        service.create_bucket(" \t\n ", BucketType::Task, "", vec![]),
        Err(ServiceError::Store(StoreError::InvalidWriteField {
            field: "title",
            ..
        }))
    ));
    assert!(matches!(
        service.append_entry(
            ACTIVE_LATEST_ID,
            "valid text",
            None,
            "note",
            Some(f64::NAN),
            None,
        ),
        Err(ServiceError::Store(StoreError::InvalidWriteField {
            field: "classification_confidence",
            ..
        }))
    ));
    assert!(matches!(
        service.append_entry("missing-bucket", "valid text", None, "note", None, None),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "buckets",
            ..
        }))
    ));
    assert!(matches!(
        service.delete_entry("missing-entry"),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "entries",
            ..
        }))
    ));
    assert!(matches!(
        service.delete_bucket("missing-bucket"),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "buckets",
            ..
        }))
    ));
    drop(service);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    assert_eq!(reader.list_active_buckets(20).unwrap().len(), 3);
    assert_eq!(
        reader.list_bucket_entries(ACTIVE_LATEST_ID).unwrap().len(),
        2
    );
    assert_eq!(reader.list_bucket_todos(ACTIVE_LATEST_ID).unwrap().len(), 2);
    assert_eq!(
        reader
            .list_bucket_evidences(ACTIVE_LATEST_ID)
            .unwrap()
            .len(),
        2
    );
    assert!(
        reader
            .list_bucket_entries(ACTIVE_LATEST_ID)
            .unwrap()
            .iter()
            .any(|entry| entry.id == ENTRY_ID)
    );
}

fn bucket_result_payload(bucket: &StoredBucket) -> Value {
    json!({
        "id_is_uuid_v4": is_uuid_v4(&bucket.id),
        "title": bucket.title,
        "bucket_type": bucket.bucket_type.as_str(),
        "status": bucket.status.as_str(),
        "summary": bucket.summary,
        "tags": bucket.tags,
    })
}

fn entry_result_payload(entry: &StoredEntry, bucket: &StoredBucket) -> Value {
    json!({
        "id_is_uuid_v4": is_uuid_v4(&entry.id),
        "bucket_id": entry.bucket_id,
        "raw_text": entry.raw_text,
        "summary": entry.summary,
        "content_type": entry.content_type,
        "classification_confidence": entry.classification_confidence,
        "classification_reason": entry.classification_reason,
        "moved_from_bucket_id": entry.moved_from_bucket_id,
        "activity_matches_entry": entry.created_at.raw() == bucket.updated_at.raw()
            && bucket.updated_at.raw() == bucket.last_active_at.raw(),
    })
}

fn delete_entry_result_payload(outcome: &DeleteEntryOutcome) -> Value {
    json!({
        "entry_id": outcome.entry_id(),
        "bucket_id": outcome.bucket_id(),
        "cleared_todo_ids": outcome.cleared_todo_ids(),
        "cleared_evidence_ids": outcome.cleared_evidence_ids(),
        "cleared_timeline_event_ids": outcome.cleared_timeline_event_ids(),
        "cleared_decision_ids": outcome.cleared_decision_ids(),
        "cleared_classification_entry_ids": outcome.cleared_classification_entry_ids(),
    })
}

fn delete_bucket_result_payload(outcome: &DeleteBucketOutcome) -> Value {
    json!({
        "bucket_id": outcome.bucket_id(),
        "entry_ids": outcome.entry_ids(),
        "todo_ids": outcome.todo_ids(),
        "evidence_ids": outcome.evidence_ids(),
        "timeline_event_ids": outcome.timeline_event_ids(),
        "decision_ids": outcome.decision_ids(),
        "cleared_classification_entry_ids": outcome.cleared_classification_entry_ids(),
    })
}

fn is_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes[14] == b'4'
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn assert_database_parity(
    rust_database: &TemporaryDatabase,
    python_database: &TemporaryDatabase,
    scenario: &str,
) {
    let rust_snapshot = run_python_json(
        "tests/fixtures/export_memory_mutation_service_fixture.py",
        rust_database.path(),
        scenario,
    );
    let python_snapshot = run_python_json(
        "tests/fixtures/export_memory_mutation_service_fixture.py",
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
