mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use work_memory_core::{ExtractionResult, TimelineEventExtract};
use work_memory_service::{ExtractionPersistenceService, ExtractionSaveResult, ServiceError};
use work_memory_store::{SqliteStore, StoreError};

const BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const ENTRY_ID: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_ENTRY_ID: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SUMMARY: &str = "The callback path remained stable during the recovery review.";
const EXPECTED_BUCKET_SUMMARY: &str = "Investigating callback failures.\nThe callback path remained stable during the recovery review.";
const MINIMAL_SUMMARY: &str = "Minimal standalone extraction summary.";
const FULL_TWICE: &str = "full_twice";
const MINIMAL: &str = "minimal";

#[test]
fn save_extraction_matches_python_results_and_database_semantics() {
    let python_database = create_python_fixture("full-python");
    let rust_database = create_python_fixture("full-rust");
    let before = load_bucket(rust_database.path());
    let python_result = run_python_json(
        "tests/fixtures/apply_extraction_persistence_service_fixture.py",
        python_database.path(),
        &[FULL_TWICE],
    );

    let mut service = ExtractionPersistenceService::open_existing(rust_database.path()).unwrap();
    let first = service
        .save_extraction(BUCKET_ID, ENTRY_ID, extraction_fixture())
        .unwrap();
    let duplicate = service
        .save_extraction(BUCKET_ID, ENTRY_ID, extraction_fixture())
        .unwrap();
    assert_eq!(
        json!({
            "first": result_payload(&first),
            "duplicate": result_payload(&duplicate),
        }),
        python_result
    );
    assert_eq!(first.todo_ids().len(), 2);
    assert_eq!(first.evidence_ids().len(), 1);
    assert_eq!(first.timeline_event_ids().len(), 2);
    assert_eq!(first.decision_ids().len(), 1);
    assert!(duplicate.todo_ids().is_empty());
    assert!(duplicate.evidence_ids().is_empty());
    assert!(duplicate.timeline_event_ids().is_empty());
    assert!(duplicate.decision_ids().is_empty());
    drop(service);

    let reader = SqliteStore::open_read_only(rust_database.path()).unwrap();
    let bucket = reader.get_bucket(BUCKET_ID).unwrap().unwrap();
    let entry = reader
        .list_bucket_entries(BUCKET_ID)
        .unwrap()
        .into_iter()
        .find(|entry| entry.id == ENTRY_ID)
        .unwrap();
    assert_eq!(bucket.summary, EXPECTED_BUCKET_SUMMARY);
    assert_eq!(
        bucket.tags,
        ["payments", "callback", "支付", "recovery", "稳定"]
    );
    assert_eq!(bucket.last_active_at, before.last_active_at);
    assert_ne!(bucket.updated_at, before.updated_at);
    assert_eq!(entry.summary.as_deref(), Some(SUMMARY));
    drop(reader);

    assert_database_parity(&rust_database, &python_database);
}

#[test]
fn minimal_extraction_matches_python_without_creating_children() {
    let python_database = create_python_fixture("minimal-python");
    let rust_database = create_python_fixture("minimal-rust");
    let python_result = run_python_json(
        "tests/fixtures/apply_extraction_persistence_service_fixture.py",
        python_database.path(),
        &[MINIMAL],
    );

    let mut service = ExtractionPersistenceService::open_existing(rust_database.path()).unwrap();
    let result = service
        .save_extraction(
            BUCKET_ID,
            ENTRY_ID,
            ExtractionResult::minimal(MINIMAL_SUMMARY).unwrap(),
        )
        .unwrap();
    assert_eq!(result_payload(&result), python_result);
    assert!(result.todo_ids().is_empty());
    assert!(result.evidence_ids().is_empty());
    assert!(result.timeline_event_ids().is_empty());
    assert!(result.decision_ids().is_empty());
    drop(service);

    assert_database_parity(&rust_database, &python_database);
}

#[test]
fn missing_or_mismatched_targets_leave_the_database_unchanged() {
    let database = create_python_fixture("missing");
    let before = export_database(database.path());
    let bucket_before = load_bucket(database.path());
    let requested_bucket_id = format!(" {BUCKET_ID} ");
    let requested_entry_id = format!(" {ENTRY_ID} ");
    let mut service = ExtractionPersistenceService::open_existing(database.path()).unwrap();

    assert!(matches!(
        service.save_extraction(
            &requested_bucket_id,
            ENTRY_ID,
            ExtractionResult::minimal("Missing Bucket extraction").unwrap(),
        ),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "buckets",
            id,
        })) if id == requested_bucket_id
    ));
    assert!(matches!(
        service.save_extraction(
            BUCKET_ID,
            &requested_entry_id,
            ExtractionResult::minimal("Missing Entry extraction").unwrap(),
        ),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "entries",
            id,
        })) if id == requested_entry_id
    ));
    assert!(matches!(
        service.save_extraction(
            BUCKET_ID,
            OTHER_ENTRY_ID,
            ExtractionResult::minimal("Wrong Bucket extraction").unwrap(),
        ),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "entries",
            id,
        })) if id == OTHER_ENTRY_ID
    ));
    drop(service);

    assert_eq!(load_bucket(database.path()), bucket_before);
    assert_eq!(export_database(database.path()), before);
}

fn extraction_fixture() -> ExtractionResult {
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

fn result_payload(result: &ExtractionSaveResult) -> Value {
    let ids = result
        .todo_ids()
        .iter()
        .chain(result.evidence_ids())
        .chain(result.timeline_event_ids())
        .chain(result.decision_ids())
        .collect::<Vec<_>>();
    json!({
        "bucket_id": result.bucket_id(),
        "entry_id": result.entry_id(),
        "todo_count": result.todo_ids().len(),
        "evidence_count": result.evidence_ids().len(),
        "timeline_event_count": result.timeline_event_ids().len(),
        "decision_count": result.decision_ids().len(),
        "all_ids_are_uuid_v4": ids.iter().all(|id| is_uuid_v4(id)),
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

fn load_bucket(path: &Path) -> work_memory_store::StoredBucket {
    SqliteStore::open_read_only(path)
        .unwrap()
        .get_bucket(BUCKET_ID)
        .unwrap()
        .unwrap()
}

fn assert_database_parity(rust_database: &TemporaryDatabase, python_database: &TemporaryDatabase) {
    assert_eq!(
        export_database(rust_database.path()),
        export_database(python_database.path())
    );
}

fn export_database(database_path: &Path) -> Value {
    run_python_json(
        "tests/fixtures/export_extraction_persistence_service_fixture.py",
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
