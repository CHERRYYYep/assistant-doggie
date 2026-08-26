use std::fmt::{self, Display, Formatter};

use crate::domain::{normalize_optional_text, normalize_string_list, required_text};
use crate::{BucketType, ClassificationAction, CoreError};

/// User-facing state of one archive attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArchiveStatus {
    Archived,
    NeedsConfirmation,
}

impl ArchiveStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Archived => "archived",
            Self::NeedsConfirmation => "needs_confirmation",
        }
    }
}

impl Display for ArchiveStatus {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One time expression and event extracted from the raw input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineEventExtract {
    event_time: Option<String>,
    text: String,
}

impl TimelineEventExtract {
    pub fn new(event_time: Option<String>, text: impl Into<String>) -> Result<Self, CoreError> {
        Ok(Self {
            event_time: normalize_optional_text(event_time),
            text: required_text(text.into(), "timeline event text")?,
        })
    }

    pub fn event_time(&self) -> Option<&str> {
        self.event_time.as_deref()
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

/// Structured Doggie memory facts extracted from one raw entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractionResult {
    summary: String,
    todos: Vec<String>,
    evidences: Vec<String>,
    timeline_events: Vec<TimelineEventExtract>,
    decisions: Vec<String>,
    hypotheses: Vec<String>,
    entities: Vec<String>,
    tags: Vec<String>,
}

impl ExtractionResult {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        summary: impl Into<String>,
        todos: Vec<String>,
        evidences: Vec<String>,
        timeline_events: Vec<TimelineEventExtract>,
        decisions: Vec<String>,
        hypotheses: Vec<String>,
        entities: Vec<String>,
        tags: Vec<String>,
    ) -> Result<Self, CoreError> {
        Ok(Self {
            summary: required_text(summary.into(), "summary")?,
            todos: normalize_string_list(todos),
            evidences: normalize_string_list(evidences),
            timeline_events,
            decisions: normalize_string_list(decisions),
            hypotheses: normalize_string_list(hypotheses),
            entities: normalize_string_list(entities),
            tags: normalize_string_list(tags),
        })
    }

    pub fn minimal(summary: impl Into<String>) -> Result<Self, CoreError> {
        Self::new(
            summary,
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
        )
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }

    pub fn todos(&self) -> &[String] {
        &self.todos
    }

    pub fn evidences(&self) -> &[String] {
        &self.evidences
    }

    pub fn timeline_events(&self) -> &[TimelineEventExtract] {
        &self.timeline_events
    }

    pub fn decisions(&self) -> &[String] {
        &self.decisions
    }

    pub fn hypotheses(&self) -> &[String] {
        &self.hypotheses
    }

    pub fn entities(&self) -> &[String] {
        &self.entities
    }

    pub fn tags(&self) -> &[String] {
        &self.tags
    }
}

/// Compact rolling summary returned by the LLM adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BucketSummaryResult {
    summary: String,
}

impl BucketSummaryResult {
    pub fn new(summary: impl Into<String>) -> Result<Self, CoreError> {
        Ok(Self {
            summary: required_text(summary.into(), "summary")?,
        })
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }
}

/// User-facing result of one archive attempt.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchiveResult {
    status: ArchiveStatus,
    action: ClassificationAction,
    bucket_id: Option<String>,
    bucket_title: Option<String>,
    bucket_type: Option<BucketType>,
    entry_id: Option<String>,
    confidence: f64,
    reason: String,
    question: Option<String>,
    candidate_bucket_ids: Vec<String>,
    extraction: Option<ExtractionResult>,
}

impl ArchiveResult {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        status: ArchiveStatus,
        action: ClassificationAction,
        bucket_id: Option<String>,
        bucket_title: Option<String>,
        bucket_type: Option<BucketType>,
        entry_id: Option<String>,
        confidence: f64,
        reason: impl Into<String>,
        question: Option<String>,
        candidate_bucket_ids: Vec<String>,
        extraction: Option<ExtractionResult>,
    ) -> Result<Self, CoreError> {
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            return Err(CoreError::ConfidenceOutOfRange(confidence));
        }

        Ok(Self {
            status,
            action,
            bucket_id: strip_optional_text(bucket_id),
            bucket_title: strip_optional_text(bucket_title),
            bucket_type,
            entry_id: strip_optional_text(entry_id),
            confidence,
            reason: reason.into().trim().to_owned(),
            question: strip_optional_text(question),
            candidate_bucket_ids: strip_string_list(candidate_bucket_ids),
            extraction,
        })
    }

    pub const fn status(&self) -> ArchiveStatus {
        self.status
    }

    pub const fn action(&self) -> ClassificationAction {
        self.action
    }

    pub fn bucket_id(&self) -> Option<&str> {
        self.bucket_id.as_deref()
    }

    pub fn bucket_title(&self) -> Option<&str> {
        self.bucket_title.as_deref()
    }

    pub const fn bucket_type(&self) -> Option<BucketType> {
        self.bucket_type
    }

    pub fn entry_id(&self) -> Option<&str> {
        self.entry_id.as_deref()
    }

    pub const fn confidence(&self) -> f64 {
        self.confidence
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn question(&self) -> Option<&str> {
        self.question.as_deref()
    }

    pub fn candidate_bucket_ids(&self) -> &[String] {
        &self.candidate_bucket_ids
    }

    pub fn extraction(&self) -> Option<&ExtractionResult> {
        self.extraction.as_ref()
    }
}

fn strip_optional_text(value: Option<String>) -> Option<String> {
    value.map(|item| item.trim().to_owned())
}

fn strip_string_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .collect()
}
