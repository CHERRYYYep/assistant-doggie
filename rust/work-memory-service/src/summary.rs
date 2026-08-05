use std::path::Path;

use work_memory_store::{
    RebuildBucketSummaryRequest, UpdateBucketSummaryRequest, WritableSqliteStore,
};

use crate::ServiceError;

/// Product-level standalone maintenance for the derived Bucket summary cache.
///
/// The service owns a validated writable store and exposes Python-compatible
/// summary operations without leaking Store request objects or transactions.
pub struct BucketSummaryService {
    store: WritableSqliteStore,
}

impl BucketSummaryService {
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

    /// Merge one Entry summary using Python's default 1,200-character bound.
    pub fn update_bucket_summary(
        &mut self,
        bucket_id: impl Into<String>,
        entry_summary: impl Into<String>,
    ) -> Result<String, ServiceError> {
        let request = UpdateBucketSummaryRequest::new(bucket_id, entry_summary)?;
        Ok(self.store.update_bucket_summary(&request)?)
    }

    /// Merge one Entry summary using an explicit Python-compatible bound.
    pub fn update_bucket_summary_with_max_chars(
        &mut self,
        bucket_id: impl Into<String>,
        entry_summary: impl Into<String>,
        max_chars: usize,
    ) -> Result<String, ServiceError> {
        let request =
            UpdateBucketSummaryRequest::with_max_chars(bucket_id, entry_summary, max_chars)?;
        Ok(self.store.update_bucket_summary(&request)?)
    }

    /// Rebuild a Bucket summary using Python's defaults of eight Entries and 1,200 characters.
    pub fn rebuild_bucket_summary(
        &mut self,
        bucket_id: impl Into<String>,
    ) -> Result<String, ServiceError> {
        let request = RebuildBucketSummaryRequest::new(bucket_id)?;
        Ok(self.store.rebuild_bucket_summary(&request)?)
    }

    /// Rebuild a Bucket summary using explicit Python-compatible limits.
    pub fn rebuild_bucket_summary_with_limits(
        &mut self,
        bucket_id: impl Into<String>,
        max_entries: i64,
        max_chars: i64,
    ) -> Result<String, ServiceError> {
        let request = RebuildBucketSummaryRequest::with_limits(bucket_id, max_entries, max_chars)?;
        Ok(self.store.rebuild_bucket_summary(&request)?)
    }
}
