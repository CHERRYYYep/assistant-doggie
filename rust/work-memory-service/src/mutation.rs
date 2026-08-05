use std::path::Path;

use work_memory_core::BucketType;
use work_memory_store::{
    AppendEntryRequest, CreateBucketRequest, DeleteBucketOutcome, DeleteBucketRequest,
    DeleteEntryOutcome, DeleteEntryRequest, StoredBucket, StoredEntry, WritableSqliteStore,
};

use crate::ServiceError;

/// Product-level standalone Bucket and Entry mutations.
///
/// This service exposes the Python-compatible CRUD boundary without leaking the
/// writable SQLite store or its request types. Archive and correction remain
/// separate orchestrators because they own larger aggregate transactions.
pub struct MemoryMutationService {
    store: WritableSqliteStore,
}

impl MemoryMutationService {
    /// Open an existing Python-compatible database for isolated Rust writes.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, ServiceError> {
        Ok(Self {
            store: WritableSqliteStore::open_existing(path)?,
        })
    }

    /// Build the service around an already validated writable store.
    pub const fn new(store: WritableSqliteStore) -> Self {
        Self { store }
    }

    /// Create one active Bucket without adding Entries or audit rows.
    pub fn create_bucket(
        &mut self,
        title: impl Into<String>,
        bucket_type: BucketType,
        summary: impl Into<String>,
        tags: Vec<String>,
    ) -> Result<StoredBucket, ServiceError> {
        let request = CreateBucketRequest::new(title, bucket_type, summary, tags)?;
        Ok(self.store.create_bucket(&request)?)
    }

    /// Append one standalone Entry and refresh its Bucket activity timestamps.
    #[allow(clippy::too_many_arguments)]
    pub fn append_entry(
        &mut self,
        bucket_id: impl Into<String>,
        raw_text: impl Into<String>,
        summary: Option<String>,
        content_type: impl Into<String>,
        classification_confidence: Option<f64>,
        classification_reason: Option<String>,
    ) -> Result<StoredEntry, ServiceError> {
        let request = AppendEntryRequest::new(
            bucket_id,
            raw_text,
            summary,
            content_type,
            classification_confidence,
            classification_reason,
        )?;
        Ok(self.store.append_entry(&request)?)
    }

    /// Delete one exact Entry while retaining linked child and audit rows.
    pub fn delete_entry(
        &mut self,
        entry_id: impl Into<String>,
    ) -> Result<DeleteEntryOutcome, ServiceError> {
        let request = DeleteEntryRequest::new(entry_id);
        Ok(self.store.delete_entry(&request)?)
    }

    /// Delete one exact Bucket and its database-owned aggregate.
    pub fn delete_bucket(
        &mut self,
        bucket_id: impl Into<String>,
    ) -> Result<DeleteBucketOutcome, ServiceError> {
        let request = DeleteBucketRequest::new(bucket_id);
        Ok(self.store.delete_bucket(&request)?)
    }
}
