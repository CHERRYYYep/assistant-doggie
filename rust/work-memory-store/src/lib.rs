//! Read-only access to the SQLite schema currently owned by the Python runtime.

use std::collections::HashSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::Path;

use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{Connection, DatabaseName, OpenFlags, Row};
use work_memory_core::{BucketStatus, BucketType};

const REQUIRED_BUCKET_COLUMNS: &[&str] = &[
    "id",
    "title",
    "type",
    "status",
    "summary",
    "tags",
    "created_at",
    "updated_at",
    "last_active_at",
];
const REQUIRED_ENTRY_COLUMNS: &[&str] = &[
    "id",
    "bucket_id",
    "raw_text",
    "summary",
    "content_type",
    "classification_confidence",
    "classification_reason",
    "created_at",
    "moved_from_bucket_id",
];

/// A timestamp parsed from SQLite while retaining the exact persisted text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTimestamp {
    raw: String,
    utc_naive: NaiveDateTime,
}

impl StoredTimestamp {
    /// Return the exact text stored by SQLite.
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// Return the timestamp normalized to a timezone-free UTC value.
    ///
    /// SQLAlchemy's SQLite adapter omits the UTC offset. Such values are treated
    /// as UTC because the Python application writes them with `utc_now()`.
    pub const fn utc_naive(&self) -> &NaiveDateTime {
        &self.utc_naive
    }

    fn parse(
        table: &'static str,
        column: &'static str,
        record_id: &str,
        raw: String,
    ) -> Result<Self, StoreError> {
        let sqlite_value = NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S%.f");
        let utc_naive = match sqlite_value {
            Ok(value) => value,
            Err(_) => DateTime::parse_from_rfc3339(&raw)
                .map(|value| value.with_timezone(&Utc).naive_utc())
                .map_err(|_| StoreError::InvalidTimestamp {
                    table,
                    column,
                    record_id: record_id.to_owned(),
                    value: raw.clone(),
                })?,
        };

        Ok(Self { raw, utc_naive })
    }
}

impl Display for StoredTimestamp {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.raw)
    }
}

/// A Bucket row decoded from the current Python-managed SQLite schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredBucket {
    pub id: String,
    pub title: String,
    pub bucket_type: BucketType,
    pub status: BucketStatus,
    pub summary: String,
    pub tags: Vec<String>,
    pub created_at: StoredTimestamp,
    pub updated_at: StoredTimestamp,
    pub last_active_at: StoredTimestamp,
}

/// An immutable Entry row decoded from the current Python-managed schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEntry {
    pub id: String,
    pub bucket_id: String,
    pub raw_text: String,
    pub summary: Option<String>,
    pub content_type: String,
    pub classification_confidence: Option<f64>,
    pub classification_reason: Option<String>,
    pub created_at: StoredTimestamp,
    pub moved_from_bucket_id: Option<String>,
}

/// Failures at the SQLite compatibility boundary.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    MissingTable(&'static str),
    MissingColumn {
        table: &'static str,
        column: &'static str,
    },
    InvalidBucketType {
        bucket_id: String,
        value: String,
    },
    InvalidBucketStatus {
        bucket_id: String,
        value: String,
    },
    InvalidJson {
        table: &'static str,
        column: &'static str,
        record_id: String,
        source: serde_json::Error,
    },
    InvalidTimestamp {
        table: &'static str,
        column: &'static str,
        record_id: String,
        value: String,
    },
    InvalidLimit(usize),
}

impl Display for StoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "SQLite error: {error}"),
            Self::MissingTable(table) => {
                write!(formatter, "required SQLite table is missing: {table}")
            }
            Self::MissingColumn { table, column } => {
                write!(
                    formatter,
                    "required SQLite column is missing: {table}.{column}"
                )
            }
            Self::InvalidBucketType { bucket_id, value } => write!(
                formatter,
                "bucket {bucket_id} contains unsupported type value: {value}"
            ),
            Self::InvalidBucketStatus { bucket_id, value } => write!(
                formatter,
                "bucket {bucket_id} contains unsupported status value: {value}"
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
                write!(formatter, "bucket limit must be at least 1, got {limit}")
            }
        }
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::InvalidJson { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// Read-only SQLite repository for the first R2 compatibility slice.
pub struct SqliteStore {
    connection: Connection,
}

impl SqliteStore {
    /// Open an existing database without create or write permissions.
    ///
    /// The constructor validates the Bucket/Entry tables and their required
    /// columns before returning a usable store.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.execute_batch("PRAGMA query_only = ON;")?;

        validate_table(&connection, "buckets", REQUIRED_BUCKET_COLUMNS)?;
        validate_table(&connection, "entries", REQUIRED_ENTRY_COLUMNS)?;

        Ok(Self { connection })
    }

    /// Report whether the connection has SQLite query-only protection enabled.
    pub fn is_read_only(&self) -> Result<bool, StoreError> {
        let opened_read_only = self.connection.is_readonly(DatabaseName::Main)?;
        let query_only = self
            .connection
            .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))?;
        Ok(opened_read_only && query_only == 1)
    }

    /// Return active Buckets using the same ordering and limit rules as Python.
    pub fn list_active_buckets(&self, limit: usize) -> Result<Vec<StoredBucket>, StoreError> {
        if limit < 1 {
            return Err(StoreError::InvalidLimit(limit));
        }

        let mut statement = self.connection.prepare(
            "SELECT id, title, type, status, summary, tags, created_at, updated_at, last_active_at
             FROM buckets
             WHERE status = 'active'
             ORDER BY last_active_at DESC, updated_at DESC
             LIMIT ?1",
        )?;
        let sql_limit = i64::try_from(limit).map_err(|_| StoreError::InvalidLimit(limit))?;
        let mut rows = statement.query([sql_limit])?;
        let mut buckets = Vec::new();
        while let Some(row) = rows.next()? {
            buckets.push(decode_bucket(row)?);
        }
        Ok(buckets)
    }

    /// Return one Bucket by primary key, or `None` when it does not exist.
    pub fn get_bucket(&self, bucket_id: &str) -> Result<Option<StoredBucket>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, type, status, summary, tags, created_at, updated_at, last_active_at
             FROM buckets
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([bucket_id])?;
        rows.next()?.map(decode_bucket).transpose()
    }

    /// Return a Bucket's immutable Entries in the Python relationship order.
    pub fn list_bucket_entries(&self, bucket_id: &str) -> Result<Vec<StoredEntry>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, raw_text, summary, content_type,
                    classification_confidence, classification_reason, created_at,
                    moved_from_bucket_id
             FROM entries
             WHERE bucket_id = ?1
             ORDER BY created_at ASC",
        )?;
        let mut rows = statement.query([bucket_id])?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            entries.push(decode_entry(row)?);
        }
        Ok(entries)
    }
}

fn validate_table(
    connection: &Connection,
    table: &'static str,
    required_columns: &[&'static str],
) -> Result<(), StoreError> {
    let table_exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, bool>(0),
    )?;
    if !table_exists {
        return Err(StoreError::MissingTable(table));
    }

    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&pragma)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    for column in required_columns {
        if !columns.contains(*column) {
            return Err(StoreError::MissingColumn { table, column });
        }
    }
    Ok(())
}

fn decode_bucket(row: &Row<'_>) -> Result<StoredBucket, StoreError> {
    let id: String = row.get(0)?;
    let bucket_type_value: String = row.get(2)?;
    let status_value: String = row.get(3)?;
    let tags_value: String = row.get(5)?;
    let created_at: String = row.get(6)?;
    let updated_at: String = row.get(7)?;
    let last_active_at: String = row.get(8)?;

    Ok(StoredBucket {
        title: row.get(1)?,
        bucket_type: parse_bucket_type(&id, bucket_type_value)?,
        status: parse_bucket_status(&id, status_value)?,
        summary: row.get(4)?,
        tags: serde_json::from_str(&tags_value).map_err(|source| StoreError::InvalidJson {
            table: "buckets",
            column: "tags",
            record_id: id.clone(),
            source,
        })?,
        created_at: StoredTimestamp::parse("buckets", "created_at", &id, created_at)?,
        updated_at: StoredTimestamp::parse("buckets", "updated_at", &id, updated_at)?,
        last_active_at: StoredTimestamp::parse("buckets", "last_active_at", &id, last_active_at)?,
        id,
    })
}

fn decode_entry(row: &Row<'_>) -> Result<StoredEntry, StoreError> {
    let id: String = row.get(0)?;
    let created_at: String = row.get(7)?;

    Ok(StoredEntry {
        bucket_id: row.get(1)?,
        raw_text: row.get(2)?,
        summary: row.get(3)?,
        content_type: row.get(4)?,
        classification_confidence: row.get(5)?,
        classification_reason: row.get(6)?,
        created_at: StoredTimestamp::parse("entries", "created_at", &id, created_at)?,
        moved_from_bucket_id: row.get(8)?,
        id,
    })
}

fn parse_bucket_type(bucket_id: &str, value: String) -> Result<BucketType, StoreError> {
    match value.as_str() {
        "idea" => Ok(BucketType::Idea),
        "task" => Ok(BucketType::Task),
        "incident" => Ok(BucketType::Incident),
        "experiment" => Ok(BucketType::Experiment),
        "decision" => Ok(BucketType::Decision),
        "meeting" => Ok(BucketType::Meeting),
        "knowledge" => Ok(BucketType::Knowledge),
        "draft" => Ok(BucketType::Draft),
        _ => Err(StoreError::InvalidBucketType {
            bucket_id: bucket_id.to_owned(),
            value,
        }),
    }
}

fn parse_bucket_status(bucket_id: &str, value: String) -> Result<BucketStatus, StoreError> {
    match value.as_str() {
        "active" => Ok(BucketStatus::Active),
        "paused" => Ok(BucketStatus::Paused),
        "done" => Ok(BucketStatus::Done),
        "archived" => Ok(BucketStatus::Archived),
        _ => Err(StoreError::InvalidBucketStatus {
            bucket_id: bucket_id.to_owned(),
            value,
        }),
    }
}
