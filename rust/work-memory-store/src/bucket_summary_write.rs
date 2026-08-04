use std::collections::HashSet;

use rusqlite::{OptionalExtension, Transaction, params};

use crate::archive_write::{
    DEFAULT_BUCKET_SUMMARY_LIMIT, current_timestamp, merge_bucket_summary, required_text,
};
use crate::{StoreError, WritableSqliteStore};

pub(crate) const DEFAULT_REBUILD_ENTRY_LIMIT: i64 = 8;

/// A validated request for the standalone Python-compatible Bucket summary update path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateBucketSummaryRequest {
    bucket_id: String,
    entry_summary: String,
    max_chars: usize,
}

/// A validated request for the standalone Python-compatible Bucket summary rebuild path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildBucketSummaryRequest {
    bucket_id: String,
    max_entries: i64,
    max_chars: i64,
}

impl RebuildBucketSummaryRequest {
    /// Build a request using Python's defaults of eight Entries and 1,200 characters.
    pub fn new(bucket_id: impl Into<String>) -> Result<Self, StoreError> {
        Self::with_limits(
            bucket_id,
            DEFAULT_REBUILD_ENTRY_LIMIT,
            DEFAULT_BUCKET_SUMMARY_LIMIT as i64,
        )
    }

    /// Build a request with explicit Python-compatible Entry and character limits.
    pub fn with_limits(
        bucket_id: impl Into<String>,
        max_entries: i64,
        max_chars: i64,
    ) -> Result<Self, StoreError> {
        if max_entries < 1 {
            return Err(StoreError::InvalidWriteField {
                field: "max_entries",
                reason: "must be at least 1",
            });
        }

        Ok(Self {
            bucket_id: bucket_id.into(),
            max_entries,
            max_chars,
        })
    }

    pub fn bucket_id(&self) -> &str {
        &self.bucket_id
    }

    pub const fn max_entries(&self) -> i64 {
        self.max_entries
    }

    pub const fn max_chars(&self) -> i64 {
        self.max_chars
    }
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

    /// Rebuild the Bucket summary cache from its newest surviving Entry summaries.
    ///
    /// Selection, cleaning, exact deduplication, ordering, and Python slicing
    /// behavior match `rebuild_bucket_summary`; only `summary` and `updated_at`
    /// are changed.
    pub fn rebuild_bucket_summary(
        &mut self,
        request: &RebuildBucketSummaryRequest,
    ) -> Result<String, StoreError> {
        self.run_transaction(|transaction| {
            ensure_bucket_exists(transaction, request.bucket_id())?;
            rebuild_bucket_summary(
                transaction,
                request.bucket_id(),
                request.max_entries(),
                request.max_chars(),
            )
        })
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

pub(crate) fn rebuild_bucket_summary(
    transaction: &Transaction<'_>,
    bucket_id: &str,
    max_entries: i64,
    max_chars: i64,
) -> Result<String, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT summary FROM entries
         WHERE bucket_id = ?1 AND summary IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![bucket_id, max_entries], |row| {
        row.get::<_, String>(0)
    })?;
    let mut newest_first = rows.collect::<Result<Vec<_>, _>>()?;
    newest_first.reverse();

    let mut seen = HashSet::new();
    let fragments = newest_first
        .into_iter()
        .filter_map(|summary| {
            let cleaned = summary.trim();
            (!cleaned.is_empty() && seen.insert(cleaned.to_owned())).then(|| cleaned.to_owned())
        })
        .collect::<Vec<_>>();
    let summary = truncate_summary(fragments.join("\n"), max_chars);
    let timestamp = current_timestamp(transaction)?;
    let updated = transaction.execute(
        "UPDATE buckets SET summary = ?2, updated_at = ?3 WHERE id = ?1",
        params![bucket_id, summary, timestamp],
    )?;
    if updated != 1 {
        return Err(StoreError::MissingRecord {
            table: "buckets",
            id: bucket_id.to_owned(),
        });
    }
    Ok(summary)
}

pub(crate) fn truncate_summary(summary: String, max_chars: i64) -> String {
    let character_count = i64::try_from(summary.chars().count()).unwrap_or(i64::MAX);
    if character_count <= max_chars {
        return summary;
    }

    let python_stop = max_chars.saturating_sub(1);
    let retained = if python_stop >= 0 {
        python_stop.min(character_count)
    } else {
        character_count.saturating_add(python_stop).max(0)
    };
    let mut truncated = summary
        .chars()
        .take(usize::try_from(retained).unwrap_or(usize::MAX))
        .collect::<String>();
    truncated = truncated.trim_end().to_owned();
    truncated.push('…');
    truncated
}

fn ensure_bucket_exists(transaction: &Transaction<'_>, bucket_id: &str) -> Result<(), StoreError> {
    transaction
        .query_row("SELECT 1 FROM buckets WHERE id = ?1", [bucket_id], |_| {
            Ok(())
        })
        .optional()?
        .ok_or_else(|| StoreError::MissingRecord {
            table: "buckets",
            id: bucket_id.to_owned(),
        })
}
