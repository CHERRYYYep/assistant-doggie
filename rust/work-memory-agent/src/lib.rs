//! LLM adapter and controlled Agent Harness boundaries.
//!
//! R4a provides transport-independent endpoint configuration, strict
//! Structured Outputs requests, response normalization, and bounded retry
//! behavior. A concrete HTTP transport and the product Agent turn remain
//! separate follow-up boundaries.

mod config;
mod structured_output;

pub use config::{LlmApiMode, LlmConfigurationError, LlmEndpointConfig, OFFICIAL_OPENAI_BASE_URL};
pub use structured_output::{
    LlmError, LlmHttpRequest, LlmHttpResponse, LlmTransportError, StructuredOutputAdapter,
    StructuredOutputTransport,
};
