//! Business-level read orchestration over the strongly typed SQLite store.

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::Path;

use unicode_casefold::UnicodeCaseFold;
use work_memory_core::{BucketStatus, BucketType};
use work_memory_store::{
    SqliteStore, StoreError, StoredBucket, StoredDecision, StoredEntry, StoredEvidence,
    StoredTimelineEvent, StoredTimestamp, StoredTodo,
};

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
#[derive(Debug)]
pub enum ServiceError {
    EmptySearchQuery,
    Store(StoreError),
}

impl ServiceError {
    pub const fn store_error(&self) -> Option<&StoreError> {
        match self {
            Self::EmptySearchQuery => None,
            Self::Store(error) => Some(error),
        }
    }
}

impl Display for ServiceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptySearchQuery => formatter.write_str("search query must not be empty"),
            Self::Store(error) => write!(formatter, "store error: {error}"),
        }
    }
}

impl Error for ServiceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::EmptySearchQuery => None,
            Self::Store(error) => Some(error),
        }
    }
}

impl From<StoreError> for ServiceError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
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
        let folded_query = case_fold(cleaned);
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
            let folded_title = case_fold(&bucket.title);
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

fn case_fold(value: &str) -> String {
    value.case_fold().collect()
}

fn contains_folded(value: &str, folded_query: &str) -> bool {
    case_fold(value).contains(folded_query)
}
