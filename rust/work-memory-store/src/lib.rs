//! SQLite compatibility, inspection, and offline migration safety for the legacy-owned schema.

use std::path::PathBuf;
use thiserror::Error;

mod archive_write;
mod bucket_summary_write;
mod bucket_write;
mod canonical;
mod canonical_schema;
mod chat_write;
mod classification_write;
mod correction_write;
mod delete_write;
mod entry_write;
mod extraction_write;
mod legacy_import;
mod migration;
mod read;
mod records;
mod schema;
mod write;

pub use archive_write::{ArchiveWriteOutcome, ArchiveWriteRequest, ClassificationAuditContext};
pub use bucket_summary_write::{RebuildBucketSummaryRequest, UpdateBucketSummaryRequest};
pub use bucket_write::CreateBucketRequest;
pub use canonical::{
    ImportReport, MemoryKind, RustArchiveAttempt, RustArchiveAudit, RustArchiveOutcome, RustBucket,
    RustBucketDetail, RustChatMessage, RustCorrection, RustDeleteBucketOutcome, RustEntry,
    RustMemoryItem, RustSearchHit, RustStore, RustStoreCounts,
};
pub use chat_write::ChatMessageWriteRequest;
pub use classification_write::{SaveClassificationRecordOutcome, SaveClassificationRecordRequest};
pub use correction_write::{MoveEntryOutcome, MoveEntryRequest, MoveLatestEntryRequest};
pub use delete_write::{
    DeleteBucketOutcome, DeleteBucketRequest, DeleteEntryOutcome, DeleteEntryRequest,
};
pub use entry_write::AppendEntryRequest;
pub use extraction_write::{SaveExtractionOutcome, SaveExtractionRequest};
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
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("failed to {operation} at {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("required SQLite table is missing: {0}")]
    MissingTable(&'static str),
    #[error("required SQLite column is missing: {table}.{column}")]
    MissingColumn {
        table: &'static str,
        column: &'static str,
    },
    #[error("invalid primary key for {table}: expected {expected:?}, found {found:?}")]
    InvalidPrimaryKey {
        table: &'static str,
        expected: &'static [&'static str],
        found: Vec<String>,
    },
    #[error("required SQLite index is missing: {table}.{index}")]
    MissingIndex {
        table: &'static str,
        index: &'static str,
    },
    #[error(
        "invalid columns for SQLite index {table}.{index}: expected {expected:?}, found {found:?}"
    )]
    InvalidIndexColumns {
        table: &'static str,
        index: &'static str,
        expected: &'static [&'static str],
        found: Vec<String>,
    },
    #[error(
        "required foreign key is missing: {table}.{column} -> {referenced_table}.{referenced_column} ON DELETE {on_delete}"
    )]
    MissingForeignKey {
        table: &'static str,
        column: &'static str,
        referenced_table: &'static str,
        referenced_column: &'static str,
        on_delete: &'static str,
    },
    #[error("SQLite quick_check failed: {0}")]
    IntegrityCheckFailed(String),
    #[error(
        "SQLite foreign_key_check failed for {table} row {row_id:?}, parent {parent}, constraint {foreign_key_id}"
    )]
    ForeignKeyCheckFailed {
        table: String,
        row_id: Option<i64>,
        parent: String,
        foreign_key_id: i64,
    },
    #[error("invalid SQLite migration version: {0}")]
    InvalidMigrationVersion(i64),
    #[error("SQLite schema version {found} is newer than supported version {supported}")]
    UnsupportedSchemaVersion { found: u32, supported: u32 },
    #[error("inconsistent SQLite migration history: expected version {expected}, found {found}")]
    InconsistentMigrationHistory { expected: u32, found: u32 },
    #[error("unexpected name for SQLite migration {version}: expected {expected}, found {found}")]
    UnexpectedMigrationName {
        version: u32,
        expected: &'static str,
        found: String,
    },
    #[error("schema_migrations exists but contains no migration records")]
    EmptyMigrationHistory,
    #[error("schema_migrations already exists before baseline migration")]
    MigrationTableAlreadyExists,
    #[error("backup path already exists: {0}")]
    BackupAlreadyExists(PathBuf),
    #[error("SQLite backup validation failed: expected {expected}, found {found}")]
    BackupValidationFailed { expected: String, found: String },
    #[error("SQLite migration validation failed: expected version {expected}, found {found}")]
    MigrationValidationFailed { expected: u32, found: String },
    #[error("SQLite restore validation failed: expected {expected}, found {found}")]
    RestoreValidationFailed { expected: String, found: String },
    #[error(
        "SQLite restore failed ({restore_error}) and safety rollback also failed ({rollback_error})"
    )]
    RestoreRollbackFailed {
        restore_error: String,
        rollback_error: String,
    },
    #[error("{left_label} and {right_label} paths must differ: {path}")]
    SameDatabasePath {
        left_label: &'static str,
        right_label: &'static str,
        path: PathBuf,
    },
    #[error("invalid SQLite path: {0}")]
    InvalidPath(PathBuf),
    #[error("bucket {bucket_id} contains unsupported type value: {value}")]
    InvalidBucketType { bucket_id: String, value: String },
    #[error("bucket {bucket_id} contains unsupported status value: {value}")]
    InvalidBucketStatus { bucket_id: String, value: String },
    #[error("todo {todo_id} contains unsupported status value: {value}")]
    InvalidTodoStatus { todo_id: String, value: String },
    #[error(
        "classification record {classification_record_id} contains unsupported action value: {value}"
    )]
    InvalidClassificationAction {
        classification_record_id: String,
        value: String,
    },
    #[error("chat message {chat_message_id} contains unsupported role value: {value}")]
    InvalidChatRole {
        chat_message_id: String,
        value: String,
    },
    #[error("invalid JSON in {table}.{column} for record {record_id}: {source}")]
    InvalidJson {
        table: &'static str,
        column: &'static str,
        record_id: String,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "invalid JSON type in {table}.{column} for record {record_id}: expected {expected}, found {found}"
    )]
    InvalidJsonType {
        table: &'static str,
        column: &'static str,
        record_id: String,
        expected: &'static str,
        found: &'static str,
    },
    #[error(
        "invalid boolean in {table}.{column} for record {record_id}: expected 0 or 1, found {value}"
    )]
    InvalidBoolean {
        table: &'static str,
        column: &'static str,
        record_id: String,
        value: i64,
    },
    #[error("invalid timestamp in {table}.{column} for record {record_id}: {value}")]
    InvalidTimestamp {
        table: &'static str,
        column: &'static str,
        record_id: String,
        value: String,
    },
    #[error("query limit must be at least 1, got {0}")]
    InvalidLimit(usize),
    #[error(
        "SQLite write connection is not ready: opened_read_only={opened_read_only}, query_only={query_only}, foreign_keys={foreign_keys}"
    )]
    WriteConnectionNotReady {
        opened_read_only: bool,
        query_only: bool,
        foreign_keys: bool,
    },
    #[error(
        "SQLite schema changed after write-store validation: expected schema_version {expected}, found {found}"
    )]
    SchemaChangedAfterValidation { expected: i64, found: i64 },
    #[error("invalid write field {field}: {reason}")]
    InvalidWriteField {
        field: &'static str,
        reason: &'static str,
    },
    #[error("invalid archive write for action {action}: {reason}")]
    InvalidArchiveWrite {
        action: &'static str,
        reason: &'static str,
    },
    #[error("archive confirmation attempt was not found: {0}")]
    ArchiveAttemptNotFound(String),
    #[error("archive confirmation attempt is no longer pending: {0}")]
    ArchiveAttemptNotPending(String),
    #[error("archive confirmation text does not match attempt: {0}")]
    ArchiveAttemptTextMismatch(String),
    #[error("invalid correction write for action {action}: {reason}")]
    InvalidCorrectionWrite {
        action: &'static str,
        reason: &'static str,
    },
    #[error("no entry is available to correct")]
    NoEntryAvailableToCorrect,
    #[error("no Bucket title contains the correction target: {title}")]
    NoMatchingCorrectionBucket { title: String },
    #[error("multiple Bucket titles contain the correction target: {title}")]
    AmbiguousCorrectionBucket { title: String },
    #[error("required {table} record was not found: {id}")]
    MissingRecord { table: &'static str, id: String },
    #[error("canonical Rust schema already exists or target database is not empty")]
    CanonicalSchemaAlreadyExists,
    #[error("canonical Rust schema marker is missing")]
    CanonicalSchemaMarkerMissing,
    #[error("canonical Rust schema kind mismatch: found {found}")]
    CanonicalSchemaKindMismatch { found: String },
    #[error("invalid canonical Rust schema version value: {0}")]
    CanonicalSchemaVersionInvalid(String),
    #[error("canonical Rust schema version {found} is newer than supported version {supported}")]
    UnsupportedCanonicalSchemaVersion { found: u32, supported: u32 },
    #[error("canonical Rust migration mismatch: version {version}, name {name}")]
    CanonicalMigrationMismatch { version: i64, name: String },
    #[error("unexpected object in canonical Rust schema: {object_type} {name}")]
    UnexpectedCanonicalObject { object_type: String, name: String },
    #[error("canonical Rust schema constraint is missing: {table}.{constraint}")]
    MissingCanonicalConstraint {
        table: &'static str,
        constraint: &'static str,
    },
    #[error("invalid canonical memory kind: {value}")]
    InvalidCanonicalMemoryKind { value: String },
    #[error("legacy import target database must be empty: {0}")]
    ImportTargetNotEmpty(PathBuf),
    #[error("legacy import source and target must differ: {path}")]
    ImportSourceTargetSame { path: PathBuf },
    #[error(
        "legacy memory item ID collision: {id} appears in both {first_table} and {second_table}"
    )]
    LegacyMemoryIdCollision {
        id: String,
        first_table: &'static str,
        second_table: &'static str,
    },
    #[error("legacy import failed for {table}.{column} record {record_id}: {reason}")]
    LegacyImportRecord {
        table: &'static str,
        column: &'static str,
        record_id: String,
        reason: String,
    },
    #[error("failed to serialize JSON for {context}: {source}")]
    JsonSerialization {
        context: &'static str,
        #[source]
        source: serde_json::Error,
    },
}
