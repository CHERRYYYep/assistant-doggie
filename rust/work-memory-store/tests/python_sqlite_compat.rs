mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;
use work_memory_contracts::ChatRole;
use work_memory_core::{BucketStatus, BucketType, ClassificationAction};
use work_memory_store::{SqliteStore, StoreError, TodoStatus};

const ACTIVE_LATEST_ID: &str = "11111111-1111-1111-1111-111111111111";
const ACTIVE_TIE_NEWER_ID: &str = "22222222-2222-2222-2222-222222222222";
const ACTIVE_TIE_OLDER_ID: &str = "33333333-3333-3333-3333-333333333333";
const PAUSED_ID: &str = "44444444-4444-4444-4444-444444444444";
#[test]
fn reads_all_python_created_business_rows_without_write_access() {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("store crate must live under rust/");
    let database = TemporaryDatabase::new("python-sqlite-compat");
    create_python_fixture(repository_root, database.path());

    let store = SqliteStore::open_read_only(database.path()).expect("fixture schema must be valid");
    assert!(
        store
            .is_read_only()
            .expect("query-only flag must be readable")
    );

    let active = store
        .list_active_buckets(10)
        .expect("active buckets must be readable");
    let active_ids: Vec<_> = active.iter().map(|bucket| bucket.id.as_str()).collect();
    assert_eq!(
        active_ids,
        [ACTIVE_LATEST_ID, ACTIVE_TIE_NEWER_ID, ACTIVE_TIE_OLDER_ID]
    );

    let limited = store
        .list_active_buckets(2)
        .expect("limit must be applied after Python-compatible ordering");
    assert_eq!(limited.len(), 2);
    assert_eq!(limited[0].id, ACTIVE_LATEST_ID);
    assert_eq!(limited[1].id, ACTIVE_TIE_NEWER_ID);

    let latest = store
        .get_bucket(ACTIVE_LATEST_ID)
        .expect("bucket lookup must succeed")
        .expect("fixture bucket must exist");
    assert_eq!(latest.bucket_type, BucketType::Incident);
    assert_eq!(latest.status, BucketStatus::Active);
    assert_eq!(latest.tags, ["payments", "callback", "支付"]);
    assert_eq!(latest.created_at.raw(), "2026-08-04 08:00:00.123456");
    assert_eq!(
        latest.created_at.utc_naive().to_string(),
        "2026-08-04 08:00:00.123456"
    );

    let paused = store
        .get_bucket(PAUSED_ID)
        .expect("paused bucket lookup must succeed")
        .expect("paused fixture bucket must exist");
    assert_eq!(paused.status, BucketStatus::Paused);
    assert_eq!(paused.bucket_type, BucketType::Experiment);
    assert_eq!(
        store
            .get_bucket("missing")
            .expect("missing lookup must work"),
        None
    );

    let entries = store
        .list_bucket_entries(ACTIVE_LATEST_ID)
        .expect("entries must be readable");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    assert_eq!(entries[0].classification_confidence, Some(0.91));
    assert_eq!(entries[0].created_at.raw(), "2026-08-04 09:00:00.654321");
    assert_eq!(entries[1].id, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    assert_eq!(entries[1].summary, None);
    assert_eq!(entries[1].classification_confidence, None);
    assert_eq!(entries[1].moved_from_bucket_id.as_deref(), Some(PAUSED_ID));
    assert!(
        store
            .list_bucket_entries("missing")
            .expect("missing bucket entries query must work")
            .is_empty()
    );

    let todos = store
        .list_bucket_todos(ACTIVE_LATEST_ID)
        .expect("todos must be readable");
    assert_eq!(todos.len(), 2);
    assert_eq!(todos[0].id, "dddddddd-dddd-dddd-dddd-dddddddddddd");
    assert_eq!(todos[0].status, TodoStatus::Open);
    assert_eq!(
        todos[0].due_date.as_ref().map(|value| value.raw()),
        Some("2026-08-04 18:00:00.000000")
    );
    assert_eq!(todos[1].status, TodoStatus::Cancelled);
    assert_eq!(todos[1].entry_id, None);
    assert_eq!(todos[1].due_date, None);

    let evidences = store
        .list_bucket_evidences(ACTIVE_LATEST_ID)
        .expect("evidence must be readable");
    assert_eq!(evidences.len(), 2);
    assert_eq!(
        evidences[0].source.as_deref(),
        Some("metrics/payment-callback")
    );
    assert_eq!(evidences[1].source, None);
    assert_eq!(evidences[1].entry_id, None);

    let timeline = store
        .list_bucket_timeline_events(ACTIVE_LATEST_ID)
        .expect("timeline events must be readable");
    assert_eq!(timeline.len(), 2);
    assert_eq!(
        timeline[0].event_time.as_deref(),
        Some("2026-08-04T10:00:00Z")
    );
    assert_eq!(timeline[1].event_time, None);

    let decisions = store
        .list_bucket_decisions(ACTIVE_LATEST_ID)
        .expect("decisions must be readable");
    assert_eq!(decisions.len(), 2);
    assert_eq!(
        decisions[0].reason.as_deref(),
        Some("Error rate stayed below the rollback threshold.")
    );
    assert_eq!(decisions[1].reason, None);

    let classification = store
        .get_classification_record("13131313-1313-1313-1313-131313131313")
        .expect("classification lookup must succeed")
        .expect("classification fixture must exist");
    assert_eq!(classification.action, ClassificationAction::AppendExisting);
    assert_eq!(classification.confidence, 0.91);
    assert_eq!(
        classification.candidate_bucket_ids,
        [ACTIVE_LATEST_ID, ACTIVE_TIE_NEWER_ID]
    );
    assert!(!classification.corrected);

    let unarchived_classification = store
        .get_classification_record("13232323-2323-2323-2323-232323232323")
        .expect("unarchived classification lookup must succeed")
        .expect("unarchived classification fixture must exist");
    assert_eq!(
        unarchived_classification.action,
        ClassificationAction::AskUser
    );
    assert_eq!(unarchived_classification.bucket_id, None);
    assert_eq!(unarchived_classification.entry_id, None);
    assert!(unarchived_classification.candidate_bucket_ids.is_empty());
    assert!(unarchived_classification.corrected);

    let entry_classifications = store
        .list_entry_classification_records("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        .expect("entry classifications must be readable");
    assert_eq!(entry_classifications.len(), 1);
    assert_eq!(entry_classifications[0].id, classification.id);

    let correction = store
        .get_correction("14141414-1414-1414-1414-141414141414")
        .expect("correction lookup must succeed")
        .expect("correction fixture must exist");
    assert_eq!(correction.action, "move_entry");
    assert_eq!(correction.target_type, "entry");
    assert_eq!(
        correction.before_json,
        Some(json!({"bucket_id": PAUSED_ID}))
    );
    assert_eq!(
        correction.after_json,
        Some(json!({"bucket_id": ACTIVE_LATEST_ID, "reason": "用户纠正"}))
    );
    let entry_corrections = store
        .list_target_corrections("entry", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        .expect("target corrections must be readable");
    assert_eq!(entry_corrections, [correction]);

    let list_correction = store
        .get_correction("14242424-2424-2424-2424-242424242424")
        .expect("list correction lookup must succeed")
        .expect("list correction fixture must exist");
    assert_eq!(
        list_correction.before_json,
        Some(json!(["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]))
    );
    assert_eq!(list_correction.after_json, None);

    let messages = store
        .list_chat_messages(10)
        .expect("chat messages must be readable");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0].role, ChatRole::User);
    assert_eq!(messages[0].details_json, None);
    assert_eq!(messages[1].role, ChatRole::Assistant);
    assert_eq!(
        messages[1].details_json,
        Some(json!({"bucket_id": ACTIVE_LATEST_ID, "ok": true}))
    );
    assert_eq!(messages[2].role, ChatRole::Tool);
    assert_eq!(
        messages[2].details_json,
        Some(json!([{"bucket_id": ACTIVE_LATEST_ID}]))
    );
    let recent_messages = store
        .list_chat_messages(2)
        .expect("bounded chat messages must be readable");
    assert_eq!(
        recent_messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        [
            "15151515-1515-1515-1515-151515151515",
            "16161616-1616-1616-1616-161616161616"
        ]
    );

    assert_eq!(
        store
            .get_todo("missing")
            .expect("missing todo lookup must work"),
        None
    );
    assert_eq!(
        store
            .get_chat_message("missing")
            .expect("missing chat lookup must work"),
        None
    );
    assert!(matches!(
        store.list_active_buckets(0),
        Err(StoreError::InvalidLimit(0))
    ));
    assert!(matches!(
        store.list_chat_messages(0),
        Err(StoreError::InvalidLimit(0))
    ));
}

fn create_python_fixture(repository_root: &Path, database_path: &Path) {
    let virtualenv_python = repository_root.join(".venv/bin/python");
    let python = if virtualenv_python.is_file() {
        virtualenv_python
    } else {
        PathBuf::from("python3")
    };
    let fixture_script = repository_root.join("tests/fixtures/create_sqlite_compat_fixture.py");
    let output = Command::new(python)
        .arg(fixture_script)
        .arg(database_path)
        .env("PYTHONPATH", repository_root)
        .current_dir(repository_root)
        .output()
        .expect("Python fixture generator must start");

    assert!(
        output.status.success(),
        "Python fixture generator failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
