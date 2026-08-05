use thiserror::Error;

/// Validation failures produced by the deterministic domain layer.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum CoreError {
    #[error("{0} must not be empty")]
    EmptyText(&'static str),
    #[error("confidence must be between 0 and 1, got {0}")]
    ConfidenceOutOfRange(f64),
    #[error(
        "confidence thresholds must satisfy 0 <= confirm <= auto <= 1; got confirm={confirm_threshold}, auto={auto_archive_threshold}"
    )]
    InvalidConfidenceThresholds {
        confirm_threshold: f64,
        auto_archive_threshold: f64,
    },
    #[error("{0}")]
    InconsistentClassification(&'static str),
    #[error("candidate limit must be at least 1")]
    CandidateLimitTooSmall,
}
