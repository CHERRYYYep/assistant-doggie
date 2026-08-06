mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{Connection, params};
use serde_json::json;
use support::TemporaryPath;
use work_memory_core::{BucketType, ClassificationResult, ExtractionResult};
use work_memory_store::{MemoryKind, RustStore, StoreError};

const ACTIVE_BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const FIRST_ENTRY_ID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ASK_USER_ID: &str = "13232323-2323-2323-2323-232323232323";
const MOVE_CORRECTION_ID: &str = "14141414-1414-1414-1414-141414141414";

#[test]
fn rejects_a_malformed_legacy_index_before_creating_the_target() {
    let source = TemporaryPath::new("legacy-import-missing-index-source");
    let target = TemporaryPath::new("legacy-import-missing-index-target");
    create_python_fixture(source.path());

    let connection = Connection::open(source.path()).expect("source must open");
    connection
        .execute("DROP INDEX ix_entries_created_at", [])
        .expect("legacy index must be removable for the regression test");
    drop(connection);

    assert!(matches!(
        RustStore::import_legacy_database(source.path(), target.path()),
        Err(StoreError::MissingIndex {
            table: "entries",
            index: "ix_entries_created_at"
        })
    ));
    assert!(
        !target.path().exists(),
        "source schema validation must run before target creation"
    );
}

#[test]
fn imports_the_python_fixture_into_the_canonical_schema() {
    let source = TemporaryPath::new("legacy-import-source");
    let target = TemporaryPath::new("legacy-import-target");
    create_python_fixture(source.path());

    let report = RustStore::import_legacy_database(source.path(), target.path())
        .expect("legacy fixture must import");
    assert_eq!(report.buckets, 4);
    assert_eq!(report.entries, 3);
    assert_eq!(report.memory_items, 8);
    assert_eq!(report.archive_attempts, 2);
    assert_eq!(report.corrections, 2);
    assert_eq!(report.chat_messages, 3);

    let store = RustStore::open_existing(target.path()).expect("canonical target must open");
    assert_eq!(store.counts().expect("counts").buckets, 4);
    let bucket = store
        .get_bucket(ACTIVE_BUCKET_ID)
        .expect("bucket query")
        .expect("fixture bucket");
    assert_eq!(bucket.title, "Payment callback incident");
    assert_eq!(bucket.tags, ["payments", "callback", "支付"]);

    let detail = store
        .bucket_detail(ACTIVE_BUCKET_ID)
        .expect("detail query")
        .expect("detail");
    let entry = detail
        .entries
        .iter()
        .find(|entry| entry.id == FIRST_ENTRY_ID)
        .expect("fixture entry");
    assert_eq!(entry.raw_text, "Payment callback returned 502.");
    assert_eq!(entry.content_type, "incident_update");
    assert_eq!(detail.memories.len(), 8);
    assert!(detail.memories.iter().any(|item| {
        item.id == "ffffffff-ffff-ffff-ffff-ffffffffffff"
            && item.kind == MemoryKind::Timeline
            && item.occurred_at.as_deref() == Some("2026-08-04T10:00:00Z")
    }));
    assert!(
        detail
            .memories
            .iter()
            .any(|item| item.kind == MemoryKind::Todo && item.status.as_deref() == Some("open"))
    );
    assert!(
        detail
            .memories
            .iter()
            .any(|item| item.kind == MemoryKind::Evidence)
    );
    assert!(
        detail
            .memories
            .iter()
            .any(|item| item.kind == MemoryKind::Decision)
    );

    let attempts = store.list_archive_attempts(10).expect("archive attempts");
    let ask_user = attempts
        .iter()
        .find(|attempt| attempt.id == ASK_USER_ID)
        .expect("ask-user audit");
    assert_eq!(ask_user.archive_state, "needs_confirmation");
    assert!(ask_user.entry_id.is_none());
    let correction = store
        .list_corrections(
            Some("entry"),
            Some("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
            10,
        )
        .expect("correction query")
        .into_iter()
        .find(|item| item.id == MOVE_CORRECTION_ID)
        .expect("move correction");
    assert_eq!(
        correction.before,
        Some(json!({"bucket_id": "44444444-4444-4444-4444-444444444444"}))
    );
    assert_eq!(
        correction.after,
        Some(json!({"bucket_id": ACTIVE_BUCKET_ID, "reason": "用户纠正"}))
    );

    let messages = store.list_chat_messages(10).expect("chat messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0].sequence, 1);
    assert_eq!(messages[0].content, "Archive the callback recovery note.");
    assert_eq!(messages[1].sequence, 2);
    assert_eq!(messages[2].sequence, 3);
    assert_eq!(
        messages[1].details,
        Some(json!({"bucket_id": ACTIVE_BUCKET_ID, "ok": true}))
    );
    assert_eq!(
        messages[2].details,
        Some(json!([{"bucket_id": ACTIVE_BUCKET_ID}]))
    );
}

#[test]
fn reuses_an_empty_canonical_target_after_initialization() {
    let source = TemporaryPath::new("legacy-import-non-empty-source");
    let target = TemporaryPath::new("legacy-import-non-empty-target");
    create_python_fixture(source.path());
    let store = RustStore::initialize(target.path()).expect("canonical target");
    drop(store);

    let report = RustStore::import_legacy_database(source.path(), target.path())
        .expect("empty canonical target must be retryable");
    assert_eq!(report.buckets, 4);
    let store = RustStore::open_existing(target.path()).expect("target remains canonical");
    assert_eq!(store.counts().expect("counts").buckets, 4);
}

#[test]
fn refuses_a_target_with_business_rows_without_modifying_it() {
    let source = TemporaryPath::new("legacy-import-non-empty-source");
    let target = TemporaryPath::new("legacy-import-non-empty-target");
    create_python_fixture(source.path());
    let mut store = RustStore::initialize(target.path()).expect("canonical target");
    store
        .archive(
            "Existing target row",
            ClassificationResult::create_new(
                BucketType::Task,
                "Existing target bucket",
                0.9,
                "fixture",
                vec![],
            )
            .expect("classification"),
            Some(ExtractionResult::minimal("Existing target summary").expect("extraction")),
            work_memory_store::RustArchiveAudit::new(vec![], None, "test", "test").expect("audit"),
        )
        .expect("target row");
    drop(store);

    assert!(matches!(
        RustStore::import_legacy_database(source.path(), target.path()),
        Err(StoreError::ImportTargetNotEmpty(_))
    ));
    let store = RustStore::open_existing(target.path()).expect("target remains canonical");
    assert_eq!(store.counts().expect("counts").buckets, 1);
}

#[test]
fn rolls_back_target_rows_when_source_semantics_are_invalid() {
    let source = TemporaryPath::new("legacy-import-invalid-source");
    let target = TemporaryPath::new("legacy-import-invalid-target");
    create_python_fixture(source.path());
    let connection = Connection::open(source.path()).expect("source must open");
    connection
        .execute(
            "UPDATE classification_records SET action = 'unsupported' WHERE id = ?1",
            params![ASK_USER_ID],
        )
        .expect("invalid source row must be written");
    drop(connection);

    assert!(matches!(
        RustStore::import_legacy_database(source.path(), target.path()),
        Err(StoreError::InvalidClassificationAction {
            classification_record_id,
            value
        }) if classification_record_id == ASK_USER_ID && value == "unsupported"
    ));
    let store = RustStore::open_existing(target.path()).expect("canonical target remains usable");
    assert_eq!(store.counts().expect("rolled-back counts").buckets, 0);
    assert_eq!(store.counts().expect("rolled-back counts").entries, 0);

    let connection = Connection::open(source.path()).expect("source must reopen");
    connection
        .execute(
            "UPDATE classification_records SET action = 'ask_user' WHERE id = ?1",
            params![ASK_USER_ID],
        )
        .expect("source row must be repaired");
    drop(connection);
    let report = RustStore::import_legacy_database(source.path(), target.path())
        .expect("failed import must be retryable after source repair");
    assert_eq!(report.buckets, 4);
    assert_eq!(
        RustStore::open_existing(target.path())
            .expect("retried target")
            .counts()
            .expect("retried counts")
            .entries,
        3
    );
}

#[test]
fn rejects_colliding_ids_across_legacy_memory_tables_before_creating_target() {
    let source = TemporaryPath::new("legacy-import-memory-id-collision-source");
    let target = TemporaryPath::new("legacy-import-memory-id-collision-target");
    create_python_fixture(source.path());
    let connection = Connection::open(source.path()).expect("source must open");
    let todo_id: String = connection
        .query_row("SELECT id FROM todos ORDER BY id LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("fixture todo");
    let evidence_id: String = connection
        .query_row("SELECT id FROM evidences ORDER BY id LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("fixture evidence");
    connection
        .execute(
            "UPDATE evidences SET id = ?1 WHERE id = ?2",
            params![todo_id, evidence_id],
        )
        .expect("cross-table collision must be representable in legacy schema");
    drop(connection);

    assert!(matches!(
        RustStore::import_legacy_database(source.path(), target.path()),
        Err(StoreError::LegacyMemoryIdCollision {
            id,
            first_table: "todos",
            second_table: "evidences",
        }) if id == todo_id
    ));
    assert!(!target.path().exists());
}

fn create_python_fixture(database_path: &Path) {
    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("store crate must live under rust/")
        .to_owned();
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
        .env("PYTHONPATH", &repository_root)
        .current_dir(&repository_root)
        .output()
        .expect("Python fixture generator must start");
    assert!(
        output.status.success(),
        "Python fixture generator failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
