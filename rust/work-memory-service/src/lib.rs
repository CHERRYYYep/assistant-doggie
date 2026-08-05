//! Business-level orchestration over the strongly typed SQLite store.

mod archive;
mod chat;
mod classification;
mod correction;
mod extraction;
mod mutation;
mod summary;

use std::path::Path;

use thiserror::Error;
use work_memory_core::{BucketStatus, BucketType, CoreError, unicode_case_fold};
use work_memory_store::{
    SqliteStore, StoreError, StoredBucket, StoredDecision, StoredEntry, StoredEvidence,
    StoredTimelineEvent, StoredTimestamp, StoredTodo,
};

pub use archive::{ArchiveService, CLASSIFICATION_PROMPT_VERSION};
pub use chat::{ChatMessagePersistenceService, ChatMessageSaveResult};
pub use classification::{ClassificationAuditSaveResult, ClassificationAuditService};
pub use correction::{CorrectionResult, CorrectionService, ENTRY_TARGET_TYPE, MOVE_ENTRY_ACTION};
pub use extraction::{ExtractionPersistenceService, ExtractionSaveResult};
pub use mutation::MemoryMutationService;
pub use summary::BucketSummaryService;

/// A Bucket and all product-visible child records loaded by the Python detail service.
#[derive(Debug, Clone, PartialEq)]
pub struct BucketDetail {
    pub bucket: StoredBucket,
    pub entries: Vec<StoredEntry>,
    pub todos: Vec<StoredTodo>,
    pub evidences: Vec<StoredEvidence>,
    pub timeline_events: Vec<StoredTimelineEvent>,
    pub decisions: Vec<StoredDecision>,
}

/// Compact product search projection for one matching Bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BucketSearchResult {
    pub bucket_id: String,
    pub title: String,
    pub bucket_type: BucketType,
    pub status: BucketStatus,
    pub summary: String,
    pub tags: Vec<String>,
    pub last_active_at: StoredTimestamp,
    pub matched_entry_count: usize,
    pub score: usize,
}

/// Failures at the Rust service orchestration boundary.
#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("text must not be empty")]
    EmptyArchiveText,
    #[error("correction command must not be empty")]
    EmptyCorrectionCommand,
    #[error("search query must not be empty")]
    EmptySearchQuery,
    #[error("correction command does not identify a target Bucket; supply an explicit ID")]
    UnrecognizedCorrectionTarget,
    #[error("classification action {action} requires an extraction")]
    MissingExtraction { action: &'static str },
    #[error("ask_user classification must not include an extraction")]
    UnexpectedExtraction,
    #[error("domain error: {0}")]
    Core(#[from] CoreError),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
}

impl ServiceError {
    pub const fn store_error(&self) -> Option<&StoreError> {
        match self {
            Self::EmptyArchiveText
            | Self::EmptyCorrectionCommand
            | Self::EmptySearchQuery
            | Self::UnrecognizedCorrectionTarget
            | Self::MissingExtraction { .. }
            | Self::UnexpectedExtraction
            | Self::Core(_) => None,
            Self::Store(error) => Some(error),
        }
    }

    pub const fn core_error(&self) -> Option<&CoreError> {
        match self {
            Self::Core(error) => Some(error),
            Self::EmptyArchiveText
            | Self::EmptyCorrectionCommand
            | Self::EmptySearchQuery
            | Self::UnrecognizedCorrectionTarget
            | Self::MissingExtraction { .. }
            | Self::UnexpectedExtraction
            | Self::Store(_) => None,
        }
    }
}

/// Product-level Bucket read service backed by a validated read-only SQLite store.
pub struct BucketQueryService {
    store: SqliteStore,
}

impl BucketQueryService {
    /// Open the existing Python-compatible database with read-only protection.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, ServiceError> {
        Ok(Self {
            store: SqliteStore::open_read_only(path)?,
        })
    }

    /// Build the service around an already validated read-only store.
    pub const fn new(store: SqliteStore) -> Self {
        Self { store }
    }

    /// Return active Buckets using the Python service's ordering and limit rules.
    pub fn list_active_buckets(&self, limit: usize) -> Result<Vec<StoredBucket>, ServiceError> {
        Ok(self.store.list_active_buckets(limit)?)
    }

    /// Return one Bucket by its exact primary key.
    pub fn get_bucket(&self, bucket_id: &str) -> Result<Option<StoredBucket>, ServiceError> {
        Ok(self.store.get_bucket(bucket_id)?)
    }

    /// Search Bucket title, summary, serialized tags, and Entry raw text.
    ///
    /// This preserves the Python service's trim/validation rules, bounded SQL
    /// candidate window, Unicode case-folded scoring, stable relevance order,
    /// matched Entry count, and final result limit.
    pub fn search_buckets(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<BucketSearchResult>, ServiceError> {
        let cleaned = query.trim();
        if cleaned.is_empty() {
            return Err(ServiceError::EmptySearchQuery);
        }
        if limit < 1 {
            return Err(StoreError::InvalidLimit(limit).into());
        }

        let candidate_limit = limit
            .checked_mul(5)
            .ok_or(StoreError::InvalidLimit(limit))?
            .max(50);
        let folded_query = unicode_case_fold(cleaned);
        let candidates = self
            .store
            .search_bucket_candidates(cleaned, candidate_limit)?;
        let mut results = Vec::with_capacity(candidates.len());

        for bucket in candidates {
            let matching_entry_count = self
                .store
                .list_bucket_entries(&bucket.id)?
                .iter()
                .filter(|entry| contains_folded(&entry.raw_text, &folded_query))
                .count();

            let mut score = 0;
            let folded_title = unicode_case_fold(&bucket.title);
            if folded_title == folded_query {
                score += 100;
            } else if folded_title.contains(&folded_query) {
                score += 50;
            }
            if bucket
                .tags
                .iter()
                .any(|tag| contains_folded(tag, &folded_query))
            {
                score += 30;
            }
            if contains_folded(&bucket.summary, &folded_query) {
                score += 20;
            }
            score += matching_entry_count.min(10) * 5;

            results.push(BucketSearchResult {
                bucket_id: bucket.id,
                title: bucket.title,
                bucket_type: bucket.bucket_type,
                status: bucket.status,
                summary: bucket.summary,
                tags: bucket.tags,
                last_active_at: bucket.last_active_at,
                matched_entry_count: matching_entry_count,
                score,
            });
        }

        results.sort_by(|left, right| {
            right.score.cmp(&left.score).then_with(|| {
                right
                    .last_active_at
                    .utc_naive()
                    .cmp(left.last_active_at.utc_naive())
            })
        });
        results.truncate(limit);
        Ok(results)
    }

    /// Load one Bucket and every product-visible child collection.
    ///
    /// Child records retain the relationship ordering used by Python. A missing
    /// Bucket returns `None` without synthesizing an empty aggregate.
    pub fn get_bucket_detail(&self, bucket_id: &str) -> Result<Option<BucketDetail>, ServiceError> {
        let Some(bucket) = self.store.get_bucket(bucket_id)? else {
            return Ok(None);
        };

        Ok(Some(BucketDetail {
            entries: self.store.list_bucket_entries(bucket_id)?,
            todos: self.store.list_bucket_todos(bucket_id)?,
            evidences: self.store.list_bucket_evidences(bucket_id)?,
            timeline_events: self.store.list_bucket_timeline_events(bucket_id)?,
            decisions: self.store.list_bucket_decisions(bucket_id)?,
            bucket,
        }))
    }
}

fn contains_folded(value: &str, folded_query: &str) -> bool {
    unicode_case_fold(value).contains(folded_query)
}
