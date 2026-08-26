//! Deterministic domain logic for the Work Memory Agent.
//!
//! This crate is the first Doggie domain boundary. It deliberately excludes
//! databases, HTTP, UI, and LLM clients so classification safeguards can be
//! tested without I/O and reused by later adapters.

mod classification;
mod domain;
mod error;
mod memory;
mod text;

pub use classification::{
    ConfidencePolicy, apply_confidence_gate, apply_low_information_reference_gate,
    build_bucket_candidates, postprocess_classification, validate_candidate_reference,
};
pub use domain::{
    BucketStatus, BucketType, BucketView, ClassificationAction, ClassificationResult,
    normalize_optional_text, normalize_string_list,
};
pub use error::CoreError;
pub use memory::{
    ArchiveResult, ArchiveStatus, BucketSummaryResult, ExtractionResult, TimelineEventExtract,
};

pub use text::unicode_case_fold;
