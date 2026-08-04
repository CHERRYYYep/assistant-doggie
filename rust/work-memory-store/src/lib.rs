//! SQLite compatibility, inspection, and offline migration safety for the Python-owned schema.

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::PathBuf;

mod archive_write;
mod bucket_write;
mod chat_write;
mod correction_write;
mod delete_write;
mod migration;
mod read;
mod records;
mod schema;
mod write;

pub use archive_write::{ArchiveWriteOutcome, ArchiveWriteRequest, ClassificationAuditContext};
pub use bucket_write::CreateBucketRequest;
pub use chat_write::ChatMessageWriteRequest;
pub use correction_write::{MoveEntryOutcome, MoveEntryRequest};
pub use delete_write::{
    DeleteBucketOutcome, DeleteBucketRequest, DeleteEntryOutcome, DeleteEntryRequest,
};
pub use migration::{
    LATEST_SCHEMA_VERSION, MigrationOutcome, MigrationRecord, RestoreOutcome, SchemaInfo,
    SchemaState, inspect_database, migrate_database, restore_database,
};

pub use read::SqliteStore;
pub use records::{
    StoredBucket, StoredChatMessage, StoredClassificationRecord, StoredCorrection, StoredDecision,
    StoredEntry, StoredEvidence, StoredTimelineEvent, StoredTimestamp, StoredTodo, TodoStatus,
};
pub use work_memory_contracts::ChatRole;
pub use write::WritableSqliteStore;
/// Failures at the SQLite compatibility boundary.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Io {
        operation: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    MissingTable(&'static str),
    MissingColumn {
        table: &'static str,
        column: &'static str,
    },
    InvalidPrimaryKey {
        table: &'static str,
        expected: &'static [&'static str],
        found: Vec<String>,
    },
    MissingIndex {
        table: &'static str,
        index: &'static str,
    },
    InvalidIndexColumns {
        table: &'static str,
        index: &'static str,
        expected: &'static [&'static str],
        found: Vec<String>,
    },
    MissingForeignKey {
        table: &'static str,
        column: &'static str,
        referenced_table: &'static str,
        referenced_column: &'static str,
        on_delete: &'static str,
    },
    IntegrityCheckFailed(String),
    ForeignKeyCheckFailed {
        table: String,
        row_id: Option<i64>,
        parent: String,
        foreign_key_id: i64,
    },
    InvalidMigrationVersion(i64),
    UnsupportedSchemaVersion {
        found: u32,
        supported: u32,
    },
    InconsistentMigrationHistory {
        expected: u32,
        found: u32,
    },
    UnexpectedMigrationName {
        version: u32,
        expected: &'static str,
        found: String,
    },
    EmptyMigrationHistory,
    MigrationTableAlreadyExists,
    BackupAlreadyExists(PathBuf),
    BackupValidationFailed {
        expected: String,
        found: String,
    },
    MigrationValidationFailed {
        expected: u32,
        found: String,
    },
    RestoreValidationFailed {
        expected: String,
        found: String,
    },
    RestoreRollbackFailed {
        restore_error: String,
        rollback_error: String,
    },
    SameDatabasePath {
        left_label: &'static str,
        right_label: &'static str,
        path: PathBuf,
    },
    InvalidPath(PathBuf),
    InvalidBucketType {
        bucket_id: String,
        value: String,
    },
    InvalidBucketStatus {
        bucket_id: String,
        value: String,
    },
    InvalidTodoStatus {
        todo_id: String,
        value: String,
    },
    InvalidClassificationAction {
        classification_record_id: String,
        value: String,
    },
    InvalidChatRole {
        chat_message_id: String,
        value: String,
    },
    InvalidJson {
        table: &'static str,
        column: &'static str,
        record_id: String,
        source: serde_json::Error,
    },
    InvalidJsonType {
        table: &'static str,
        column: &'static str,
        record_id: String,
        expected: &'static str,
        found: &'static str,
    },
    InvalidBoolean {
        table: &'static str,
        column: &'static str,
        record_id: String,
        value: i64,
    },
    InvalidTimestamp {
        table: &'static str,
        column: &'static str,
        record_id: String,
        value: String,
    },
    InvalidLimit(usize),
    WriteConnectionNotReady {
        opened_read_only: bool,
        query_only: bool,
        foreign_keys: bool,
    },
    SchemaChangedAfterValidation {
        expected: i64,
        found: i64,
    },
    InvalidWriteField {
        field: &'static str,
        reason: &'static str,
    },
    InvalidArchiveWrite {
        action: &'static str,
        reason: &'static str,
    },
    InvalidCorrectionWrite {
        action: &'static str,
        reason: &'static str,
    },
    MissingRecord {
        table: &'static str,
        id: String,
    },
    JsonSerialization {
        context: &'static str,
        source: serde_json::Error,
    },
    InvalidGeneratedIdLength(usize),
}

impl Display for StoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "SQLite error: {error}"),
            Self::Io {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "failed to {operation} at {}: {source}",
                path.display()
            ),
            Self::MissingTable(table) => {
                write!(formatter, "required SQLite table is missing: {table}")
            }
            Self::MissingColumn { table, column } => {
                write!(
                    formatter,
                    "required SQLite column is missing: {table}.{column}"
                )
            }
            Self::InvalidPrimaryKey {
                table,
                expected,
                found,
            } => write!(
                formatter,
                "invalid primary key for {table}: expected {expected:?}, found {found:?}"
            ),
            Self::MissingIndex { table, index } => {
                write!(
                    formatter,
                    "required SQLite index is missing: {table}.{index}"
                )
            }
            Self::InvalidIndexColumns {
                table,
                index,
                expected,
                found,
            } => write!(
                formatter,
                "invalid columns for SQLite index {table}.{index}: expected {expected:?}, found {found:?}"
            ),
            Self::MissingForeignKey {
                table,
                column,
                referenced_table,
                referenced_column,
                on_delete,
            } => write!(
                formatter,
                "required foreign key is missing: {table}.{column} -> {referenced_table}.{referenced_column} ON DELETE {on_delete}"
            ),
            Self::IntegrityCheckFailed(result) => {
                write!(formatter, "SQLite quick_check failed: {result}")
            }
            Self::ForeignKeyCheckFailed {
                table,
                row_id,
                parent,
                foreign_key_id,
            } => write!(
                formatter,
                "SQLite foreign_key_check failed for {table} row {row_id:?}, parent {parent}, constraint {foreign_key_id}"
            ),
            Self::InvalidMigrationVersion(version) => {
                write!(formatter, "invalid SQLite migration version: {version}")
            }
            Self::UnsupportedSchemaVersion { found, supported } => write!(
                formatter,
                "SQLite schema version {found} is newer than supported version {supported}"
            ),
            Self::InconsistentMigrationHistory { expected, found } => write!(
                formatter,
                "inconsistent SQLite migration history: expected version {expected}, found {found}"
            ),
            Self::UnexpectedMigrationName {
                version,
                expected,
                found,
            } => write!(
                formatter,
                "unexpected name for SQLite migration {version}: expected {expected}, found {found}"
            ),
            Self::EmptyMigrationHistory => {
                formatter.write_str("schema_migrations exists but contains no migration records")
            }
            Self::MigrationTableAlreadyExists => {
                formatter.write_str("schema_migrations already exists before baseline migration")
            }
            Self::BackupAlreadyExists(path) => {
                write!(formatter, "backup path already exists: {}", path.display())
            }
            Self::BackupValidationFailed { expected, found } => write!(
                formatter,
                "SQLite backup validation failed: expected {expected}, found {found}"
            ),
            Self::MigrationValidationFailed { expected, found } => write!(
                formatter,
                "SQLite migration validation failed: expected version {expected}, found {found}"
            ),
            Self::RestoreValidationFailed { expected, found } => write!(
                formatter,
                "SQLite restore validation failed: expected {expected}, found {found}"
            ),
            Self::RestoreRollbackFailed {
                restore_error,
                rollback_error,
            } => write!(
                formatter,
                "SQLite restore failed ({restore_error}) and safety rollback also failed ({rollback_error})"
            ),
            Self::SameDatabasePath {
                left_label,
                right_label,
                path,
            } => write!(
                formatter,
                "{left_label} and {right_label} paths must differ: {}",
                path.display()
            ),
            Self::InvalidPath(path) => {
                write!(formatter, "invalid SQLite path: {}", path.display())
            }
            Self::InvalidBucketType { bucket_id, value } => write!(
                formatter,
                "bucket {bucket_id} contains unsupported type value: {value}"
            ),
            Self::InvalidBucketStatus { bucket_id, value } => write!(
                formatter,
                "bucket {bucket_id} contains unsupported status value: {value}"
            ),
            Self::InvalidTodoStatus { todo_id, value } => write!(
                formatter,
                "todo {todo_id} contains unsupported status value: {value}"
            ),
            Self::InvalidClassificationAction {
                classification_record_id,
                value,
            } => write!(
                formatter,
                "classification record {classification_record_id} contains unsupported action value: {value}"
            ),
            Self::InvalidChatRole {
                chat_message_id,
                value,
            } => write!(
                formatter,
                "chat message {chat_message_id} contains unsupported role value: {value}"
            ),
            Self::InvalidJson {
                table,
                column,
                record_id,
                source,
            } => write!(
                formatter,
                "invalid JSON in {table}.{column} for record {record_id}: {source}"
            ),
            Self::InvalidJsonType {
                table,
                column,
                record_id,
                expected,
                found,
            } => write!(
                formatter,
                "invalid JSON type in {table}.{column} for record {record_id}: expected {expected}, found {found}"
            ),
            Self::InvalidBoolean {
                table,
                column,
                record_id,
                value,
            } => write!(
                formatter,
                "invalid boolean in {table}.{column} for record {record_id}: expected 0 or 1, found {value}"
            ),
            Self::InvalidTimestamp {
                table,
                column,
                record_id,
                value,
            } => write!(
                formatter,
                "invalid timestamp in {table}.{column} for record {record_id}: {value}"
            ),
            Self::InvalidLimit(limit) => {
                write!(formatter, "query limit must be at least 1, got {limit}")
            }
            Self::WriteConnectionNotReady {
                opened_read_only,
                query_only,
                foreign_keys,
            } => write!(
                formatter,
                "SQLite write connection is not ready: opened_read_only={opened_read_only}, query_only={query_only}, foreign_keys={foreign_keys}"
            ),
            Self::SchemaChangedAfterValidation { expected, found } => write!(
                formatter,
                "SQLite schema changed after write-store validation: expected schema_version {expected}, found {found}"
            ),
            Self::InvalidWriteField { field, reason } => {
                write!(formatter, "invalid write field {field}: {reason}")
            }
            Self::InvalidArchiveWrite { action, reason } => {
                write!(
                    formatter,
                    "invalid archive write for action {action}: {reason}"
                )
            }
            Self::InvalidCorrectionWrite { action, reason } => {
                write!(
                    formatter,
                    "invalid correction write for action {action}: {reason}"
                )
            }
            Self::MissingRecord { table, id } => {
                write!(formatter, "required {table} record was not found: {id}")
            }
            Self::JsonSerialization { context, source } => {
                write!(
                    formatter,
                    "failed to serialize JSON for {context}: {source}"
                )
            }
            Self::InvalidGeneratedIdLength(length) => write!(
                formatter,
                "SQLite random ID source returned {length} bytes instead of 16"
            ),
        }
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            Self::InvalidJson { source, .. } => Some(source),
            Self::JsonSerialization { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}
