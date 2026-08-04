use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Value;
use rusqlite::{Connection, params};
use work_memory_store::{
    LATEST_SCHEMA_VERSION, MigrationOutcome, SchemaState, StoreError, inspect_database,
    migrate_database, restore_database,
};

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
static NEXT_PATH_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, PartialEq)]
struct BusinessSnapshot {
    schema: Vec<(String, String, String, Option<String>)>,
    rows: BTreeMap<String, Vec<Vec<Value>>>,
}

struct TemporaryPath {
    path: PathBuf,
}

impl TemporaryPath {
    fn new(label: &str) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after the Unix epoch")
            .as_nanos();
        let sequence = NEXT_PATH_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "work-memory-{label}-{}-{timestamp}-{sequence}.db",
            std::process::id()
        ));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal", "-journal"] {
            let candidate = PathBuf::from(format!("{}{suffix}", self.path.display()));
            let _ = fs::remove_file(candidate);
        }
    }
}

#[test]
fn migrates_and_restores_the_complete_python_database_without_business_changes() {
    let database = TemporaryPath::new("migration-source");
    let legacy_backup = TemporaryPath::new("migration-legacy-backup");
    let unused_repeat_backup = TemporaryPath::new("migration-repeat-backup");
    let versioned_safety_backup = TemporaryPath::new("migration-versioned-safety");
    let legacy_safety_backup = TemporaryPath::new("migration-legacy-safety");
    create_python_fixture(database.path());
    let wal_connection = Connection::open(database.path()).unwrap();
    let journal_mode: String = wal_connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal_mode, "wal");
    wal_connection
        .execute_batch("PRAGMA wal_autocheckpoint = 0;")
        .unwrap();
    wal_connection
        .execute(
            "INSERT INTO chat_messages (
                id, role, content, tool_name, tool_call_id, details_json, created_at
             ) VALUES (?1, 'user', 'Committed in WAL', NULL, NULL, NULL, ?2)",
            params![
                "17171717-1717-1717-1717-171717171717",
                "2026-08-04 10:04:00.000000"
            ],
        )
        .unwrap();

    let before = business_snapshot(database.path());
    let legacy = inspect_database(database.path()).expect("Python schema must be recognized");
    assert_eq!(legacy.state, SchemaState::LegacyPython);
    assert!(legacy.migrations.is_empty());

    let outcome = migrate_database(database.path(), legacy_backup.path())
        .expect("legacy database must migrate");
    assert!(matches!(
        outcome,
        MigrationOutcome::Migrated {
            from: SchemaState::LegacyPython,
            to: SchemaState::Versioned(LATEST_SCHEMA_VERSION),
            backup_path,
        } if backup_path == legacy_backup.path()
    ));

    let migrated = inspect_database(database.path()).expect("migrated schema must validate");
    assert_eq!(
        migrated.state,
        SchemaState::Versioned(LATEST_SCHEMA_VERSION)
    );
    assert_eq!(migrated.migrations.len(), 1);
    assert_eq!(migrated.migrations[0].version, LATEST_SCHEMA_VERSION);
    assert_eq!(migrated.migrations[0].name, "adopt_python_schema_v1");
    assert!(!migrated.migrations[0].applied_at.raw().is_empty());
    assert_eq!(business_snapshot(database.path()), before);

    let backup_info = inspect_database(legacy_backup.path()).expect("backup must validate");
    assert_eq!(backup_info.state, SchemaState::LegacyPython);
    assert_eq!(business_snapshot(legacy_backup.path()), before);
    drop(wal_connection);

    let repeat = migrate_database(database.path(), unused_repeat_backup.path())
        .expect("repeated migration must be idempotent");
    assert_eq!(
        repeat,
        MigrationOutcome::AlreadyCurrent {
            version: LATEST_SCHEMA_VERSION
        }
    );
    assert!(!unused_repeat_backup.path().exists());

    let restored = restore_database(
        database.path(),
        legacy_backup.path(),
        versioned_safety_backup.path(),
    )
    .expect("legacy backup must restore");
    assert_eq!(
        restored.previous_state,
        SchemaState::Versioned(LATEST_SCHEMA_VERSION)
    );
    assert_eq!(restored.restored_state, SchemaState::LegacyPython);
    assert_eq!(
        inspect_database(database.path()).unwrap().state,
        SchemaState::LegacyPython
    );
    assert_eq!(business_snapshot(database.path()), before);
    assert_eq!(
        inspect_database(versioned_safety_backup.path())
            .unwrap()
            .state,
        SchemaState::Versioned(LATEST_SCHEMA_VERSION)
    );
    assert_eq!(business_snapshot(versioned_safety_backup.path()), before);

    let restored_again = restore_database(
        database.path(),
        versioned_safety_backup.path(),
        legacy_safety_backup.path(),
    )
    .expect("versioned safety backup must restore");
    assert_eq!(restored_again.previous_state, SchemaState::LegacyPython);
    assert_eq!(
        restored_again.restored_state,
        SchemaState::Versioned(LATEST_SCHEMA_VERSION)
    );
    assert_eq!(
        inspect_database(database.path()).unwrap().state,
        SchemaState::Versioned(LATEST_SCHEMA_VERSION)
    );
    assert_eq!(business_snapshot(database.path()), before);
    assert_eq!(
        inspect_database(legacy_safety_backup.path()).unwrap().state,
        SchemaState::LegacyPython
    );
}

#[test]
fn rejects_a_missing_index_before_creating_a_backup() {
    let database = TemporaryPath::new("missing-index-source");
    let backup = TemporaryPath::new("missing-index-backup");
    create_python_fixture(database.path());
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch("DROP INDEX ix_entries_bucket_created_at;")
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());

    assert!(matches!(
        migrate_database(database.path(), backup.path()),
        Err(StoreError::MissingIndex {
            table: "entries",
            index: "ix_entries_bucket_created_at"
        })
    ));
    assert!(!backup.path().exists());
    assert!(!table_exists(database.path(), "schema_migrations"));
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rejects_foreign_key_corruption_before_creating_a_backup() {
    let database = TemporaryPath::new("foreign-key-source");
    let backup = TemporaryPath::new("foreign-key-backup");
    create_python_fixture(database.path());
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .unwrap();
    connection
        .execute(
            "INSERT INTO todos (
                id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
             ) VALUES (?1, 'missing-bucket', NULL, 'broken', 'open', NULL, ?2, ?2)",
            params!["broken-foreign-key", "2026-08-04 12:00:00.000000"],
        )
        .unwrap();
    drop(connection);

    assert!(matches!(
        migrate_database(database.path(), backup.path()),
        Err(StoreError::ForeignKeyCheckFailed { table, .. }) if table == "todos"
    ));
    assert!(!backup.path().exists());
    assert!(!table_exists(database.path(), "schema_migrations"));
}

#[test]
fn rejects_unknown_future_migration_history_without_modifying_it() {
    let database = TemporaryPath::new("future-version-source");
    let backup = TemporaryPath::new("future-version-backup");
    create_python_fixture(database.path());
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL
             );
             INSERT INTO schema_migrations (version, name, applied_at)
             VALUES (2, 'future_migration', '2026-08-04T12:00:00Z');",
        )
        .unwrap();
    drop(connection);

    assert!(matches!(
        inspect_database(database.path()),
        Err(StoreError::UnsupportedSchemaVersion {
            found: 2,
            supported: LATEST_SCHEMA_VERSION
        })
    ));
    assert!(matches!(
        migrate_database(database.path(), backup.path()),
        Err(StoreError::UnsupportedSchemaVersion {
            found: 2,
            supported: LATEST_SCHEMA_VERSION
        })
    ));
    assert!(!backup.path().exists());
    let connection = Connection::open(database.path()).unwrap();
    let record: (i64, String) = connection
        .query_row("SELECT version, name FROM schema_migrations", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(record, (2, "future_migration".to_owned()));
}

#[test]
fn rejects_a_migration_table_without_the_version_primary_key() {
    let database = TemporaryPath::new("invalid-migration-table-source");
    create_python_fixture(database.path());
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE schema_migrations (
                version INTEGER NOT NULL,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL
             );
             INSERT INTO schema_migrations (version, name, applied_at)
             VALUES (1, 'adopt_python_schema_v1', '2026-08-04T12:00:00Z');",
        )
        .unwrap();
    drop(connection);

    assert!(matches!(
        inspect_database(database.path()),
        Err(StoreError::InvalidPrimaryKey {
            table: "schema_migrations",
            expected,
            found,
        }) if expected == ["version"] && found.is_empty()
    ));
}

#[test]
fn rejects_existing_or_reused_backup_paths_without_migrating() {
    let database = TemporaryPath::new("existing-backup-source");
    let backup = TemporaryPath::new("existing-backup");
    create_python_fixture(database.path());
    fs::write(backup.path(), b"do not overwrite").unwrap();

    assert!(matches!(
        migrate_database(database.path(), backup.path()),
        Err(StoreError::BackupAlreadyExists(path)) if path == backup.path()
    ));
    assert_eq!(fs::read(backup.path()).unwrap(), b"do not overwrite");
    assert!(!table_exists(database.path(), "schema_migrations"));

    assert!(matches!(
        migrate_database(database.path(), database.path()),
        Err(StoreError::SameDatabasePath {
            left_label: "database",
            right_label: "backup",
            ..
        })
    ));
    assert!(!table_exists(database.path(), "schema_migrations"));
}

#[test]
fn validates_restore_source_before_displacing_the_database() {
    let database = TemporaryPath::new("restore-target");
    let invalid_backup = TemporaryPath::new("restore-invalid-backup");
    let safety_backup = TemporaryPath::new("restore-unused-safety");
    create_python_fixture(database.path());
    create_python_fixture(invalid_backup.path());
    let before = business_snapshot(database.path());
    let connection = Connection::open(invalid_backup.path()).unwrap();
    connection
        .execute_batch("DROP INDEX ix_todos_bucket_id;")
        .unwrap();
    drop(connection);

    assert!(matches!(
        restore_database(database.path(), invalid_backup.path(), safety_backup.path()),
        Err(StoreError::MissingIndex {
            table: "todos",
            index: "ix_todos_bucket_id"
        })
    ));
    assert!(!safety_backup.path().exists());
    assert_eq!(business_snapshot(database.path()), before);
    assert_eq!(
        inspect_database(database.path()).unwrap().state,
        SchemaState::LegacyPython
    );
}

fn create_python_fixture(database_path: &Path) {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("store crate must live under rust/");
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

fn business_snapshot(path: &Path) -> BusinessSnapshot {
    let connection = Connection::open(path).expect("snapshot database must open");
    let schema = connection
        .prepare(
            "SELECT type, name, tbl_name, sql
             FROM sqlite_schema
             WHERE name != 'schema_migrations'
               AND name NOT LIKE 'sqlite_autoindex_%'
             ORDER BY type, name",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    let mut rows = BTreeMap::new();
    for table in BUSINESS_TABLES {
        let sql = format!("SELECT * FROM {table} ORDER BY id");
        let mut statement = connection.prepare(&sql).unwrap();
        let column_count = statement.column_count();
        let values = statement
            .query_map([], |row| {
                (0..column_count)
                    .map(|index| row.get::<_, Value>(index))
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows.insert((*table).to_owned(), values);
    }

    BusinessSnapshot { schema, rows }
}

fn table_exists(path: &Path, table: &str) -> bool {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1
             )",
            [table],
            |row| row.get(0),
        )
        .unwrap()
}
