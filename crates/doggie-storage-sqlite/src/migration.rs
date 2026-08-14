use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};

use crate::schema::{self, validate_full_legacy_schema, validate_integrity};
use crate::{StoreError, StoredTimestamp};

pub const LATEST_SCHEMA_VERSION: u32 = 1;
const MIGRATION_TABLE: &str = "schema_migrations";
const MIGRATION_COLUMNS: &[&str] = &["version", "name", "applied_at"];
const BASELINE_MIGRATION_NAME: &str = "adopt_python_schema_v1"; // Historical migration identifier retained for legacy database compatibility.

/// The recognized persistence state of a database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaState {
    /// The nine-table legacy SQLAlchemy schema without migration history.
    Legacy,
    /// A Doggie-versioned schema at the recorded migration version.
    Versioned(u32),
}

/// One applied migration record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationRecord {
    pub version: u32,
    pub name: String,
    pub applied_at: StoredTimestamp,
}

/// Validated migration and schema information for one database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaInfo {
    pub state: SchemaState,
    pub migrations: Vec<MigrationRecord>,
}

/// Result of applying all currently known migrations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    Migrated {
        from: SchemaState,
        to: SchemaState,
        backup_path: PathBuf,
    },
    AlreadyCurrent {
        version: u32,
    },
}

/// Result of restoring a database while retaining its displaced state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreOutcome {
    pub previous_state: SchemaState,
    pub restored_state: SchemaState,
    pub safety_backup_path: PathBuf,
}

/// Inspect the full legacy-compatible schema and any Doggie migration history.
pub fn inspect_database(path: impl AsRef<Path>) -> Result<SchemaInfo, StoreError> {
    let connection = open_read_only(path.as_ref())?;
    inspect_connection(&connection)
}

/// Apply all known migrations after making a consistent SQLite backup.
///
/// A legacy database is adopted as version 1. Already-current databases
/// are not changed and do not create a backup file.
pub fn migrate_database(
    database_path: impl AsRef<Path>,
    backup_path: impl AsRef<Path>,
) -> Result<MigrationOutcome, StoreError> {
    let database_path = database_path.as_ref();
    let backup_path = backup_path.as_ref();
    ensure_distinct_paths(database_path, "database", backup_path, "backup")?;

    let mut connection = open_read_write_existing(database_path)?;
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    connection.busy_timeout(Duration::from_secs(5))?;

    let mut backup_created = false;
    let operation = (|| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let before = inspect_connection(&transaction)?;

        if let SchemaState::Versioned(version) = before.state {
            if version == LATEST_SCHEMA_VERSION {
                transaction.commit()?;
                return Ok(MigrationOutcome::AlreadyCurrent { version });
            }
        }

        // Back up through a separate read-only connection. The immediate
        // transaction holds the writer reservation so the backup snapshot
        // cannot race with another process, while avoiding SQLite's backup
        // deadlock on a connection that already owns a write transaction.
        let backup_source = open_read_only(database_path)?;
        let backup_info = create_online_backup(&backup_source, backup_path)?;
        backup_created = true;
        if backup_info != before {
            return Err(StoreError::BackupValidationFailed {
                expected: format!("{before:?}"),
                found: format!("{backup_info:?}"),
            });
        }

        apply_baseline_migration(&transaction)?;
        validate_integrity(&transaction)?;
        let after = inspect_connection(&transaction)?;
        if after.state != SchemaState::Versioned(LATEST_SCHEMA_VERSION) {
            return Err(StoreError::MigrationValidationFailed {
                expected: LATEST_SCHEMA_VERSION,
                found: format!("{:?}", after.state),
            });
        }

        transaction.commit()?;
        Ok(MigrationOutcome::Migrated {
            from: before.state,
            to: after.state,
            backup_path: backup_path.to_owned(),
        })
    })();

    if operation.is_err() && backup_created {
        remove_sqlite_files(backup_path);
    }
    operation
}

/// Restore `backup_path` over `database_path` and first save the displaced
/// database at `safety_backup_path`.
///
/// All application processes must be stopped before calling this function.
/// If restore or post-restore validation fails, the safety backup is restored
/// automatically before the original error is returned.
pub fn restore_database(
    database_path: impl AsRef<Path>,
    backup_path: impl AsRef<Path>,
    safety_backup_path: impl AsRef<Path>,
) -> Result<RestoreOutcome, StoreError> {
    let database_path = database_path.as_ref();
    let backup_path = backup_path.as_ref();
    let safety_backup_path = safety_backup_path.as_ref();
    ensure_distinct_paths(database_path, "database", backup_path, "backup")?;
    ensure_distinct_paths(
        database_path,
        "database",
        safety_backup_path,
        "safety backup",
    )?;
    ensure_distinct_paths(backup_path, "backup", safety_backup_path, "safety backup")?;

    let desired_source = open_read_only(backup_path)?;
    let desired = inspect_connection(&desired_source)?;

    let mut target = open_read_write_existing(database_path)?;
    target.busy_timeout(Duration::from_secs(5))?;
    target.execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")?;
    let previous = inspect_connection(&target)?;
    let safety = create_online_backup(&target, safety_backup_path)?;
    if safety != previous {
        remove_sqlite_files(safety_backup_path);
        return Err(StoreError::BackupValidationFailed {
            expected: format!("{previous:?}"),
            found: format!("{safety:?}"),
        });
    }

    let restore_result = restore_and_validate(&desired_source, &mut target, &desired);
    match restore_result {
        Ok(restored) => Ok(RestoreOutcome {
            previous_state: previous.state,
            restored_state: restored.state,
            safety_backup_path: safety_backup_path.to_owned(),
        }),
        Err(restore_error) => {
            let rollback_result = open_read_only(safety_backup_path).and_then(|rollback_source| {
                restore_and_validate(&rollback_source, &mut target, &previous)
            });
            match rollback_result {
                Ok(_) => Err(restore_error),
                Err(rollback_error) => Err(StoreError::RestoreRollbackFailed {
                    restore_error: restore_error.to_string(),
                    rollback_error: rollback_error.to_string(),
                }),
            }
        }
    }
}

pub(crate) fn ensure_supported_history_if_present(
    connection: &Connection,
) -> Result<(), StoreError> {
    let _ = read_schema_info(connection)?;
    Ok(())
}

fn inspect_connection(connection: &Connection) -> Result<SchemaInfo, StoreError> {
    let info = read_schema_info(connection)?;
    validate_full_legacy_schema(connection)?;
    Ok(info)
}

fn read_schema_info(connection: &Connection) -> Result<SchemaInfo, StoreError> {
    if !schema::table_exists(connection, MIGRATION_TABLE)? {
        return Ok(SchemaInfo {
            state: SchemaState::Legacy,
            migrations: Vec::new(),
        });
    }

    schema::validate_table_columns(connection, MIGRATION_TABLE, MIGRATION_COLUMNS)?;
    schema::validate_primary_key_columns(connection, MIGRATION_TABLE, &["version"])?;
    let mut statement = connection.prepare(
        "SELECT version, name, applied_at
         FROM schema_migrations
         ORDER BY version ASC",
    )?;
    let mut rows = statement.query([])?;
    let mut migrations = Vec::new();
    while let Some(row) = rows.next()? {
        let raw_version: i64 = row.get(0)?;
        let version = u32::try_from(raw_version)
            .ok()
            .filter(|value| *value > 0)
            .ok_or(StoreError::InvalidMigrationVersion(raw_version))?;
        if version > LATEST_SCHEMA_VERSION {
            return Err(StoreError::UnsupportedSchemaVersion {
                found: version,
                supported: LATEST_SCHEMA_VERSION,
            });
        }

        let expected_version = u32::try_from(migrations.len() + 1)
            .map_err(|_| StoreError::InvalidMigrationVersion(raw_version))?;
        if version != expected_version {
            return Err(StoreError::InconsistentMigrationHistory {
                expected: expected_version,
                found: version,
            });
        }

        let name: String = row.get(1)?;
        let expected_name = migration_name(version);
        if name != expected_name {
            return Err(StoreError::UnexpectedMigrationName {
                version,
                expected: expected_name,
                found: name,
            });
        }
        let applied_at_raw: String = row.get(2)?;
        let record_id = version.to_string();
        migrations.push(MigrationRecord {
            version,
            name: expected_name.to_owned(),
            applied_at: StoredTimestamp::parse(
                MIGRATION_TABLE,
                "applied_at",
                &record_id,
                applied_at_raw,
            )?,
        });
    }

    let version = migrations
        .last()
        .map(|record| record.version)
        .ok_or(StoreError::EmptyMigrationHistory)?;
    Ok(SchemaInfo {
        state: SchemaState::Versioned(version),
        migrations,
    })
}

fn apply_baseline_migration(connection: &Connection) -> Result<(), StoreError> {
    if schema::table_exists(connection, MIGRATION_TABLE)? {
        return Err(StoreError::MigrationTableAlreadyExists);
    }

    connection.execute_batch(
        "CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
         );",
    )?;
    connection.execute(
        "INSERT INTO schema_migrations (version, name, applied_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![LATEST_SCHEMA_VERSION, BASELINE_MIGRATION_NAME],
    )?;
    Ok(())
}

fn migration_name(version: u32) -> &'static str {
    match version {
        1 => BASELINE_MIGRATION_NAME,
        _ => "unknown",
    }
}

fn create_online_backup(
    source: &Connection,
    destination_path: &Path,
) -> Result<SchemaInfo, StoreError> {
    reserve_path(destination_path)?;
    let result = (|| {
        let mut destination = Connection::open_with_flags(
            destination_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        {
            let backup = Backup::new(source, &mut destination)?;
            backup.run_to_completion(100, Duration::from_millis(10), None)?;
        }
        inspect_connection(&destination)
    })();

    if result.is_err() {
        remove_sqlite_files(destination_path);
    }
    result
}

fn restore_and_validate(
    source: &Connection,
    target: &mut Connection,
    expected: &SchemaInfo,
) -> Result<SchemaInfo, StoreError> {
    {
        let restore = Backup::new(source, target)?;
        restore.run_to_completion(100, Duration::from_millis(10), None)?;
    }
    let restored = inspect_connection(target)?;
    if &restored != expected {
        return Err(StoreError::RestoreValidationFailed {
            expected: format!("{expected:?}"),
            found: format!("{restored:?}"),
        });
    }
    Ok(restored)
}

fn open_read_only(path: &Path) -> Result<Connection, StoreError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.execute_batch("PRAGMA query_only = ON;")?;
    Ok(connection)
}

fn open_read_write_existing(path: &Path) -> Result<Connection, StoreError> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

fn reserve_path(path: &Path) -> Result<(), StoreError> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => {
            drop(file);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(StoreError::BackupAlreadyExists(path.to_owned()))
        }
        Err(source) => Err(StoreError::Io {
            operation: "reserve backup path",
            path: path.to_owned(),
            source,
        }),
    }
}

fn ensure_distinct_paths(
    left: &Path,
    left_label: &'static str,
    right: &Path,
    right_label: &'static str,
) -> Result<(), StoreError> {
    let left = comparable_path(left)?;
    let right = comparable_path(right)?;
    if left == right {
        Err(StoreError::SameDatabasePath {
            left_label,
            right_label,
            path: left,
        })
    } else {
        Ok(())
    }
}

fn comparable_path(path: &Path) -> Result<PathBuf, StoreError> {
    if path.exists() {
        return fs::canonicalize(path).map_err(|source| StoreError::Io {
            operation: "canonicalize SQLite path",
            path: path.to_owned(),
            source,
        });
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| StoreError::InvalidPath(path.to_owned()))?;
    let canonical_parent = fs::canonicalize(parent).map_err(|source| StoreError::Io {
        operation: "canonicalize SQLite parent directory",
        path: parent.to_owned(),
        source,
    })?;
    Ok(canonical_parent.join(file_name))
}

fn remove_sqlite_files(path: &Path) {
    for suffix in ["", "-shm", "-wal", "-journal"] {
        let mut candidate = path.as_os_str().to_os_string();
        candidate.push(suffix);
        let candidate = PathBuf::from(candidate);
        let _ = fs::remove_file(candidate);
    }
}
