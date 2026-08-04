//! Strict JSON boundary contracts for the Work Memory Agent.
//!
//! The domain crate stays independent from serialization. This crate owns the
//! migration boundary between JSON produced by Python/OpenAI and validated Rust
//! types, including unknown-field rejection and Pydantic-compatible trimming.

mod agent;
mod archive;
mod classification;
mod error;
mod extraction;
mod timestamp;
mod values;

pub use agent::{
    AgentToolArguments, AgentTurnContract, BucketSearchResultContract, ChatMessageContract,
    ChatRole,
};
pub use archive::ArchiveContract;
pub use classification::{BucketViewContract, ClassificationContract};
pub use error::ContractError;
pub use extraction::{BucketSummaryContract, ExtractionContract};
