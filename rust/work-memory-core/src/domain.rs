use std::collections::HashSet;
use std::fmt::{self, Display, Formatter};

use crate::CoreError;

/// Long-lived work context categories, matching the current Python contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BucketType {
    Idea,
    Task,
    Incident,
    Experiment,
    Decision,
    Meeting,
    Knowledge,
    Draft,
}

impl BucketType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idea => "idea",
            Self::Task => "task",
            Self::Incident => "incident",
            Self::Experiment => "experiment",
            Self::Decision => "decision",
            Self::Meeting => "meeting",
            Self::Knowledge => "knowledge",
            Self::Draft => "draft",
        }
    }
}

impl Display for BucketType {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Bucket lifecycle values currently persisted by the Python implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BucketStatus {
    Active,
    Paused,
    Done,
    Archived,
}

impl BucketStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Done => "done",
            Self::Archived => "archived",
        }
    }
}

impl Display for BucketStatus {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Classifier actions accepted by the archive workflow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClassificationAction {
    AppendExisting,
    CreateNew,
    AskUser,
}

impl ClassificationAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AppendExisting => "append_existing",
            Self::CreateNew => "create_new",
            Self::AskUser => "ask_user",
        }
    }
}

impl Display for ClassificationAction {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Bounded Bucket context used for classification candidate construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BucketView {
    id: String,
    title: String,
    bucket_type: BucketType,
    status: BucketStatus,
    summary: String,
    tags: Vec<String>,
    last_active_at_unix_ms: i64,
}

impl BucketView {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        bucket_type: BucketType,
        status: BucketStatus,
        summary: impl Into<String>,
        tags: Vec<String>,
        last_active_at_unix_ms: i64,
    ) -> Result<Self, CoreError> {
        Ok(Self {
            id: required_text(id.into(), "bucket id")?,
            title: required_text(title.into(), "bucket title")?,
            bucket_type,
            status,
            summary: summary.into().trim().to_owned(),
            tags: normalize_string_list(tags),
            last_active_at_unix_ms,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub const fn bucket_type(&self) -> BucketType {
        self.bucket_type
    }

    pub const fn status(&self) -> BucketStatus {
        self.status
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }

    pub fn tags(&self) -> &[String] {
        &self.tags
    }

    pub const fn last_active_at_unix_ms(&self) -> i64 {
        self.last_active_at_unix_ms
    }
}

/// A validated classification result.
///
/// Fields are private so invalid combinations cannot be created after parsing.
#[derive(Debug, Clone, PartialEq)]
pub struct ClassificationResult {
    action: ClassificationAction,
    bucket_id: Option<String>,
    bucket_type: Option<BucketType>,
    title: Option<String>,
    confidence: f64,
    reason: String,
    should_ask_user: bool,
    question: Option<String>,
    candidate_bucket_ids: Vec<String>,
}

impl ClassificationResult {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        action: ClassificationAction,
        bucket_id: Option<String>,
        bucket_type: Option<BucketType>,
        title: Option<String>,
        confidence: f64,
        reason: impl Into<String>,
        should_ask_user: bool,
        question: Option<String>,
        candidate_bucket_ids: Vec<String>,
    ) -> Result<Self, CoreError> {
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            return Err(CoreError::ConfidenceOutOfRange(confidence));
        }

        let bucket_id = normalize_optional_text(bucket_id);
        let title = normalize_optional_text(title);
        let question = normalize_optional_text(question);
        let reason = required_text(reason.into(), "reason")?;

        match action {
            ClassificationAction::AppendExisting => {
                if bucket_id.is_none() {
                    return Err(CoreError::InconsistentClassification(
                        "append_existing requires bucket_id",
                    ));
                }
                if should_ask_user || question.is_some() {
                    return Err(CoreError::InconsistentClassification(
                        "append_existing cannot request user confirmation",
                    ));
                }
            }
            ClassificationAction::CreateNew => {
                if bucket_id.is_some() {
                    return Err(CoreError::InconsistentClassification(
                        "create_new must not include bucket_id",
                    ));
                }
                if bucket_type.is_none() || title.is_none() {
                    return Err(CoreError::InconsistentClassification(
                        "create_new requires bucket_type and title",
                    ));
                }
                if should_ask_user || question.is_some() {
                    return Err(CoreError::InconsistentClassification(
                        "create_new cannot request user confirmation",
                    ));
                }
            }
            ClassificationAction::AskUser => {
                if !should_ask_user {
                    return Err(CoreError::InconsistentClassification(
                        "ask_user requires should_ask_user=true",
                    ));
                }
                if question.is_none() {
                    return Err(CoreError::InconsistentClassification(
                        "ask_user requires question",
                    ));
                }
            }
        }

        Ok(Self {
            action,
            bucket_id,
            bucket_type,
            title,
            confidence,
            reason,
            should_ask_user,
            question,
            candidate_bucket_ids: normalize_string_list(candidate_bucket_ids),
        })
    }

    pub fn append_existing(
        bucket_id: impl Into<String>,
        bucket_type: Option<BucketType>,
        confidence: f64,
        reason: impl Into<String>,
        candidate_bucket_ids: Vec<String>,
    ) -> Result<Self, CoreError> {
        Self::try_new(
            ClassificationAction::AppendExisting,
            Some(bucket_id.into()),
            bucket_type,
            None,
            confidence,
            reason,
            false,
            None,
            candidate_bucket_ids,
        )
    }

    pub fn create_new(
        bucket_type: BucketType,
        title: impl Into<String>,
        confidence: f64,
        reason: impl Into<String>,
        candidate_bucket_ids: Vec<String>,
    ) -> Result<Self, CoreError> {
        Self::try_new(
            ClassificationAction::CreateNew,
            None,
            Some(bucket_type),
            Some(title.into()),
            confidence,
            reason,
            false,
            None,
            candidate_bucket_ids,
        )
    }

    pub fn ask_user(
        bucket_type: Option<BucketType>,
        title: Option<String>,
        confidence: f64,
        reason: impl Into<String>,
        question: impl Into<String>,
        candidate_bucket_ids: Vec<String>,
    ) -> Result<Self, CoreError> {
        Self::try_new(
            ClassificationAction::AskUser,
            None,
            bucket_type,
            title,
            confidence,
            reason,
            true,
            Some(question.into()),
            candidate_bucket_ids,
        )
    }

    pub(crate) fn into_confirmation(
        self,
        question: impl Into<String>,
        candidate_bucket_ids: Vec<String>,
        reason_suffix: &str,
    ) -> Result<Self, CoreError> {
        let reason = format!("{} {}", self.reason, reason_suffix)
            .trim()
            .to_owned();
        Self::ask_user(
            self.bucket_type,
            self.title,
            self.confidence,
            reason,
            question,
            candidate_bucket_ids,
        )
    }

    pub const fn action(&self) -> ClassificationAction {
        self.action
    }

    pub fn bucket_id(&self) -> Option<&str> {
        self.bucket_id.as_deref()
    }

    pub const fn bucket_type(&self) -> Option<BucketType> {
        self.bucket_type
    }

    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    pub const fn confidence(&self) -> f64 {
        self.confidence
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub const fn should_ask_user(&self) -> bool {
        self.should_ask_user
    }

    pub fn question(&self) -> Option<&str> {
        self.question.as_deref()
    }

    pub fn candidate_bucket_ids(&self) -> &[String] {
        &self.candidate_bucket_ids
    }
}

fn required_text(value: String, field: &'static str) -> Result<String, CoreError> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        Err(CoreError::EmptyText(field))
    } else {
        Ok(cleaned.to_owned())
    }
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let cleaned = item.trim();
        (!cleaned.is_empty()).then(|| cleaned.to_owned())
    })
}

pub(crate) fn normalize_string_list(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for value in values {
        let cleaned = value.trim();
        if !cleaned.is_empty() && seen.insert(cleaned.to_owned()) {
            normalized.push(cleaned.to_owned());
        }
    }

    normalized
}
