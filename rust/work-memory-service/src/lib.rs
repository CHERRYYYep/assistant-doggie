//! Business-level read orchestration over the strongly typed SQLite store.

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::Path;

use work_memory_store::{
    SqliteStore, StoreError, StoredBucket, StoredDecision, StoredEntry, StoredEvidence,
    StoredTimelineEvent, StoredTodo,
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

/// Failures at the Rust service orchestration boundary.
#[derive(Debug)]
pub enum ServiceError {
    Store(StoreError),
}

impl ServiceError {
    pub const fn store_error(&self) -> &StoreError {
        match self {
            Self::Store(error) => error,
        }
    }
}

impl Display for ServiceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => write!(formatter, "store error: {error}"),
        }
    }
}

impl Error for ServiceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
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
