use std::path::Path;

use work_memory_core::ClassificationResult;
use work_memory_store::{
    SaveClassificationRecordOutcome, SaveClassificationRecordRequest, WritableSqliteStore,
};

use crate::ServiceError;

/// Stable service projection for one committed standalone classification audit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassificationAuditSaveResult {
    classification_record_id: String,
}

impl ClassificationAuditSaveResult {
    fn from_store(outcome: &SaveClassificationRecordOutcome) -> Self {
        Self {
            classification_record_id: outcome.classification_record_id().to_owned(),
        }
    }

    pub fn classification_record_id(&self) -> &str {
        &self.classification_record_id
    }
}

/// Product-level persistence for one already validated classification audit.
///
/// Classification, risk gating, prompt selection, and model-name resolution
/// remain outside this service. It owns a validated writable Store and exposes
/// only audit data plus a stable committed-result projection.
pub struct ClassificationAuditService {
    store: WritableSqliteStore,
}

impl ClassificationAuditService {
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

    /// Persist one classification and its server-owned audit metadata atomically.
    pub fn save_classification_record(
        &mut self,
        raw_text: impl Into<String>,
        classification: ClassificationResult,
        server_candidate_bucket_ids: Vec<String>,
        current_focus_bucket_id: Option<String>,
        prompt_version: impl Into<String>,
        model_name: impl Into<String>,
    ) -> Result<ClassificationAuditSaveResult, ServiceError> {
        let request = SaveClassificationRecordRequest::new(
            raw_text,
            classification,
            server_candidate_bucket_ids,
            current_focus_bucket_id,
            prompt_version,
            model_name,
        );
        let outcome = self.store.save_classification_record(&request)?;
        Ok(ClassificationAuditSaveResult::from_store(&outcome))
    }
}
