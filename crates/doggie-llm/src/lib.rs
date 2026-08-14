//! LLM endpoint, transport, and structured-output boundaries for Doggie.
//!
//! This crate owns model endpoint configuration, strict Structured Outputs
//! requests, response normalization, bounded retry behavior, and injectable
//! concrete HTTP transport. Agent tool-loop orchestration lives in
//! `doggie-agent-runtime`.

mod config;
mod http_transport;
mod structured_output;
pub mod wire_response;

pub use config::{LlmApiMode, LlmConfigurationError, LlmEndpointConfig, OFFICIAL_OPENAI_BASE_URL};
pub use http_transport::{
    DEFAULT_LLM_HTTP_TIMEOUT, LlmHttpProxyMode, LlmHttpTransportConfig,
    LlmTransportConfigurationError, UreqStructuredOutputTransport,
};
pub use structured_output::{
    LlmError, LlmHttpRequest, LlmHttpResponse, LlmTransportError, StructuredOutputAdapter,
    StructuredOutputTransport,
};
