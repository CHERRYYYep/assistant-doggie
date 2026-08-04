use std::error::Error;
use std::fmt::{self, Display, Formatter};

/// Validation failures produced by the deterministic domain layer.
#[derive(Debug, Clone, PartialEq)]
pub enum CoreError {
    EmptyText(&'static str),
    ConfidenceOutOfRange(f64),
    InvalidConfidenceThresholds {
        confirm_threshold: f64,
        auto_archive_threshold: f64,
    },
    InconsistentClassification(&'static str),
    CandidateLimitTooSmall,
}

impl Display for CoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyText(field) => write!(formatter, "{field} must not be empty"),
            Self::ConfidenceOutOfRange(value) => {
                write!(formatter, "confidence must be between 0 and 1, got {value}")
            }
            Self::InvalidConfidenceThresholds {
                confirm_threshold,
                auto_archive_threshold,
            } => write!(
                formatter,
                "confidence thresholds must satisfy 0 <= confirm <= auto <= 1; got confirm={confirm_threshold}, auto={auto_archive_threshold}"
            ),
            Self::InconsistentClassification(message) => formatter.write_str(message),
            Self::CandidateLimitTooSmall => {
                formatter.write_str("candidate limit must be at least 1")
            }
        }
    }
}

impl Error for CoreError {}
