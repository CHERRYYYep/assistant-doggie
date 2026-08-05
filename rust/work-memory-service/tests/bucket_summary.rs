use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use work_memory_service::{BucketSummaryService, ServiceError};
use work_memory_store::{SqliteStore, StoreError};

const BUCKET_ID: &str = "11111111-1111-1111-1111-111111111111";
const INITIAL_SUMMARY: &str = "Investigating callback failures.";
const UPDATE_FRAGMENT: &str = "Standalone service summary update with enough detail to exercise the bounded rolling summary behavior safely.";
const UPDATE_MAX_CHARS: usize = 100;
const REBUILD_MAX_ENTRIES: i64 = 4;
const REBUILD_MAX_CHARS: i64 = 1_200;
const REBUILT_SUMMARY: &str = "Duplicate fact\nNewest fact";
const DEFAULT_REBUILT_SUMMARY: &str = "Callback returned 502.\nDuplicate fact\nNewest fact";
const UPDATE: &str = "update";
const REBUILD: &str = "rebuild";

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
            "work-memory-bucket-summary-service-{label}-{}-{timestamp}-{sequence}.db",
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

#[test]
fn update_bucket_summary_matches_python_result_and_database_semantics() {
    let python_database = create_python_fixture("update-python");
    let rust_database = create_python_fixture("update-rust");
    let before = load_bucket(rust_database.path());
    let python_result = run_python_json(
        "tests/fixtures/apply_bucket_summary_service_fixture.py",
        python_database.path(),
        &[UPDATE],
    );

    let mut service = BucketSummaryService::open_existing(rust_database.path()).unwrap();
    let summary = service
        .update_bucket_summary_with_max_chars(
            BUCKET_ID,
            format!("  {UPDATE_FRAGMENT}  "),
            UPDATE_MAX_CHARS,
        )
        .unwrap();
    assert_eq!(json!({ "summary": summary }), python_result);
    assert_eq!(summary.chars().count(), UPDATE_MAX_CHARS);
    assert!(summary.starts_with(&format!("{INITIAL_SUMMARY}\n")));
    assert!(summary.ends_with('…'));
    drop(service);

    let after = load_bucket(rust_database.path());
    assert_eq!(after.summary, summary);
    assert_eq!(after.last_active_at, before.last_active_at);
    assert_ne!(after.updated_at, before.updated_at);
    assert_database_parity(&rust_database, &python_database, UPDATE);
}

#[test]
fn default_update_deduplicates_a_normalized_fragment() {
    let database = create_python_fixture("update-default");
    let mut service = BucketSummaryService::open_existing(database.path()).unwrap();

    let expected = format!("{INITIAL_SUMMARY}\nNewest standalone summary fragment.");
    assert_eq!(
        service
            .update_bucket_summary(BUCKET_ID, "  Newest standalone summary fragment.  ")
            .unwrap(),
        expected
    );
    assert_eq!(
        service
            .update_bucket_summary(BUCKET_ID, " newest   STANDALONE summary fragment. ",)
            .unwrap(),
        expected
    );
}

#[test]
fn rebuild_bucket_summary_matches_python_result_and_database_semantics() {
    let python_database = create_python_fixture("rebuild-python");
    let rust_database = create_python_fixture("rebuild-rust");
    let before = load_bucket(rust_database.path());
    let python_result = run_python_json(
        "tests/fixtures/apply_bucket_summary_service_fixture.py",
        python_database.path(),
        &[REBUILD],
    );
    run_python_json(
        "tests/fixtures/apply_bucket_summary_service_fixture.py",
        rust_database.path(),
        &[REBUILD, "--prepare-only"],
    );

    let mut service = BucketSummaryService::open_existing(rust_database.path()).unwrap();
    let summary = service
        .rebuild_bucket_summary_with_limits(BUCKET_ID, REBUILD_MAX_ENTRIES, REBUILD_MAX_CHARS)
        .unwrap();
    assert_eq!(summary, REBUILT_SUMMARY);
    assert_eq!(json!({ "summary": summary }), python_result);
    drop(service);

    let after = load_bucket(rust_database.path());
    assert_eq!(after.summary, REBUILT_SUMMARY);
    assert_eq!(after.last_active_at, before.last_active_at);
    assert_ne!(after.updated_at, before.updated_at);
    assert_database_parity(&rust_database, &python_database, REBUILD);
}

#[test]
fn default_rebuild_uses_the_python_entry_and_character_limits() {
    let database = create_python_fixture("rebuild-default");
    run_python_json(
        "tests/fixtures/apply_bucket_summary_service_fixture.py",
        database.path(),
        &[REBUILD, "--prepare-only"],
    );
    let mut service = BucketSummaryService::open_existing(database.path()).unwrap();

    assert_eq!(
        service.rebuild_bucket_summary(BUCKET_ID).unwrap(),
        DEFAULT_REBUILT_SUMMARY
    );
}

#[test]
fn invalid_and_missing_summary_operations_leave_the_database_unchanged() {
    let database = create_python_fixture("invalid");
    let before = export_database(database.path(), UPDATE);
    let bucket_before = load_bucket(database.path());
    let mut service = BucketSummaryService::open_existing(database.path()).unwrap();

    assert!(matches!(
        service.update_bucket_summary_with_max_chars(BUCKET_ID, " \n\t ", 99),
        Err(ServiceError::Store(StoreError::InvalidWriteField {
            field: "entry_summary",
            reason: "must not be empty",
        }))
    ));
    assert!(matches!(
        service.update_bucket_summary_with_max_chars(BUCKET_ID, "Valid fragment", 99),
        Err(ServiceError::Store(StoreError::InvalidWriteField {
            field: "max_chars",
            reason: "must be at least 100",
        }))
    ));
    assert!(matches!(
        service.rebuild_bucket_summary_with_limits(BUCKET_ID, 0, REBUILD_MAX_CHARS),
        Err(ServiceError::Store(StoreError::InvalidWriteField {
            field: "max_entries",
            reason: "must be at least 1",
        }))
    ));
    assert!(matches!(
        service.update_bucket_summary("missing-bucket", "Valid fragment"),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "buckets",
            ..
        }))
    ));
    assert!(matches!(
        service.rebuild_bucket_summary("missing-bucket"),
        Err(ServiceError::Store(StoreError::MissingRecord {
            table: "buckets",
            ..
        }))
    ));
    drop(service);

    assert_eq!(load_bucket(database.path()), bucket_before);
    assert_eq!(export_database(database.path(), UPDATE), before);
}

fn load_bucket(path: &Path) -> work_memory_store::StoredBucket {
    SqliteStore::open_read_only(path)
        .unwrap()
        .get_bucket(BUCKET_ID)
        .unwrap()
        .unwrap()
}

fn assert_database_parity(
    rust_database: &TemporaryDatabase,
    python_database: &TemporaryDatabase,
    scenario: &str,
) {
    assert_eq!(
        export_database(rust_database.path(), scenario),
        export_database(python_database.path(), scenario)
    );
}

fn export_database(database_path: &Path, scenario: &str) -> Value {
    run_python_json(
        "tests/fixtures/export_bucket_summary_service_fixture.py",
        database_path,
        &[scenario],
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
