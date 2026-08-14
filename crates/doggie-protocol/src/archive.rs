use doggie_domain::ArchiveResult;
use serde::Deserialize;
use serde_json::Value;

use crate::ContractError;
use crate::extraction::{ExtractionContract, extraction_to_value};
use crate::values::{archive_status, classification_action, optional_bucket_type};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveInput {
    status: String,
    action: String,
    #[serde(default)]
    bucket_id: Option<String>,
    #[serde(default)]
    bucket_title: Option<String>,
    #[serde(default)]
    bucket_type: Option<String>,
    #[serde(default)]
    entry_id: Option<String>,
    confidence: f64,
    reason: String,
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    candidate_bucket_ids: Vec<String>,
    #[serde(default)]
    extraction: Option<Value>,
}

/// Strict JSON adapter around the user-facing archive result.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchiveContract {
    inner: ArchiveResult,
}

impl ArchiveContract {
    pub fn from_json(json: &str) -> Result<Self, ContractError> {
        Self::from_value(serde_json::from_str(json)?)
    }

    pub fn from_value(value: Value) -> Result<Self, ContractError> {
        let input: ArchiveInput = serde_json::from_value(value)?;
        let extraction = input
            .extraction
            .map(ExtractionContract::from_value)
            .transpose()?
            .map(ExtractionContract::into_inner);
        let inner = ArchiveResult::new(
            archive_status(&input.status)?,
            classification_action(&input.action)?,
            input.bucket_id,
            input.bucket_title,
            optional_bucket_type(input.bucket_type)?,
            input.entry_id,
            input.confidence,
            input.reason,
            input.question,
            input.candidate_bucket_ids,
            extraction,
        )?;
        Ok(Self { inner })
    }

    pub fn to_value(&self) -> Result<Value, ContractError> {
        let extraction = self
            .inner
            .extraction()
            .map(extraction_to_value)
            .transpose()?;
        Ok(serde_json::json!({
            "status": self.inner.status().as_str(),
            "action": self.inner.action().as_str(),
            "bucket_id": self.inner.bucket_id(),
            "bucket_title": self.inner.bucket_title(),
            "bucket_type": self.inner.bucket_type().map(|value| value.as_str()),
            "entry_id": self.inner.entry_id(),
            "confidence": self.inner.confidence(),
            "reason": self.inner.reason(),
            "question": self.inner.question(),
            "candidate_bucket_ids": self.inner.candidate_bucket_ids(),
            "extraction": extraction,
        }))
    }

    pub fn to_json(&self) -> Result<String, ContractError> {
        Ok(serde_json::to_string(&self.to_value()?)?)
    }

    pub fn inner(&self) -> &ArchiveResult {
        &self.inner
    }

    pub fn into_inner(self) -> ArchiveResult {
        self.inner
    }
}
