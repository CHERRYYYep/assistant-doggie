use work_memory_core::ClassificationResult;

use crate::archive_write::{
    current_timestamp, insert_classification_record, merge_candidate_bucket_ids, new_uuid_v4,
};
use crate::{StoreError, WritableSqliteStore};

/// One validated classification and its server-owned audit metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct SaveClassificationRecordRequest {
    raw_text: String,
    classification: ClassificationResult,
    server_candidate_bucket_ids: Vec<String>,
    current_focus_bucket_id: Option<String>,
    prompt_version: String,
    model_name: String,
}

impl SaveClassificationRecordRequest {
    /// Build a standalone classification-audit write.
    ///
    /// As in Python, only the raw input is trimmed here. Candidate IDs and
    /// resolved server metadata are otherwise preserved exactly; callers own
    /// prompt/model resolution before crossing the store boundary.
    pub fn new(
        raw_text: impl Into<String>,
        classification: ClassificationResult,
        server_candidate_bucket_ids: Vec<String>,
        current_focus_bucket_id: Option<String>,
        prompt_version: impl Into<String>,
        model_name: impl Into<String>,
    ) -> Self {
        Self {
            raw_text: raw_text.into().trim().to_owned(),
            classification,
            server_candidate_bucket_ids,
            current_focus_bucket_id,
            prompt_version: prompt_version.into(),
            model_name: model_name.into(),
        }
    }

    pub fn raw_text(&self) -> &str {
        &self.raw_text
    }

    pub const fn classification(&self) -> &ClassificationResult {
        &self.classification
    }

    pub fn server_candidate_bucket_ids(&self) -> &[String] {
        &self.server_candidate_bucket_ids
    }

    pub fn current_focus_bucket_id(&self) -> Option<&str> {
        self.current_focus_bucket_id.as_deref()
    }

    pub fn prompt_version(&self) -> &str {
        &self.prompt_version
    }

    pub fn model_name(&self) -> &str {
        &self.model_name
    }
}

/// ID produced by one committed standalone classification-audit write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveClassificationRecordOutcome {
    classification_record_id: String,
}

impl SaveClassificationRecordOutcome {
    pub fn classification_record_id(&self) -> &str {
        &self.classification_record_id
    }
}

impl WritableSqliteStore {
    /// Persist one classification audit row without changing other business data.
    pub fn save_classification_record(
        &mut self,
        request: &SaveClassificationRecordRequest,
    ) -> Result<SaveClassificationRecordOutcome, StoreError> {
        self.run_transaction(|transaction| {
            let timestamp = current_timestamp(transaction)?;
            let classification_record_id = new_uuid_v4();
            let candidate_bucket_ids = merge_candidate_bucket_ids(
                request.server_candidate_bucket_ids(),
                request.classification().candidate_bucket_ids(),
            );
            insert_classification_record(
                transaction,
                &classification_record_id,
                request.raw_text(),
                request.classification(),
                &candidate_bucket_ids,
                request.current_focus_bucket_id(),
                request.prompt_version(),
                request.model_name(),
                request.classification().bucket_id(),
                None,
                &timestamp,
            )?;
            Ok(SaveClassificationRecordOutcome {
                classification_record_id,
            })
        })
    }
}
