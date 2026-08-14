use doggie_domain::ExtractionResult;
use rusqlite::{OptionalExtension, Transaction, params};

use crate::archive_write::{
    DEFAULT_BUCKET_SUMMARY_LIMIT, current_timestamp, get_bucket, insert_extracted_children,
    update_bucket_cache,
};
use crate::{StoreError, WritableSqliteStore};

/// A validated extraction to persist against one exact existing Entry and Bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveExtractionRequest {
    bucket_id: String,
    entry_id: String,
    extraction: ExtractionResult,
}

impl SaveExtractionRequest {
    pub fn new(
        bucket_id: impl Into<String>,
        entry_id: impl Into<String>,
        extraction: ExtractionResult,
    ) -> Self {
        Self {
            bucket_id: bucket_id.into(),
            entry_id: entry_id.into(),
            extraction,
        }
    }

    pub fn bucket_id(&self) -> &str {
        &self.bucket_id
    }

    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }

    pub const fn extraction(&self) -> &ExtractionResult {
        &self.extraction
    }
}

/// IDs of the structured rows created by one committed extraction save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveExtractionOutcome {
    bucket_id: String,
    entry_id: String,
    todo_ids: Vec<String>,
    evidence_ids: Vec<String>,
    timeline_event_ids: Vec<String>,
    decision_ids: Vec<String>,
}

impl SaveExtractionOutcome {
    pub fn bucket_id(&self) -> &str {
        &self.bucket_id
    }

    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }

    pub fn todo_ids(&self) -> &[String] {
        &self.todo_ids
    }

    pub fn evidence_ids(&self) -> &[String] {
        &self.evidence_ids
    }

    pub fn timeline_event_ids(&self) -> &[String] {
        &self.timeline_event_ids
    }

    pub fn decision_ids(&self) -> &[String] {
        &self.decision_ids
    }
}

impl WritableSqliteStore {
    /// Persist validated extracted facts for one existing Entry.
    ///
    /// The exact Bucket and Entry relationship is checked before business
    /// changes. New structured rows, the Entry summary, merged Bucket tags,
    /// and the rolling Bucket summary are then committed atomically.
    pub fn save_extraction(
        &mut self,
        request: &SaveExtractionRequest,
    ) -> Result<SaveExtractionOutcome, StoreError> {
        self.run_transaction(|transaction| save_extraction(transaction, request))
    }
}

fn save_extraction(
    transaction: &Transaction<'_>,
    request: &SaveExtractionRequest,
) -> Result<SaveExtractionOutcome, StoreError> {
    let bucket =
        get_bucket(transaction, request.bucket_id())?.ok_or_else(|| StoreError::MissingRecord {
            table: "buckets",
            id: request.bucket_id.clone(),
        })?;
    let entry_bucket_id = transaction
        .query_row(
            "SELECT bucket_id FROM entries WHERE id = ?1",
            [request.entry_id()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if entry_bucket_id.as_deref() != Some(request.bucket_id()) {
        return Err(StoreError::MissingRecord {
            table: "entries",
            id: request.entry_id.clone(),
        });
    }

    let timestamp = current_timestamp(transaction)?;
    let children = insert_extracted_children(
        transaction,
        request.bucket_id(),
        request.entry_id(),
        request.extraction(),
        &timestamp,
    )?;
    let updated = transaction.execute(
        "UPDATE entries SET summary = ?3 WHERE id = ?1 AND bucket_id = ?2",
        params![
            request.entry_id,
            request.bucket_id,
            request.extraction.summary()
        ],
    )?;
    if updated != 1 {
        return Err(StoreError::MissingRecord {
            table: "entries",
            id: request.entry_id.clone(),
        });
    }
    update_bucket_cache(
        transaction,
        &bucket,
        request.extraction(),
        &timestamp,
        DEFAULT_BUCKET_SUMMARY_LIMIT,
    )?;

    Ok(SaveExtractionOutcome {
        bucket_id: request.bucket_id.clone(),
        entry_id: request.entry_id.clone(),
        todo_ids: children.todo_ids,
        evidence_ids: children.evidence_ids,
        timeline_event_ids: children.timeline_event_ids,
        decision_ids: children.decision_ids,
    })
}
