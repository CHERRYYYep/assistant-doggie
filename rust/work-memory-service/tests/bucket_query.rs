mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use work_memory_service::{BucketDetail, BucketQueryService, ServiceError};
use work_memory_store::{
    StoreError, StoredBucket, StoredDecision, StoredEntry, StoredEvidence, StoredTimelineEvent,
    StoredTodo,
};

const ACTIVE_LATEST_ID: &str = "11111111-1111-1111-1111-111111111111";
const ACTIVE_TIE_NEWER_ID: &str = "22222222-2222-2222-2222-222222222222";
const PAUSED_ID: &str = "44444444-4444-4444-4444-444444444444";
const MISSING_ID: &str = "missing-bucket";
#[test]
fn bucket_query_service_preserves_python_lookup_ordering_and_limits() {
    let database = create_python_fixture("lookups");
    let service = BucketQueryService::open_read_only(database.path()).unwrap();

    let active = service.list_active_buckets(2).unwrap();
    assert_eq!(
        active
            .iter()
            .map(|bucket| bucket.id.as_str())
            .collect::<Vec<_>>(),
        [ACTIVE_LATEST_ID, ACTIVE_TIE_NEWER_ID]
    );

    let paused = service.get_bucket(PAUSED_ID).unwrap().unwrap();
    assert_eq!(paused.id, PAUSED_ID);
    assert_eq!(paused.status.as_str(), "paused");
    assert_eq!(service.get_bucket(MISSING_ID).unwrap(), None);

    assert!(matches!(
        service.list_active_buckets(0),
        Err(ServiceError::Store(StoreError::InvalidLimit(0)))
    ));
}

#[test]
fn bucket_query_service_loads_the_complete_python_detail_aggregate() {
    let database = create_python_fixture("detail");
    let service = BucketQueryService::open_read_only(database.path()).unwrap();

    let detail = service
        .get_bucket_detail(ACTIVE_LATEST_ID)
        .unwrap()
        .unwrap();
    assert_eq!(detail.bucket.id, ACTIVE_LATEST_ID);
    assert_eq!(detail.entries.len(), 2);
    assert_eq!(detail.todos.len(), 2);
    assert_eq!(detail.evidences.len(), 2);
    assert_eq!(detail.timeline_events.len(), 2);
    assert_eq!(detail.decisions.len(), 2);
    assert_eq!(
        detail
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        [
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        ]
    );
    assert_eq!(
        detail
            .todos
            .iter()
            .map(|todo| todo.id.as_str())
            .collect::<Vec<_>>(),
        [
            "dddddddd-dddd-dddd-dddd-dddddddddddd",
            "d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2"
        ]
    );
    assert_eq!(service.get_bucket_detail(MISSING_ID).unwrap(), None);
}

#[test]
fn rust_bucket_query_service_matches_python_service_semantics() {
    let database = create_python_fixture("parity");
    let service = BucketQueryService::open_read_only(database.path()).unwrap();

    let rust_payload = json!({
        "active": service
            .list_active_buckets(2)
            .unwrap()
            .iter()
            .map(bucket_payload)
            .collect::<Vec<_>>(),
        "paused": service
            .get_bucket(PAUSED_ID)
            .unwrap()
            .as_ref()
            .map(bucket_payload),
        "missing_bucket": service.get_bucket(MISSING_ID).unwrap().is_none(),
        "detail": service
            .get_bucket_detail(ACTIVE_LATEST_ID)
            .unwrap()
            .as_ref()
            .map(detail_payload),
        "missing_detail": service.get_bucket_detail(MISSING_ID).unwrap().is_none(),
    });
    let python_payload = run_python_json(
        "tests/fixtures/export_bucket_query_fixture.py",
        database.path(),
    );

    assert_eq!(rust_payload, python_payload);
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
    );
    database
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn python_command(relative_script: &str, database_path: &Path) -> Command {
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
    command
}

fn run_python_script(relative_script: &str, database_path: &Path) {
    let output = python_command(relative_script, database_path)
        .output()
        .expect("Python fixture helper must start");
    assert!(
        output.status.success(),
        "Python fixture helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_python_json(relative_script: &str, database_path: &Path) -> Value {
    let output = python_command(relative_script, database_path)
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

fn bucket_payload(bucket: &StoredBucket) -> Value {
    json!({
        "id": bucket.id,
        "title": bucket.title,
        "type": bucket.bucket_type.as_str(),
        "status": bucket.status.as_str(),
        "summary": bucket.summary,
        "tags": bucket.tags,
        "created_at": bucket.created_at.raw(),
        "updated_at": bucket.updated_at.raw(),
        "last_active_at": bucket.last_active_at.raw(),
    })
}

fn detail_payload(detail: &BucketDetail) -> Value {
    json!({
        "bucket": bucket_payload(&detail.bucket),
        "entries": detail.entries.iter().map(entry_payload).collect::<Vec<_>>(),
        "todos": detail.todos.iter().map(todo_payload).collect::<Vec<_>>(),
        "evidences": detail.evidences.iter().map(evidence_payload).collect::<Vec<_>>(),
        "timeline_events": detail
            .timeline_events
            .iter()
            .map(timeline_event_payload)
            .collect::<Vec<_>>(),
        "decisions": detail.decisions.iter().map(decision_payload).collect::<Vec<_>>(),
    })
}

fn entry_payload(entry: &StoredEntry) -> Value {
    json!({
        "id": entry.id,
        "bucket_id": entry.bucket_id,
        "raw_text": entry.raw_text,
        "summary": entry.summary,
        "content_type": entry.content_type,
        "classification_confidence": entry.classification_confidence,
        "classification_reason": entry.classification_reason,
        "created_at": entry.created_at.raw(),
        "moved_from_bucket_id": entry.moved_from_bucket_id,
    })
}

fn todo_payload(todo: &StoredTodo) -> Value {
    json!({
        "id": todo.id,
        "bucket_id": todo.bucket_id,
        "entry_id": todo.entry_id,
        "text": todo.text,
        "status": todo.status.as_str(),
        "due_date": todo.due_date.as_ref().map(|value| value.raw()),
        "created_at": todo.created_at.raw(),
        "updated_at": todo.updated_at.raw(),
    })
}

fn evidence_payload(evidence: &StoredEvidence) -> Value {
    json!({
        "id": evidence.id,
        "bucket_id": evidence.bucket_id,
        "entry_id": evidence.entry_id,
        "text": evidence.text,
        "source": evidence.source,
        "created_at": evidence.created_at.raw(),
    })
}

fn timeline_event_payload(event: &StoredTimelineEvent) -> Value {
    json!({
        "id": event.id,
        "bucket_id": event.bucket_id,
        "entry_id": event.entry_id,
        "event_time": event.event_time,
        "text": event.text,
        "created_at": event.created_at.raw(),
    })
}

fn decision_payload(decision: &StoredDecision) -> Value {
    json!({
        "id": decision.id,
        "bucket_id": decision.bucket_id,
        "entry_id": decision.entry_id,
        "text": decision.text,
        "reason": decision.reason,
        "created_at": decision.created_at.raw(),
    })
}
