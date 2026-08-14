use rusqlite::{OptionalExtension, Transaction, params};

use crate::archive_write::{current_timestamp, new_uuid_v4, required_text};
use crate::records::decode_entry;
use crate::{StoreError, StoredEntry, WritableSqliteStore};

/// A validated request for the standalone legacy-compatible Entry append path.
#[derive(Debug, Clone, PartialEq)]
pub struct AppendEntryRequest {
    bucket_id: String,
    raw_text: String,
    summary: Option<String>,
    content_type: String,
    classification_confidence: Option<f64>,
    classification_reason: Option<String>,
}

impl AppendEntryRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        bucket_id: impl Into<String>,
        raw_text: impl Into<String>,
        summary: Option<String>,
        content_type: impl Into<String>,
        classification_confidence: Option<f64>,
        classification_reason: Option<String>,
    ) -> Result<Self, StoreError> {
        if classification_confidence.is_some_and(|confidence| !(0.0..=1.0).contains(&confidence)) {
            return Err(StoreError::InvalidWriteField {
                field: "classification_confidence",
                reason: "must be between 0 and 1",
            });
        }

        Ok(Self {
            bucket_id: bucket_id.into(),
            raw_text: required_text(raw_text.into(), "raw_text")?,
            summary: optional_trim(summary),
            content_type: required_text(content_type.into(), "content_type")?,
            classification_confidence,
            classification_reason: optional_trim(classification_reason),
        })
    }

    pub fn bucket_id(&self) -> &str {
        &self.bucket_id
    }

    pub fn raw_text(&self) -> &str {
        &self.raw_text
    }

    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }

    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    pub const fn classification_confidence(&self) -> Option<f64> {
        self.classification_confidence
    }

    pub fn classification_reason(&self) -> Option<&str> {
        self.classification_reason.as_deref()
    }
}

impl WritableSqliteStore {
    /// Append one immutable Entry and refresh only its Bucket activity timestamps.
    ///
    /// The Bucket identifier remains exact, request fields follow legacy
    /// `append_entry` normalization, and no extraction or audit rows are added.
    pub fn append_entry(
        &mut self,
        request: &AppendEntryRequest,
    ) -> Result<StoredEntry, StoreError> {
        self.run_transaction(|transaction| append_entry(transaction, request))
    }
}

fn append_entry(
    transaction: &Transaction<'_>,
    request: &AppendEntryRequest,
) -> Result<StoredEntry, StoreError> {
    let bucket_id = transaction
        .query_row(
            "SELECT id FROM buckets WHERE id = ?1",
            [&request.bucket_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::MissingRecord {
            table: "buckets",
            id: request.bucket_id.clone(),
        })?;
    let timestamp = current_timestamp(transaction)?;
    let entry_id = new_uuid_v4();

    transaction.execute(
        "INSERT INTO entries (
            id, bucket_id, raw_text, summary, content_type,
            classification_confidence, classification_reason,
            created_at, moved_from_bucket_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
        params![
            entry_id,
            bucket_id,
            request.raw_text,
            request.summary,
            request.content_type,
            request.classification_confidence,
            request.classification_reason,
            timestamp,
        ],
    )?;
    let updated = transaction.execute(
        "UPDATE buckets
         SET updated_at = ?2, last_active_at = ?2
         WHERE id = ?1",
        params![bucket_id, timestamp],
    )?;
    if updated != 1 {
        return Err(StoreError::MissingRecord {
            table: "buckets",
            id: request.bucket_id.clone(),
        });
    }

    let mut statement = transaction.prepare(
        "SELECT id, bucket_id, raw_text, summary, content_type,
                classification_confidence, classification_reason,
                created_at, moved_from_bucket_id
         FROM entries
         WHERE id = ?1",
    )?;
    let mut rows = statement.query([&entry_id])?;
    rows.next()?
        .map(decode_entry)
        .transpose()?
        .ok_or(StoreError::MissingRecord {
            table: "entries",
            id: entry_id,
        })
}

fn optional_trim(value: Option<String>) -> Option<String> {
    value.and_then(|item| (!item.is_empty()).then(|| item.trim().to_owned()))
}
