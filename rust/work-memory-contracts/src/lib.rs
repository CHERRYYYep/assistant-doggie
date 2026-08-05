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
mod structured_output;
mod timestamp;
mod values;

pub use agent::{
    AGENT_TOOL_DEFINITIONS, ARCHIVE_MEMORY_TOOL, AgentToolArguments, AgentToolDefinition,
    AgentToolParameter, AgentToolParameterKind, AgentTurnContract, BucketSearchResultContract,
    CREATE_BUCKET_AND_SAVE_TOOL, ChatMessageContract, ChatRole, GET_BUCKET_DETAIL_TOOL,
    LIST_ACTIVE_BUCKETS_TOOL, SAVE_TO_EXISTING_BUCKET_TOOL, SEARCH_MEMORY_TOOL,
    agent_tool_definition,
};
pub use archive::ArchiveContract;
pub use classification::{BucketViewContract, ClassificationContract};
pub use error::ContractError;
pub use extraction::{BucketSummaryContract, ExtractionContract};
pub use structured_output::StructuredOutputContract;
