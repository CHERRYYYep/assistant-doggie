use std::path::Path;

use doggie_domain::ExtractionResult;
use doggie_storage_sqlite::{SaveExtractionOutcome, SaveExtractionRequest, WritableSqliteStore};

use crate::ServiceError;

/// Stable service projection for one committed standalone extraction save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractionSaveResult {
    bucket_id: String,
    entry_id: String,
    todo_ids: Vec<String>,
    evidence_ids: Vec<String>,
    timeline_event_ids: Vec<String>,
    decision_ids: Vec<String>,
}

impl ExtractionSaveResult {
    fn from_store(outcome: &SaveExtractionOutcome) -> Self {
        Self {
            bucket_id: outcome.bucket_id().to_owned(),
            entry_id: outcome.entry_id().to_owned(),
            todo_ids: outcome.todo_ids().to_vec(),
            evidence_ids: outcome.evidence_ids().to_vec(),
            timeline_event_ids: outcome.timeline_event_ids().to_vec(),
            decision_ids: outcome.decision_ids().to_vec(),
        }
    }

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

/// Product-level persistence for one already validated extraction result.
///
/// Model invocation and JSON validation remain outside this service. It owns a
/// validated writable Store and exposes only exact IDs, the core extraction,
/// and a stable result projection.
pub struct ExtractionPersistenceService {
    store: WritableSqliteStore,
}

impl ExtractionPersistenceService {
    /// Open an existing legacy-compatible database for isolated Doggie writes.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, ServiceError> {
        Ok(Self {
            store: WritableSqliteStore::open_existing(path)?,
        })
    }

    /// Build the service around an already validated writable store.
    pub const fn new(store: WritableSqliteStore) -> Self {
        Self { store }
    }

    /// Persist extracted facts, Entry summary, and Bucket cache updates atomically.
    pub fn save_extraction(
        &mut self,
        bucket_id: impl Into<String>,
        entry_id: impl Into<String>,
        extraction: ExtractionResult,
    ) -> Result<ExtractionSaveResult, ServiceError> {
        let request = SaveExtractionRequest::new(bucket_id, entry_id, extraction);
        let outcome = self.store.save_extraction(&request)?;
        Ok(ExtractionSaveResult::from_store(&outcome))
    }
}
