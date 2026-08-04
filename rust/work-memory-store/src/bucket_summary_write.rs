use rusqlite::{OptionalExtension, Transaction, params};

use crate::archive_write::{
    DEFAULT_BUCKET_SUMMARY_LIMIT, current_timestamp, merge_bucket_summary, required_text,
};
use crate::{StoreError, WritableSqliteStore};

/// A validated request for the standalone Python-compatible Bucket summary update path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateBucketSummaryRequest {
    bucket_id: String,
    entry_summary: String,
    max_chars: usize,
}

impl UpdateBucketSummaryRequest {
    /// Build a request using Python's default 1,200-character summary bound.
    pub fn new(
        bucket_id: impl Into<String>,
        entry_summary: impl Into<String>,
    ) -> Result<Self, StoreError> {
        Self::with_max_chars(bucket_id, entry_summary, DEFAULT_BUCKET_SUMMARY_LIMIT)
    }

    /// Build a request with an explicit Python-compatible summary bound.
    pub fn with_max_chars(
        bucket_id: impl Into<String>,
        entry_summary: impl Into<String>,
        max_chars: usize,
    ) -> Result<Self, StoreError> {
        let entry_summary = required_text(entry_summary.into(), "entry_summary")?;
        if max_chars < 100 {
            return Err(StoreError::InvalidWriteField {
                field: "max_chars",
                reason: "must be at least 100",
            });
        }

        Ok(Self {
            bucket_id: bucket_id.into(),
            entry_summary,
            max_chars,
        })
    }

    pub fn bucket_id(&self) -> &str {
        &self.bucket_id
    }

    pub fn entry_summary(&self) -> &str {
        &self.entry_summary
    }

    pub const fn max_chars(&self) -> usize {
        self.max_chars
    }
}

impl WritableSqliteStore {
    /// Merge one Entry summary into the bounded Bucket summary cache.
    ///
    /// The Bucket identifier remains exact, normalized duplicate fragments are
    /// not added again, and only `summary` plus `updated_at` are changed.
    pub fn update_bucket_summary(
        &mut self,
        request: &UpdateBucketSummaryRequest,
    ) -> Result<String, StoreError> {
        self.run_transaction(|transaction| update_bucket_summary(transaction, request))
    }
}

fn update_bucket_summary(
    transaction: &Transaction<'_>,
    request: &UpdateBucketSummaryRequest,
) -> Result<String, StoreError> {
    let existing_summary = transaction
        .query_row(
            "SELECT summary FROM buckets WHERE id = ?1",
            [&request.bucket_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::MissingRecord {
            table: "buckets",
            id: request.bucket_id.clone(),
        })?;
    let summary =
        merge_bucket_summary(&existing_summary, &request.entry_summary, request.max_chars);
    let timestamp = current_timestamp(transaction)?;
    let updated = transaction.execute(
        "UPDATE buckets
         SET summary = ?2, updated_at = ?3
         WHERE id = ?1",
        params![request.bucket_id, summary, timestamp],
    )?;
    if updated != 1 {
        return Err(StoreError::MissingRecord {
            table: "buckets",
            id: request.bucket_id.clone(),
        });
    }

    Ok(summary)
}
