//! LLM adapter and controlled Agent Harness boundaries.
//!
//! R4 provides endpoint configuration, strict Structured Outputs requests,
//! response normalization, bounded retry behavior, and an injectable concrete
//! HTTP transport. The product Agent turn remains a separate boundary.

mod config;
mod http_transport;
mod structured_output;

pub use config::{LlmApiMode, LlmConfigurationError, LlmEndpointConfig, OFFICIAL_OPENAI_BASE_URL};
pub use http_transport::{
    DEFAULT_LLM_HTTP_TIMEOUT, LlmHttpProxyMode, LlmHttpTransportConfig,
    LlmTransportConfigurationError, UreqStructuredOutputTransport,
};
pub use structured_output::{
    LlmError, LlmHttpRequest, LlmHttpResponse, LlmTransportError, StructuredOutputAdapter,
    StructuredOutputTransport,
};
