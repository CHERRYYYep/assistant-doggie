//! Deterministic domain logic for the Work Memory Agent.
//!
//! This crate is the first Rust migration boundary. It deliberately excludes
//! databases, HTTP, UI, and LLM clients so classification safeguards can be
//! tested without I/O and reused by later adapters.

mod classification;
mod domain;
mod error;

pub use classification::{
    ConfidencePolicy, apply_confidence_gate, apply_low_information_reference_gate,
    build_bucket_candidates, postprocess_classification, validate_candidate_reference,
};
pub use domain::{
    BucketStatus, BucketType, BucketView, ClassificationAction, ClassificationResult,
};
pub use error::CoreError;
