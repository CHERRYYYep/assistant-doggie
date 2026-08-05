mod support;

use support::{TemporaryPath as TemporaryDatabase, is_uuid_v4};

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use work_memory_service::{
    CorrectionResult, CorrectionService, ENTRY_TARGET_TYPE, MOVE_ENTRY_ACTION, ServiceError,
};
use work_memory_store::{SqliteStore, StoreError};

const ACTIVE_LATEST_ID: &str = "11111111-1111-1111-1111-111111111111";
const ACTIVE_TIE_NEWER_ID: &str = "22222222-2222-2222-2222-222222222222";
const DIRECT_ENTRY_ID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LATEST_ENTRY_ID: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CLASSIFICATION_ID: &str = "13131313-1313-1313-1313-131313131313";
const TODO_ID: &str = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const EVIDENCE_ID: &str = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const DIRECT_COMMAND: &str = "Move the callback failure into the review Bucket.";
const LATEST_EXPLICIT_COMMAND: &str = "Move the latest review note into the callback incident.";
const LATEST_COMMAND: &str = "刚才那条不要放到 Newer tie-break update，放到 Payment callback 里。";

const DIRECT: &str = "direct";
const LATEST_EXPLICIT: &str = "latest_explicit";
const LATEST_FROM_COMMAND: &str = "latest_from_command";

#[test]
fn explicit_entry_move_matches_python_result_and_database_semantics() {
    let python_database = create_python_fixture("direct-python");
    let rust_database = create_python_fixture("direct-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_correction_service_fixture.py",
        python_database.path(),
        DIRECT,
    );

    let mut service = CorrectionService::open_existing(rust_database.path()).unwrap();
    let result = service
        .move_entry(
            DIRECT_ENTRY_ID,
            ACTIVE_TIE_NEWER_ID,
            format!("  {DIRECT_COMMAND}  "),
        )
        .unwrap();
    assert_eq!(result.command_text(), DIRECT_COMMAND);
    assert_eq!(result.action(), MOVE_ENTRY_ACTION);
    assert_eq!(result.target_type(), ENTRY_TARGET_TYPE);
    assert_eq!(result.entry_id(), DIRECT_ENTRY_ID);
    assert_eq!(result.source_bucket_id(), ACTIVE_LATEST_ID);
    assert_eq!(result.target_bucket_id(), ACTIVE_TIE_NEWER_ID);
    assert_eq!(result.todo_ids(), [TODO_ID]);
    assert_eq!(result.evidence_ids(), [EVIDENCE_ID]);
    assert_eq!(result.timeline_event_ids(), [] as [&str; 0]);
    assert_eq!(result.decision_ids(), [] as [&str; 0]);
    assert_eq!(
        result.corrected_classification_record_ids(),
        [CLASSIFICATION_ID]
    );
    assert_eq!(correction_result_payload(&result), python_result);
    drop(service);

    assert_database_parity(&rust_database, &python_database, DIRECT);
}

#[test]
fn latest_entry_with_explicit_target_matches_python() {
    let python_database = create_python_fixture("latest-explicit-python");
    let rust_database = create_python_fixture("latest-explicit-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_correction_service_fixture.py",
        python_database.path(),
        LATEST_EXPLICIT,
    );

    let mut service = CorrectionService::open_existing(rust_database.path()).unwrap();
    let result = service
        .move_latest_entry(
            format!("  {LATEST_EXPLICIT_COMMAND}  "),
            Some(ACTIVE_LATEST_ID),
        )
        .unwrap();
    assert_eq!(result.entry_id(), LATEST_ENTRY_ID);
    assert_eq!(result.source_bucket_id(), ACTIVE_TIE_NEWER_ID);
    assert_eq!(result.target_bucket_id(), ACTIVE_LATEST_ID);
    assert_eq!(correction_result_payload(&result), python_result);
    drop(service);

    assert_database_parity(&rust_database, &python_database, LATEST_EXPLICIT);
}

#[test]
fn latest_entry_command_resolution_uses_the_final_destination_and_matches_python() {
    let python_database = create_python_fixture("latest-command-python");
    let rust_database = create_python_fixture("latest-command-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_correction_service_fixture.py",
        python_database.path(),
        LATEST_FROM_COMMAND,
    );

    let mut service = CorrectionService::open_existing(rust_database.path()).unwrap();
    let result = service.move_latest_entry(LATEST_COMMAND, None).unwrap();
    assert_eq!(result.entry_id(), LATEST_ENTRY_ID);
    assert_eq!(result.source_bucket_id(), ACTIVE_TIE_NEWER_ID);
    assert_eq!(result.target_bucket_id(), ACTIVE_LATEST_ID);
    assert_eq!(correction_result_payload(&result), python_result);
    drop(service);

    assert_database_parity(&rust_database, &python_database, LATEST_FROM_COMMAND);
}

#[test]
fn correction_service_rejects_unsafe_or_unresolvable_requests_without_writes() {
    let database = create_python_fixture("invalid-requests");
    let mut service = CorrectionService::open_existing(database.path()).unwrap();

    assert!(matches!(
        service.move_entry(DIRECT_ENTRY_ID, ACTIVE_TIE_NEWER_ID, " \n\t "),
        Err(ServiceError::EmptyCorrectionCommand)
    ));
    assert!(matches!(
        service.move_latest_entry("move the latest entry", None),
        Err(ServiceError::UnrecognizedCorrectionTarget)
    ));
    assert!(matches!(
        service.move_entry("missing-entry", ACTIVE_TIE_NEWER_ID, "Move a missing entry"),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "entries",
            ..
        }))
    ));
    assert!(matches!(
        service.move_latest_entry("把刚才那条放到不存在的 Bucket 里。", None),
        Err(ServiceError::Store(
            StoreError::NoMatchingCorrectionBucket { .. }
        ))
    ));
    assert!(matches!(
        service.move_latest_entry("把刚才那条放到 tie-break update 里。", None),
        Err(ServiceError::Store(
            StoreError::AmbiguousCorrectionBucket { .. }
        ))
    ));
    assert!(matches!(
        service.move_latest_entry("把刚才那条放到 Newer tie-break update 里。", None),
        Err(ServiceError::Store(StoreError::InvalidCorrectionWrite {
            action: "move_entry",
            reason: "entry already belongs to the target bucket",
        }))
    ));
    drop(service);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    assert_eq!(
        reader
            .list_target_corrections("entry", LATEST_ENTRY_ID)
            .unwrap(),
        []
    );
    assert_eq!(
        reader
            .list_bucket_entries(ACTIVE_TIE_NEWER_ID)
            .unwrap()
            .into_iter()
            .filter(|entry| entry.id == LATEST_ENTRY_ID)
            .count(),
        1
    );
}

fn correction_result_payload(result: &CorrectionResult) -> Value {
    json!({
        "correction_id_is_uuid_v4": is_uuid_v4(result.correction_id()),
        "command_text": result.command_text(),
        "action": result.action(),
        "target_type": result.target_type(),
        "entry_id": result.entry_id(),
        "source_bucket_id": result.source_bucket_id(),
        "target_bucket_id": result.target_bucket_id(),
        "todo_ids": result.todo_ids(),
        "evidence_ids": result.evidence_ids(),
        "timeline_event_ids": result.timeline_event_ids(),
        "decision_ids": result.decision_ids(),
        "corrected_classification_record_ids": result.corrected_classification_record_ids(),
    })
}

fn assert_database_parity(
    rust_database: &TemporaryDatabase,
    python_database: &TemporaryDatabase,
    scenario: &str,
) {
    let rust_snapshot = run_python_json(
        "tests/fixtures/export_correction_service_fixture.py",
        rust_database.path(),
        scenario,
    );
    let python_snapshot = run_python_json(
        "tests/fixtures/export_correction_service_fixture.py",
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
