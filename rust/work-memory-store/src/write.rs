use std::path::Path;

use rusqlite::{Connection, DatabaseName, OpenFlags, Transaction, TransactionBehavior};

use crate::{StoreError, migration, schema};

/// Writable SQLite repository foundation for the validated Python business schema.
///
/// This type deliberately has no public business mutation methods yet. Later
/// typed write APIs can share its transaction boundary without exposing a raw
/// writable `rusqlite::Connection` to application callers.
pub struct WritableSqliteStore {
    connection: Connection,
    #[allow(dead_code)]
    validated_schema_version: i64,
}

impl WritableSqliteStore {
    /// Open an existing database for isolated Rust writes.
    ///
    /// The database file must already exist, contain the complete supported
    /// Python schema, pass SQLite integrity checks, and have a supported
    /// migration history. Foreign-key enforcement is enabled before the store
    /// can be used.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;

        ensure_write_ready(&connection)?;
        migration::ensure_supported_history_if_present(&connection)?;
        schema::validate_full_python_schema(&connection)?;
        let validated_schema_version = schema_version(&connection)?;

        Ok(Self {
            connection,
            validated_schema_version,
        })
    }

    /// Report whether the connection remains writable with foreign keys on.
    pub fn is_write_ready(&self) -> Result<bool, StoreError> {
        connection_is_write_ready(&self.connection)
    }

    /// Run one immediate transaction and commit only after the operation succeeds.
    ///
    /// Keeping this crate-private prevents application code from bypassing the
    /// typed business write APIs that will be added in the next migration step.
    #[allow(dead_code)]
    pub(crate) fn run_transaction<T>(
        &mut self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        ensure_write_ready(&self.connection)?;
        migration::ensure_supported_history_if_present(&self.connection)?;

        let current_schema_version = schema_version(&self.connection)?;
        if current_schema_version != self.validated_schema_version {
            return Err(StoreError::SchemaChangedAfterValidation {
                expected: self.validated_schema_version,
                found: current_schema_version,
            });
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match operation(&transaction) {
            Ok(value) => {
                transaction.commit()?;
                Ok(value)
            }
            Err(operation_error) => {
                transaction.rollback()?;
                Err(operation_error)
            }
        }
    }
}

fn ensure_write_ready(connection: &Connection) -> Result<(), StoreError> {
    let opened_read_only = connection.is_readonly(DatabaseName::Main)?;
    let query_only = pragma_enabled(connection, "query_only")?;
    let foreign_keys = pragma_enabled(connection, "foreign_keys")?;
    if opened_read_only || query_only || !foreign_keys {
        return Err(StoreError::WriteConnectionNotReady {
            opened_read_only,
            query_only,
            foreign_keys,
        });
    }
    Ok(())
}

fn connection_is_write_ready(connection: &Connection) -> Result<bool, StoreError> {
    let opened_read_only = connection.is_readonly(DatabaseName::Main)?;
    let query_only = pragma_enabled(connection, "query_only")?;
    let foreign_keys = pragma_enabled(connection, "foreign_keys")?;
    Ok(!opened_read_only && !query_only && foreign_keys)
}

fn pragma_enabled(connection: &Connection, pragma: &str) -> Result<bool, StoreError> {
    let sql = format!("PRAGMA {pragma}");
    Ok(connection.query_row(&sql, [], |row| row.get::<_, i64>(0))? == 1)
}

fn schema_version(connection: &Connection) -> Result<i64, StoreError> {
    Ok(connection.query_row("PRAGMA schema_version", [], |row| row.get(0))?)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::{Connection, ErrorCode, params};

    use super::WritableSqliteStore;
    use crate::StoreError;

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
                "work-memory-writable-{label}-{}-{timestamp}-{sequence}.db",
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
    fn commits_a_successful_transaction() {
        let database = create_python_fixture("commit");
        let mut store = WritableSqliteStore::open_existing(database.path())
            .expect("validated fixture must open for writes");

        assert!(store.is_write_ready().expect("PRAGMAs must be readable"));
        store
            .run_transaction(|transaction| {
                transaction.execute(
                    "INSERT INTO buckets (
                        id, title, type, status, summary, tags,
                        created_at, updated_at, last_active_at
                     ) VALUES (?1, ?2, 'task', 'active', '', '[]', ?3, ?3, ?3)",
                    params![
                        "rust-committed-bucket",
                        "Rust committed bucket",
                        valid_time()
                    ],
                )?;
                Ok(())
            })
            .expect("successful transaction must commit");
        drop(store);

        let connection = Connection::open(database.path()).expect("fixture must reopen");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM buckets WHERE id = 'rust-committed-bucket'",
                [],
                |row| row.get(0),
            )
            .expect("committed row must be queryable");
        assert_eq!(count, 1);
    }

    #[test]
    fn rolls_back_all_changes_when_a_foreign_key_write_fails() {
        let database = create_python_fixture("rollback");
        let mut store = WritableSqliteStore::open_existing(database.path())
            .expect("validated fixture must open for writes");

        let error = store
            .run_transaction(|transaction| {
                transaction.execute(
                    "INSERT INTO buckets (
                        id, title, type, status, summary, tags,
                        created_at, updated_at, last_active_at
                     ) VALUES (?1, ?2, 'task', 'active', '', '[]', ?3, ?3, ?3)",
                    params!["rust-rolled-back-bucket", "Must roll back", valid_time()],
                )?;
                transaction.execute(
                    "INSERT INTO entries (
                        id, bucket_id, raw_text, summary, content_type,
                        classification_confidence, classification_reason,
                        created_at, moved_from_bucket_id
                     ) VALUES (?1, ?2, ?3, NULL, 'note', NULL, NULL, ?4, NULL)",
                    params![
                        "rust-invalid-entry",
                        "missing-parent-bucket",
                        "Foreign key must fail.",
                        valid_time()
                    ],
                )?;
                Ok(())
            })
            .expect_err("foreign-key violation must abort the transaction");
        assert!(matches!(
            error,
            StoreError::Sqlite(rusqlite::Error::SqliteFailure(ref failure, _))
                if failure.code == ErrorCode::ConstraintViolation
        ));
        drop(store);

        let connection = Connection::open(database.path()).expect("fixture must reopen");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM buckets WHERE id = 'rust-rolled-back-bucket'",
                [],
                |row| row.get(0),
            )
            .expect("rolled-back row must be queryable");
        assert_eq!(count, 0);
    }

    #[test]
    fn does_not_create_a_missing_database() {
        let database = TemporaryDatabase::new("missing");

        assert!(WritableSqliteStore::open_existing(database.path()).is_err());
        assert!(!database.path().exists());
    }

    #[test]
    fn rejects_an_incomplete_schema_before_any_write() {
        let database = TemporaryDatabase::new("invalid-schema");
        let connection = Connection::open(database.path()).expect("test database must open");
        connection
            .execute_batch("CREATE TABLE buckets (id TEXT PRIMARY KEY);")
            .expect("partial schema must be created");
        drop(connection);

        assert!(matches!(
            WritableSqliteStore::open_existing(database.path()),
            Err(StoreError::MissingColumn {
                table: "buckets",
                column: "title"
            })
        ));
    }

    #[test]
    fn rejects_an_unsupported_migration_history_before_any_write() {
        let database = create_python_fixture("future-migration");
        let connection = Connection::open(database.path()).expect("fixture must reopen");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                 );
                 INSERT INTO schema_migrations (version, name, applied_at)
                 VALUES (2, 'future_migration', '2026-08-04 14:30:00.000000');",
            )
            .expect("future migration fixture must be created");
        drop(connection);

        assert!(matches!(
            WritableSqliteStore::open_existing(database.path()),
            Err(StoreError::UnsupportedSchemaVersion {
                found: 2,
                supported: 1
            })
        ));
    }

    #[test]
    fn rejects_transactions_after_the_validated_schema_changes() {
        let database = create_python_fixture("schema-change");
        let mut store = WritableSqliteStore::open_existing(database.path())
            .expect("validated fixture must open for writes");

        store
            .connection
            .execute_batch("CREATE TABLE unexpected_external_table (id INTEGER PRIMARY KEY);")
            .expect("test schema change must succeed");

        assert!(matches!(
            store.run_transaction(|_| Ok(())),
            Err(StoreError::SchemaChangedAfterValidation { expected, found })
                if found > expected
        ));
    }

    fn create_python_fixture(label: &str) -> TemporaryDatabase {
        let database = TemporaryDatabase::new(label);
        let repository_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let virtualenv_python = repository_root.join(".venv/bin/python");
        let python = if virtualenv_python.is_file() {
            virtualenv_python
        } else {
            PathBuf::from("python3")
        };
        let fixture_script = repository_root.join("tests/fixtures/create_sqlite_compat_fixture.py");
        let output = Command::new(python)
            .arg(fixture_script)
            .arg(database.path())
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
        database
    }

    fn valid_time() -> &'static str {
        "2026-08-04 14:30:00.000000"
    }
}
