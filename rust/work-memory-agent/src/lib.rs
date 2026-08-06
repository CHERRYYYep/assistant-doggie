//! LLM adapter and controlled Agent Harness boundaries.
//!
//! R4 provides endpoint configuration, strict Structured Outputs requests,
//! response normalization, bounded retry behavior, and an injectable concrete
//! HTTP transport. The product Agent turn remains a separate boundary.

mod agent_harness;
mod config;
mod http_transport;
mod structured_output;
mod wire_response;

pub use config::{LlmApiMode, LlmConfigurationError, LlmEndpointConfig, OFFICIAL_OPENAI_BASE_URL};
pub use http_transport::{
    DEFAULT_LLM_HTTP_TIMEOUT, LlmHttpProxyMode, LlmHttpTransportConfig,
    LlmTransportConfigurationError, UreqStructuredOutputTransport,
};
pub use structured_output::{
    LlmError, LlmHttpRequest, LlmHttpResponse, LlmTransportError, StructuredOutputAdapter,
    StructuredOutputTransport,
};

pub use agent_harness::{
    AGENT_SYSTEM_PROMPT, AgentHarness, AgentHarnessError, AgentHarnessRequest, AgentHarnessResult,
    AgentHistoryMessage, AgentToolCall, AgentToolExecution, AgentToolExecutor,
    DEFAULT_AGENT_MAX_TOOL_ROUNDS, MAX_AGENT_HISTORY_MESSAGE_BYTES, MAX_AGENT_HISTORY_MESSAGES,
    MAX_AGENT_MEMORY_CONTEXT_BYTES, MAX_AGENT_TOOL_ARGUMENT_BYTES, MAX_AGENT_TOOL_CALLS_PER_ROUND,
    MAX_AGENT_TOOL_OUTPUT_BYTES, MAX_AGENT_TOOL_ROUNDS, chat_tool_definitions,
    response_tool_definitions,
};
