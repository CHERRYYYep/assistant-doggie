//! Canonical Doggie-owned service facade.
//!
//! This module intentionally sits beside the legacy-schema services. It
//! owns a [`DoggieStore`] and exposes the product read/write operations needed by
//! the canonical runtime without changing the legacy service boundaries.

use std::path::Path;

use crate::query::{MemoryQuery, MemoryQueryError, MemorySearchResponse, search_memory};
use doggie_domain::{
    BucketView, ClassificationAction, ClassificationResult, ConfidencePolicy, CoreError,
    ExtractionResult, build_bucket_candidates, postprocess_classification,
};
use doggie_storage_sqlite::{
    ChatRole, DoggieArchiveAttempt, DoggieArchiveAudit, DoggieArchiveOutcome, DoggieBucket,
    DoggieBucketDetail, DoggieChatMessage, DoggieCorrection, DoggieDeleteBucketOutcome,
    DoggieEntry, DoggieSearchHit, DoggieStore, DoggieStoreCounts, StoreError,
};
use serde_json::Value;
use thiserror::Error;

/// Errors at the canonical Doggie-owned service boundary.
#[derive(Debug, Error)]
pub enum CanonicalServiceError {
    #[error("automatic archive action {action} requires extraction")]
    MissingExtraction { action: &'static str },
    #[error("ask_user archive must not include extraction")]
    UnexpectedExtraction,
    #[error("memory query error: {0}")]
    Query(#[from] MemoryQueryError),
    #[error("domain error: {0}")]
    Core(#[from] CoreError),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
}

impl CanonicalServiceError {
    /// Return the wrapped store failure, when this is a persistence error.
    pub const fn store_error(&self) -> Option<&StoreError> {
        match self {
            Self::Store(error) => Some(error),
            Self::MissingExtraction { .. }
            | Self::UnexpectedExtraction
            | Self::Query(_)
            | Self::Core(_) => None,
        }
    }

    /// Return the wrapped domain failure, when this is a core-domain error.
    pub const fn core_error(&self) -> Option<&CoreError> {
        match self {
            Self::Core(error) => Some(error),
            Self::MissingExtraction { .. }
            | Self::UnexpectedExtraction
            | Self::Query(_)
            | Self::Store(_) => None,
        }
    }
}

/// Read projections for the canonical runtime's active workspace and history.
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalHistoryProjection {
    pub archive_attempts: Vec<DoggieArchiveAttempt>,
    pub chat_messages: Vec<DoggieChatMessage>,
    pub corrections: Vec<DoggieCorrection>,
}

/// Service facade over the Doggie-owned canonical SQLite schema.
#[derive(Debug)]
pub struct CanonicalService {
    store: DoggieStore,
}

impl CanonicalService {
    /// Initialize a new canonical database, or validate an existing canonical
    /// database at `path`.
    pub fn initialize(path: impl AsRef<Path>) -> Result<Self, CanonicalServiceError> {
        Ok(Self {
            store: DoggieStore::initialize(path)?,
        })
    }

    /// Open an existing canonical database without creating or migrating it.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, CanonicalServiceError> {
        Ok(Self {
            store: DoggieStore::open_existing(path)?,
        })
    }

    /// Build a facade around an already validated canonical store.
    pub const fn new(store: DoggieStore) -> Self {
        Self { store }
    }

    /// List active Buckets using the canonical store's stable recency order.
    pub fn list_active_buckets(
        &self,
        limit: usize,
    ) -> Result<Vec<DoggieBucket>, CanonicalServiceError> {
        Ok(self.store.list_active_buckets(limit)?)
    }

    /// Load one canonical Bucket without its Entry/memory detail projection.
    pub fn get_bucket(
        &self,
        bucket_id: &str,
    ) -> Result<Option<DoggieBucket>, CanonicalServiceError> {
        Ok(self.store.get_bucket(bucket_id)?)
    }

    /// Build bounded classifier context from automatic recent and popular
    /// active Buckets. The optional focus ID is retained for compatibility and
    /// audit callers, but it does not manually promote a UI-selected Bucket.
    pub fn active_bucket_views(
        &self,
        limit: usize,
        _current_focus_bucket_id: Option<&str>,
    ) -> Result<Vec<BucketView>, CanonicalServiceError> {
        let candidate_limit = limit.max(1);
        let recent = self.store.list_active_buckets(candidate_limit)?;
        let popular = self.store.list_popular_active_buckets(candidate_limit)?;
        let mut buckets = Vec::with_capacity(recent.len() + popular.len());
        for index in 0..recent.len().max(popular.len()) {
            if let Some(bucket) = recent.get(index) {
                buckets.push(bucket.clone());
            }
            if let Some(bucket) = popular.get(index) {
                buckets.push(bucket.clone());
            }
        }
        let buckets = buckets
            .into_iter()
            .map(bucket_to_view)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(build_bucket_candidates(buckets, None, limit)?)
    }

    /// Apply the deterministic core gates to a classifier result using the
    /// canonical active-Bucket projection.
    pub fn postprocess_classification(
        &self,
        raw_text: &str,
        classification: ClassificationResult,
        limit: usize,
        current_focus_bucket_id: Option<&str>,
        policy: ConfidencePolicy,
    ) -> Result<ClassificationResult, CanonicalServiceError> {
        let candidates = self.active_bucket_views(limit, current_focus_bucket_id)?;
        self.postprocess_classification_with_candidates(
            raw_text,
            classification,
            &candidates,
            policy,
        )
    }

    /// Apply the deterministic classifier gates to a caller-provided candidate
    /// projection. This keeps model orchestration outside the service while
    /// ensuring the canonical service remains the policy boundary for writes.
    pub fn postprocess_classification_with_candidates(
        &self,
        raw_text: &str,
        classification: ClassificationResult,
        candidates: &[BucketView],
        policy: ConfidencePolicy,
    ) -> Result<ClassificationResult, CanonicalServiceError> {
        Ok(postprocess_classification(
            raw_text,
            classification,
            candidates,
            policy,
        )?)
    }

    /// Search canonical Bucket and Entry text, returning store-owned ranking
    /// and detail projections.
    pub fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<DoggieSearchHit>, CanonicalServiceError> {
        Ok(self.store.search(query, limit)?)
    }

    /// Parse and execute a natural-language query at Entry granularity.
    ///
    /// This is intentionally separate from [`Self::search`] so the old Bucket
    /// search contract remains stable for existing clients.
    pub fn query_memory(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<MemorySearchResponse, CanonicalServiceError> {
        let plan = MemoryQuery::parse(query, limit)?;
        Ok(search_memory(&self.store, &plan)?)
    }

    /// Execute a caller-supplied query plan. HTTP clients and Agent tools can
    /// add structured filters after deterministic natural-language parsing.
    pub fn query_memory_with_plan(
        &self,
        plan: MemoryQuery,
    ) -> Result<MemorySearchResponse, CanonicalServiceError> {
        Ok(search_memory(&self.store, &plan)?)
    }

    /// Load one Bucket with all immutable Entries and structured memory items.
    pub fn bucket_detail(
        &self,
        bucket_id: &str,
    ) -> Result<Option<DoggieBucketDetail>, CanonicalServiceError> {
        Ok(self.store.bucket_detail(bucket_id)?)
    }

    /// Persist an automatic archive or an `ask_user` attempt atomically.
    ///
    /// `append_existing` and `create_new` require an extraction result. An
    /// `ask_user` attempt deliberately writes no Entry and therefore must not
    /// receive extraction data.
    pub fn archive(
        &mut self,
        raw_text: impl Into<String>,
        classification: ClassificationResult,
        extraction: Option<ExtractionResult>,
        audit: DoggieArchiveAudit,
    ) -> Result<DoggieArchiveOutcome, CanonicalServiceError> {
        match (classification.action(), extraction.is_some()) {
            (ClassificationAction::AskUser, true) => {
                return Err(CanonicalServiceError::UnexpectedExtraction);
            }
            (ClassificationAction::AppendExisting | ClassificationAction::CreateNew, false) => {
                return Err(CanonicalServiceError::MissingExtraction {
                    action: classification.action().as_str(),
                });
            }
            _ => {}
        }
        Ok(self
            .store
            .archive(raw_text, classification, extraction, audit)?)
    }

    /// Append one persistent user, assistant, or tool message.
    pub fn append_chat_message(
        &mut self,
        role: ChatRole,
        content: impl Into<String>,
        tool_name: Option<String>,
        tool_call_id: Option<String>,
        details: Option<Value>,
    ) -> Result<DoggieChatMessage, CanonicalServiceError> {
        Ok(self
            .store
            .append_chat_message(role, content, tool_name, tool_call_id, details)?)
    }

    /// Move an Entry and its structured memories to another Bucket while
    /// recording the canonical correction audit.
    pub fn move_entry(
        &mut self,
        entry_id: &str,
        target_bucket_id: &str,
        command_text: impl Into<String>,
    ) -> Result<DoggieEntry, CanonicalServiceError> {
        Ok(self
            .store
            .move_entry(entry_id, target_bucket_id, command_text)?)
    }

    /// Hard-delete a canonical Bucket and return the deletion audit outcome.
    pub fn delete_bucket(
        &mut self,
        bucket_id: &str,
        command_text: impl Into<String>,
    ) -> Result<DoggieDeleteBucketOutcome, CanonicalServiceError> {
        Ok(self.store.delete_bucket(bucket_id, command_text)?)
    }

    /// Set a canonical Bucket lifecycle status and return the updated Bucket.
    pub fn set_bucket_status(
        &mut self,
        bucket_id: &str,
        status: doggie_domain::BucketStatus,
    ) -> Result<DoggieBucket, CanonicalServiceError> {
        Ok(self.store.set_bucket_status(bucket_id, status)?)
    }

    /// Return row counts for canonical operational inspection.
    pub fn counts(&self) -> Result<DoggieStoreCounts, CanonicalServiceError> {
        Ok(self.store.counts()?)
    }

    /// Return recent archive attempts, chat messages, and correction records.
    pub fn history(
        &self,
        limit: usize,
    ) -> Result<CanonicalHistoryProjection, CanonicalServiceError> {
        Ok(CanonicalHistoryProjection {
            archive_attempts: self.store.list_archive_attempts(limit)?,
            chat_messages: self.store.list_chat_messages(limit)?,
            corrections: self.store.list_corrections(None, None, limit)?,
        })
    }

    /// Return recent canonical archive attempts.
    pub fn list_archive_attempts(
        &self,
        limit: usize,
    ) -> Result<Vec<DoggieArchiveAttempt>, CanonicalServiceError> {
        Ok(self.store.list_archive_attempts(limit)?)
    }

    /// Load one archive attempt for confirmation binding and replay checks.
    pub fn get_archive_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<DoggieArchiveAttempt>, CanonicalServiceError> {
        Ok(self.store.get_archive_attempt(attempt_id)?)
    }

    /// Resolve a pending archive attempt as discarded without creating an Entry.
    pub fn discard_archive_attempt(
        &mut self,
        attempt_id: &str,
        raw_text: &str,
    ) -> Result<(), CanonicalServiceError> {
        self.store.discard_archive_attempt(attempt_id, raw_text)?;
        Ok(())
    }

    /// Return recent canonical chat messages in sequence order.
    pub fn list_chat_messages(
        &self,
        limit: usize,
    ) -> Result<Vec<DoggieChatMessage>, CanonicalServiceError> {
        Ok(self.store.list_chat_messages(limit)?)
    }

    /// Return recent canonical correction records, optionally filtered by
    /// target type and target ID.
    pub fn list_corrections(
        &self,
        target_type: Option<&str>,
        target_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<DoggieCorrection>, CanonicalServiceError> {
        Ok(self.store.list_corrections(target_type, target_id, limit)?)
    }
}

fn bucket_to_view(bucket: DoggieBucket) -> Result<BucketView, CoreError> {
    BucketView::new(
        bucket.id,
        bucket.title,
        bucket.bucket_type,
        bucket.status,
        bucket.summary,
        bucket.tags,
        bucket
            .last_active_at
            .utc_naive()
            .and_utc()
            .timestamp_millis(),
    )
}
