use doggie_domain::{BucketView, ClassificationResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ContractError;
use crate::timestamp::parse_timestamp;
use crate::values::{bucket_status, bucket_type, classification_action, optional_bucket_type};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClassificationInput {
    action: String,
    #[serde(default)]
    bucket_id: Option<String>,
    #[serde(default)]
    bucket_type: Option<String>,
    #[serde(default)]
    title: Option<String>,
    confidence: f64,
    reason: String,
    #[serde(default)]
    should_ask_user: bool,
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    candidate_bucket_ids: Option<Vec<String>>,
}

#[derive(Serialize)]
struct ClassificationOutput<'a> {
    action: &'static str,
    bucket_id: Option<&'a str>,
    bucket_type: Option<&'static str>,
    title: Option<&'a str>,
    confidence: f64,
    reason: &'a str,
    should_ask_user: bool,
    question: Option<&'a str>,
    candidate_bucket_ids: &'a [String],
}

/// Strict JSON adapter around the validated classification domain result.
#[derive(Debug, Clone, PartialEq)]
pub struct ClassificationContract {
    inner: ClassificationResult,
}

impl ClassificationContract {
    pub fn from_json(json: &str) -> Result<Self, ContractError> {
        Self::from_value(serde_json::from_str(json)?)
    }

    pub fn from_value(value: Value) -> Result<Self, ContractError> {
        let input: ClassificationInput = serde_json::from_value(value)?;
        let inner = ClassificationResult::try_new(
            classification_action(&input.action)?,
            input.bucket_id,
            optional_bucket_type(input.bucket_type)?,
            input.title,
            input.confidence,
            input.reason,
            input.should_ask_user,
            input.question,
            input.candidate_bucket_ids.unwrap_or_default(),
        )?;
        Ok(Self { inner })
    }

    pub fn to_value(&self) -> Result<Value, ContractError> {
        Ok(serde_json::to_value(ClassificationOutput {
            action: self.inner.action().as_str(),
            bucket_id: self.inner.bucket_id(),
            bucket_type: self.inner.bucket_type().map(|value| value.as_str()),
            title: self.inner.title(),
            confidence: self.inner.confidence(),
            reason: self.inner.reason(),
            should_ask_user: self.inner.should_ask_user(),
            question: self.inner.question(),
            candidate_bucket_ids: self.inner.candidate_bucket_ids(),
        })?)
    }

    pub fn to_json(&self) -> Result<String, ContractError> {
        Ok(serde_json::to_string(&self.to_value()?)?)
    }

    pub fn inner(&self) -> &ClassificationResult {
        &self.inner
    }

    pub fn into_inner(self) -> ClassificationResult {
        self.inner
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BucketViewInput {
    id: String,
    title: String,
    #[serde(rename = "type")]
    bucket_type: String,
    status: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
    last_active_at: String,
}

#[derive(Serialize)]
struct BucketViewOutput<'a> {
    id: &'a str,
    title: &'a str,
    #[serde(rename = "type")]
    bucket_type: &'static str,
    status: &'static str,
    summary: &'a str,
    tags: &'a [String],
    last_active_at: &'a str,
}

/// Strict JSON adapter for the bounded Bucket context sent to classification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BucketViewContract {
    inner: BucketView,
    last_active_at: String,
}

impl BucketViewContract {
    pub fn from_json(json: &str) -> Result<Self, ContractError> {
        Self::from_value(serde_json::from_str(json)?)
    }

    pub fn from_value(value: Value) -> Result<Self, ContractError> {
        let input: BucketViewInput = serde_json::from_value(value)?;
        let (last_active_at, last_active_at_unix_ms) = parse_timestamp(input.last_active_at)?;
        let inner = BucketView::new(
            input.id,
            input.title,
            bucket_type(&input.bucket_type)?,
            bucket_status(&input.status)?,
            input.summary,
            input.tags.unwrap_or_default(),
            last_active_at_unix_ms,
        )?;
        Ok(Self {
            inner,
            last_active_at,
        })
    }

    pub fn to_value(&self) -> Result<Value, ContractError> {
        Ok(serde_json::to_value(BucketViewOutput {
            id: self.inner.id(),
            title: self.inner.title(),
            bucket_type: self.inner.bucket_type().as_str(),
            status: self.inner.status().as_str(),
            summary: self.inner.summary(),
            tags: self.inner.tags(),
            last_active_at: &self.last_active_at,
        })?)
    }

    pub fn inner(&self) -> &BucketView {
        &self.inner
    }

    pub fn into_inner(self) -> BucketView {
        self.inner
    }
}
