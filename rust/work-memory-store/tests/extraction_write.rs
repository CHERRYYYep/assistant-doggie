use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use work_memory_core::{ExtractionResult, TimelineEventExtract};
use work_memory_store::{SaveExtractionRequest, StoreError, WritableSqliteStore};

const BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const ENTRY_ID: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_ENTRY_ID: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SUMMARY: &str = "The callback path remained stable during the recovery review.";
const EXPECTED_BUCKET_SUMMARY: &str = "Investigating callback failures.\nThe callback path remained stable during the recovery review.";
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
static NEXT_DATABASE_ID: AtomicU64 = AtomicU64::new(0);

struct TemporaryDatabase {
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new(label: &str) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after the Unix epoch")
            .as_nanos();
        let sequence = NEXT_DATABASE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "work-memory-save-extraction-{label}-{}-{timestamp}-{sequence}.db",
            std::process::id()
        ));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal", "-journal"] {
            let candidate = PathBuf::from(format!("{}{suffix}", self.path.display()));
            let _ = fs::remove_file(candidate);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ExtractionSemanticSnapshot {
    bucket_summary: String,
    bucket_tags: Vec<String>,
    bucket_last_active_at: String,
    entry_summary: Option<String>,
    todos: Vec<(String, String, Option<String>)>,
    evidences: Vec<(String, Option<String>)>,
    timeline_events: Vec<(Option<String>, String)>,
    decisions: Vec<(String, Option<String>)>,
    table_counts: BTreeMap<String, i64>,
}

#[test]
fn save_extraction_request_preserves_exact_ids_and_validated_extraction() {
    let extraction = extraction_fixture();
    let bucket_id = format!(" {BUCKET_ID} ");
    let entry_id = format!(" {ENTRY_ID} ");
    let request = SaveExtractionRequest::new(&bucket_id, &entry_id, extraction.clone());

    assert_eq!(request.bucket_id(), bucket_id);
    assert_eq!(request.entry_id(), entry_id);
    assert_eq!(request.extraction(), &extraction);
}

#[test]
fn save_extraction_persists_children_entry_summary_and_bucket_cache() {
    let database = create_python_fixture("complete");
    let before_counts = table_row_counts(database.path());
    let bucket_before = bucket_cache_snapshot(database.path());
    let entry_before = entry_snapshot(database.path(), ENTRY_ID);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = SaveExtractionRequest::new(BUCKET_ID, ENTRY_ID, extraction_fixture());

    let outcome = store.save_extraction(&request).unwrap();
    assert_eq!(outcome.bucket_id(), BUCKET_ID);
    assert_eq!(outcome.entry_id(), ENTRY_ID);
    assert_eq!(outcome.todo_ids().len(), 2);
    assert_eq!(outcome.evidence_ids().len(), 1);
    assert_eq!(outcome.timeline_event_ids().len(), 2);
    assert_eq!(outcome.decision_ids().len(), 1);
    for id in outcome
        .todo_ids()
        .iter()
        .chain(outcome.evidence_ids())
        .chain(outcome.timeline_event_ids())
        .chain(outcome.decision_ids())
    {
        assert_uuid_v4(id);
    }

    let duplicate = store.save_extraction(&request).unwrap();
    assert!(duplicate.todo_ids().is_empty());
    assert!(duplicate.evidence_ids().is_empty());
    assert!(duplicate.timeline_event_ids().is_empty());
    assert!(duplicate.decision_ids().is_empty());
    drop(store);

    let after_counts = table_row_counts(database.path());
    assert_eq!(after_counts["buckets"], before_counts["buckets"]);
    assert_eq!(after_counts["entries"], before_counts["entries"]);
    assert_eq!(after_counts["todos"], before_counts["todos"] + 2);
    assert_eq!(after_counts["evidences"], before_counts["evidences"] + 1);
    assert_eq!(
        after_counts["timeline_events"],
        before_counts["timeline_events"] + 2
    );
    assert_eq!(after_counts["decisions"], before_counts["decisions"] + 1);
    for table in ["classification_records", "corrections", "chat_messages"] {
        assert_eq!(after_counts[table], before_counts[table]);
    }

    let (summary, tags, updated_at, last_active_at) = bucket_cache_snapshot(database.path());
    assert_eq!(summary, EXPECTED_BUCKET_SUMMARY);
    assert_eq!(tags, ["payments", "callback", "支付", "recovery", "稳定"]);
    assert_ne!(updated_at, bucket_before.2);
    assert_eq!(last_active_at, bucket_before.3);

    let entry_after = entry_snapshot(database.path(), ENTRY_ID);
    assert_eq!(entry_after.0.as_deref(), Some(SUMMARY));
    assert_eq!(entry_after.1, entry_before.1);

    let snapshot = extraction_semantic_snapshot(database.path());
    assert_eq!(
        snapshot.todos,
        [
            (
                "Review callback dashboard.".to_owned(),
                "open".to_owned(),
                None,
            ),
            (
                "review   callback dashboard.".to_owned(),
                "open".to_owned(),
                None,
            ),
        ]
    );
    assert_eq!(
        snapshot.evidences,
        [(
            "The callback error rate stayed below 0.1%.".to_owned(),
            Some("llm-extracted".to_owned()),
        )]
    );
    assert_eq!(
        snapshot.timeline_events,
        [
            (
                Some("2026-08-04T10:00:00Z".to_owned()),
                "Proxy restarted and callback retries recovered.".to_owned(),
            ),
            (
                Some("during review".to_owned()),
                "The callback path stayed stable.".to_owned(),
            ),
            (
                Some("during review".to_owned()),
                "The callback path stayed stable.".to_owned(),
            ),
        ]
    );
    assert_eq!(
        snapshot.decisions,
        [
            (
                "Keep retry traffic on the recovered proxy pool.".to_owned(),
                Some("Error rate stayed below the rollback threshold.".to_owned()),
            ),
            (
                "Keep the recovery dashboard for one more day.".to_owned(),
                None,
            ),
        ]
    );
}

#[test]
fn save_extraction_checks_bucket_then_entry_relationship_without_changes() {
    let database = create_python_fixture("missing");
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let missing_bucket =
        SaveExtractionRequest::new("missing-bucket", "missing-entry", extraction_fixture());
    assert!(matches!(
        store.save_extraction(&missing_bucket),
        Err(StoreError::MissingRecord {
            table: "buckets",
            id,
        }) if id == "missing-bucket"
    ));

    let missing_entry =
        SaveExtractionRequest::new(BUCKET_ID, "missing-entry", extraction_fixture());
    assert!(matches!(
        store.save_extraction(&missing_entry),
        Err(StoreError::MissingRecord {
            table: "entries",
            id,
        }) if id == "missing-entry"
    ));

    let wrong_bucket = SaveExtractionRequest::new(BUCKET_ID, OTHER_ENTRY_ID, extraction_fixture());
    assert!(matches!(
        store.save_extraction(&wrong_bucket),
        Err(StoreError::MissingRecord {
            table: "entries",
            id,
        }) if id == OTHER_ENTRY_ID
    ));
    drop(store);

    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn save_extraction_preserves_exact_bucket_and_entry_ids() {
    let database = create_python_fixture("exact-id");
    let before = business_snapshot(database.path());
    let requested_bucket_id = format!(" {BUCKET_ID} ");
    let requested_entry_id = format!(" {ENTRY_ID} ");
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let bucket_request =
        SaveExtractionRequest::new(&requested_bucket_id, ENTRY_ID, extraction_fixture());
    assert!(matches!(
        store.save_extraction(&bucket_request),
        Err(StoreError::MissingRecord {
            table: "buckets",
            id,
        }) if id == requested_bucket_id
    ));

    let entry_request =
        SaveExtractionRequest::new(BUCKET_ID, &requested_entry_id, extraction_fixture());
    assert!(matches!(
        store.save_extraction(&entry_request),
        Err(StoreError::MissingRecord {
            table: "entries",
            id,
        }) if id == requested_entry_id
    ));
    drop(store);

    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn save_extraction_failure_rolls_back_children_entry_and_bucket_cache() {
    let database = create_python_fixture("rollback");
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(&format!(
            "CREATE TRIGGER fail_extraction_bucket_update
             BEFORE UPDATE OF summary ON buckets
             WHEN OLD.id = '{BUCKET_ID}'
             BEGIN
                 SELECT RAISE(ABORT, 'simulated extraction cache failure');
             END;"
        ))
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = SaveExtractionRequest::new(BUCKET_ID, ENTRY_ID, extraction_fixture());

    assert!(matches!(
        store.save_extraction(&request),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);

    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_save_extraction_matches_python_service_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    run_python_script(
        "tests/fixtures/apply_save_extraction_fixture.py",
        python_database.path(),
    );

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    store
        .save_extraction(&SaveExtractionRequest::new(
            BUCKET_ID,
            ENTRY_ID,
            extraction_fixture(),
        ))
        .unwrap();
    drop(store);

    assert_eq!(
        extraction_semantic_snapshot(rust_database.path()),
        extraction_semantic_snapshot(python_database.path())
    );
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

fn bucket_cache_snapshot(path: &Path) -> (String, Vec<String>, String, String) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT summary, tags, updated_at, last_active_at FROM buckets WHERE id = ?1",
            [BUCKET_ID],
            |row| {
                let tags_json: String = row.get(1)?;
                Ok((
                    row.get(0)?,
                    serde_json::from_str(&tags_json).unwrap(),
                    row.get(2)?,
                    row.get(3)?,
                ))
            },
        )
        .unwrap()
}

fn entry_snapshot(path: &Path, entry_id: &str) -> (Option<String>, Vec<SqlValue>) {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT summary, bucket_id, raw_text, content_type,
                    classification_confidence, classification_reason,
                    created_at, moved_from_bucket_id
             FROM entries WHERE id = ?1",
            [entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    (1..8)
                        .map(|index| row.get::<_, SqlValue>(index))
                        .collect::<Result<Vec<_>, _>>()?,
                ))
            },
        )
        .unwrap()
}

fn extraction_semantic_snapshot(path: &Path) -> ExtractionSemanticSnapshot {
    let connection = Connection::open(path).unwrap();
    let (bucket_summary, bucket_tags, _, bucket_last_active_at) = bucket_cache_snapshot(path);
    let entry_summary = connection
        .query_row(
            "SELECT summary FROM entries WHERE id = ?1",
            [ENTRY_ID],
            |row| row.get(0),
        )
        .unwrap();

    let mut todos = query_child_rows(
        &connection,
        "SELECT text, status, due_date FROM todos WHERE entry_id = ?1",
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    );
    todos.sort();
    let mut evidences = query_child_rows(
        &connection,
        "SELECT text, source FROM evidences WHERE entry_id = ?1",
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    evidences.sort();
    let mut timeline_events = query_child_rows(
        &connection,
        "SELECT event_time, text FROM timeline_events WHERE entry_id = ?1",
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    timeline_events.sort();
    let mut decisions = query_child_rows(
        &connection,
        "SELECT text, reason FROM decisions WHERE entry_id = ?1",
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    decisions.sort();

    ExtractionSemanticSnapshot {
        bucket_summary,
        bucket_tags,
        bucket_last_active_at,
        entry_summary,
        todos,
        evidences,
        timeline_events,
        decisions,
        table_counts: table_row_counts(path),
    }
}

fn query_child_rows<T>(
    connection: &Connection,
    sql: &str,
    decode: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Vec<T> {
    let mut statement = connection.prepare(sql).unwrap();
    statement
        .query_map([ENTRY_ID], decode)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
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

fn business_snapshot(path: &Path) -> BTreeMap<String, Vec<Vec<SqlValue>>> {
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
                        .map(|index| row.get::<_, SqlValue>(index))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            ((*table).to_owned(), rows)
        })
        .collect()
}
