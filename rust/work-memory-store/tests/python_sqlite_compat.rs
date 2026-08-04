use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use work_memory_core::{BucketStatus, BucketType};
use work_memory_store::{SqliteStore, StoreError};

const ACTIVE_LATEST_ID: &str = "11111111-1111-1111-1111-111111111111";
const ACTIVE_TIE_NEWER_ID: &str = "22222222-2222-2222-2222-222222222222";
const ACTIVE_TIE_OLDER_ID: &str = "33333333-3333-3333-3333-333333333333";
const PAUSED_ID: &str = "44444444-4444-4444-4444-444444444444";
static NEXT_DATABASE_ID: AtomicU64 = AtomicU64::new(0);

struct TemporaryDatabase {
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after the Unix epoch")
            .as_nanos();
        let sequence = NEXT_DATABASE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "work-memory-python-compat-{}-{timestamp}-{sequence}.db",
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
        for suffix in ["", "-shm", "-wal"] {
            let candidate = PathBuf::from(format!("{}{suffix}", self.path.display()));
            let _ = fs::remove_file(candidate);
        }
    }
}

#[test]
fn reads_python_created_bucket_and_entry_rows_without_write_access() {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("store crate must live under rust/");
    let database = TemporaryDatabase::new();
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

    assert!(matches!(
        store.list_active_buckets(0),
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
