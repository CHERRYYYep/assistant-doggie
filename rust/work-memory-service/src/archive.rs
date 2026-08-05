use std::path::Path;

use work_memory_core::{
    ArchiveResult, ArchiveStatus, BucketType, ClassificationAction, ClassificationResult,
    ExtractionResult,
};
use work_memory_store::{ArchiveWriteRequest, ClassificationAuditContext, WritableSqliteStore};

use crate::ServiceError;

/// Classification Prompt version currently persisted by the Python archive service.
pub const CLASSIFICATION_PROMPT_VERSION: &str = "classification-v2";

/// Product-level archive orchestration backed by one validated writable store.
///
/// Classification and extraction are accepted as already validated domain values.
/// The future LLM adapter remains responsible for producing those values; this
/// service owns archive validation, confirmed-action construction, atomic store
/// invocation, and the user-facing result projection.
pub struct ArchiveService {
    store: WritableSqliteStore,
}

impl ArchiveService {
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

    /// Persist one already-classified archive attempt.
    ///
    /// Automatic actions require an extraction. `ask_user` persists only the
    /// classification audit and rejects an extraction so uncertain input cannot
    /// silently enter formal memory.
    pub fn archive_classified_input(
        &mut self,
        text: impl Into<String>,
        classification: ClassificationResult,
        extraction: Option<ExtractionResult>,
        audit: ClassificationAuditContext,
    ) -> Result<ArchiveResult, ServiceError> {
        let cleaned = cleaned_text(text.into())?;
        let request = match (classification.action(), extraction) {
            (ClassificationAction::AskUser, None) => {
                ArchiveWriteRequest::needs_confirmation(cleaned, classification, audit)?
            }
            (ClassificationAction::AskUser, Some(_)) => {
                return Err(ServiceError::UnexpectedExtraction);
            }
            (action, None) => {
                return Err(ServiceError::MissingExtraction {
                    action: action.as_str(),
                });
            }
            (_, Some(extraction)) => {
                ArchiveWriteRequest::archive(cleaned, classification, extraction, audit)?
            }
        };
        self.persist_attempt(request)
    }

    /// Persist an input after explicit confirmation of an existing Bucket.
    ///
    /// As in Python, the confirmed target is also the sole server candidate and
    /// current-focus Bucket in the classification audit. The extraction is
    /// supplied by the caller until the Rust LLM adapter is introduced.
    #[allow(clippy::too_many_arguments)]
    pub fn archive_confirmed_input(
        &mut self,
        text: impl Into<String>,
        target_bucket_id: impl Into<String>,
        extraction: ExtractionResult,
        confidence: f64,
        reason: impl Into<String>,
        model_name: impl Into<String>,
    ) -> Result<ArchiveResult, ServiceError> {
        let target_bucket_id = target_bucket_id.into();
        let classification = ClassificationResult::append_existing(
            target_bucket_id.clone(),
            None,
            confidence,
            reason,
            vec![],
        )?;
        let audit = ClassificationAuditContext::new(
            vec![target_bucket_id.clone()],
            Some(target_bucket_id),
            CLASSIFICATION_PROMPT_VERSION,
            model_name,
        )?;
        self.archive_classified_input(text, classification, Some(extraction), audit)
    }

    /// Create and archive into a new Bucket after explicit user confirmation.
    ///
    /// The audit has no candidate or current-focus Bucket, matching the Python
    /// confirmed-new entry point.
    #[allow(clippy::too_many_arguments)]
    pub fn archive_confirmed_new_input(
        &mut self,
        text: impl Into<String>,
        title: impl Into<String>,
        bucket_type: BucketType,
        extraction: ExtractionResult,
        confidence: f64,
        reason: impl Into<String>,
        model_name: impl Into<String>,
    ) -> Result<ArchiveResult, ServiceError> {
        let classification =
            ClassificationResult::create_new(bucket_type, title, confidence, reason, vec![])?;
        let audit = ClassificationAuditContext::new(
            vec![],
            None,
            CLASSIFICATION_PROMPT_VERSION,
            model_name,
        )?;
        self.archive_classified_input(text, classification, Some(extraction), audit)
    }

    fn persist_attempt(
        &mut self,
        request: ArchiveWriteRequest,
    ) -> Result<ArchiveResult, ServiceError> {
        let outcome = self.store.persist_archive_attempt(&request)?;
        let classification = request.classification();
        let needs_confirmation = outcome.status() == ArchiveStatus::NeedsConfirmation;
        let bucket_title = if needs_confirmation {
            classification.title().map(str::to_owned)
        } else {
            outcome.bucket_title().map(str::to_owned)
        };
        let bucket_type = if needs_confirmation {
            classification.bucket_type()
        } else {
            outcome.bucket_type()
        };

        Ok(ArchiveResult::new(
            outcome.status(),
            outcome.action(),
            outcome.bucket_id().map(str::to_owned),
            bucket_title,
            bucket_type,
            outcome.entry_id().map(str::to_owned),
            classification.confidence(),
            classification.reason(),
            needs_confirmation
                .then(|| classification.question().map(str::to_owned))
                .flatten(),
            if needs_confirmation {
                classification.candidate_bucket_ids().to_vec()
            } else {
                vec![]
            },
            request.extraction().cloned(),
        )?)
    }
}

fn cleaned_text(text: String) -> Result<String, ServiceError> {
    let cleaned = text.trim();
    if cleaned.is_empty() {
        return Err(ServiceError::EmptyArchiveText);
    }
    Ok(cleaned.to_owned())
}
