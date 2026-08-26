use doggie_protocol::{ContractError, StructuredOutputContract};
use serde_json::{Value, json};
use thiserror::Error;

use crate::wire_response::{
    WireResponse, WireResponseError, parse_response as parse_wire_response,
};
use crate::{LlmApiMode, LlmEndpointConfig};

/// JSON request ready for a concrete HTTP transport.
#[derive(Debug, Clone, PartialEq)]
pub struct LlmHttpRequest {
    url: String,
    body: Value,
}

impl LlmHttpRequest {
    pub fn from_parts(url: impl Into<String>, body: Value) -> Self {
        Self {
            url: url.into(),
            body,
        }
    }

    fn for_contract<C: StructuredOutputContract>(
        endpoint: &LlmEndpointConfig,
        model: &str,
        system_prompt: &str,
        user_prompt: &str,
    ) -> Self {
        let messages = json!([
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]);
        let schema = C::strict_json_schema();
        let body = match endpoint.api_mode() {
            LlmApiMode::Responses => json!({
                "model": model,
                "input": messages,
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": C::SCHEMA_NAME,
                        "strict": true,
                        "schema": schema
                    }
                }
            }),
            LlmApiMode::ChatCompletions => json!({
                "model": model,
                "messages": messages,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": C::SCHEMA_NAME,
                        "strict": true,
                        "schema": schema
                    }
                }
            }),
        };
        Self::from_parts(endpoint.request_url(), body)
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub const fn body(&self) -> &Value {
        &self.body
    }
}

/// Successful JSON response returned by a concrete transport.
#[derive(Debug, Clone, PartialEq)]
pub struct LlmHttpResponse {
    body: Value,
}

impl LlmHttpResponse {
    pub const fn new(body: Value) -> Self {
        Self { body }
    }

    pub const fn body(&self) -> &Value {
        &self.body
    }
}

/// Failure produced before an API response can be consumed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LlmTransportError {
    #[error("{message}")]
    Request { message: String },
    #[error("HTTP {status}: {message}")]
    HttpStatus { status: u16, message: String },
}

impl LlmTransportError {
    pub fn request(message: impl Into<String>) -> Self {
        Self::Request {
            message: message.into(),
        }
    }

    pub fn http_status(status: u16, message: impl Into<String>) -> Self {
        Self::HttpStatus {
            status,
            message: message.into(),
        }
    }

    pub const fn status(&self) -> Option<u16> {
        match self {
            Self::Request { .. } => None,
            Self::HttpStatus { status, .. } => Some(*status),
        }
    }

    fn is_retryable(&self) -> bool {
        match self.status() {
            Some(status) => matches!(status, 408 | 409 | 429) || (500..=599).contains(&status),
            None => true,
        }
    }
}

/// Injectable transport boundary; ordinary tests provide a deterministic fake.
pub trait StructuredOutputTransport {
    fn send(&mut self, request: &LlmHttpRequest) -> Result<LlmHttpResponse, LlmTransportError>;
}

/// Structured-output failures after request validation or response handling.
#[derive(Debug, Error)]
pub enum LlmError {
    #[error("model must not be empty")]
    EmptyModel,
    #[error("system_prompt must not be empty")]
    EmptySystemPrompt,
    #[error("user_prompt must not be empty")]
    EmptyUserPrompt,
    #[error("transport error: {0}")]
    Transport(#[source] LlmTransportError),
    #[error("model response had unexpected status: {status}")]
    UnexpectedStatus { status: String },
    #[error("model response incomplete: {reason}")]
    Incomplete { reason: String },
    #[error("model refused request: {message}")]
    Refusal { message: String },
    #[error("model response blocked by content filter")]
    ContentFilter,
    #[error("model response did not contain structured output")]
    MissingOutput,
    #[error("model response contained an invalid tool call: {message}")]
    InvalidToolCall { message: String },
    #[error("structured output was not valid JSON: {0}")]
    InvalidJson(#[source] serde_json::Error),
    #[error("model response had an invalid wire shape: {0}")]
    InvalidResponse(#[source] serde_json::Error),
    #[error("structured output violated the contract: {0}")]
    Contract(#[source] ContractError),
    #[error("structured model call failed after {attempts} attempt(s): {last_error}")]
    AttemptsExhausted {
        attempts: usize,
        #[source]
        last_error: Box<LlmError>,
    },
}

impl LlmError {
    pub const fn attempts(&self) -> Option<usize> {
        match self {
            Self::AttemptsExhausted { attempts, .. } => Some(*attempts),
            _ => None,
        }
    }

    pub const fn last_error(&self) -> Option<&Self> {
        match self {
            Self::AttemptsExhausted { last_error, .. } => Some(last_error),
            _ => None,
        }
    }

    fn is_retryable(&self) -> bool {
        match self {
            Self::Transport(error) => error.is_retryable(),
            Self::UnexpectedStatus { .. }
            | Self::Refusal { .. }
            | Self::ContentFilter
            | Self::InvalidToolCall { .. } => false,
            Self::Incomplete { reason } => !reason.eq_ignore_ascii_case("content_filter"),
            Self::MissingOutput
            | Self::InvalidJson(_)
            | Self::InvalidResponse(_)
            | Self::Contract(_) => true,
            Self::EmptyModel
            | Self::EmptySystemPrompt
            | Self::EmptyUserPrompt
            | Self::AttemptsExhausted { .. } => false,
        }
    }
}

/// Transport-independent Responses/Chat Completions Structured Outputs adapter.
pub struct StructuredOutputAdapter<T> {
    endpoint: LlmEndpointConfig,
    transport: T,
}

impl<T> StructuredOutputAdapter<T>
where
    T: StructuredOutputTransport,
{
    pub const fn new(endpoint: LlmEndpointConfig, transport: T) -> Self {
        Self {
            endpoint,
            transport,
        }
    }

    pub const fn endpoint(&self) -> &LlmEndpointConfig {
        &self.endpoint
    }

    pub const fn transport(&self) -> &T {
        &self.transport
    }

    pub fn into_transport(self) -> T {
        self.transport
    }

    /// Parse one strict contract with bounded retries and no real-model fallback.
    pub fn parse<C: StructuredOutputContract>(
        &mut self,
        model: &str,
        system_prompt: &str,
        user_prompt: &str,
        max_retries: usize,
    ) -> Result<C, LlmError> {
        let model = model.trim();
        if model.is_empty() {
            return Err(LlmError::EmptyModel);
        }
        if system_prompt.trim().is_empty() {
            return Err(LlmError::EmptySystemPrompt);
        }
        if user_prompt.trim().is_empty() {
            return Err(LlmError::EmptyUserPrompt);
        }

        let request =
            LlmHttpRequest::for_contract::<C>(&self.endpoint, model, system_prompt, user_prompt);
        for attempt in 0..=max_retries {
            let result = self
                .transport
                .send(&request)
                .map_err(LlmError::Transport)
                .and_then(|response| {
                    parse_response::<C>(self.endpoint.api_mode(), response.body())
                });
            match result {
                Ok(contract) => return Ok(contract),
                Err(error) if attempt < max_retries && error.is_retryable() => {}
                Err(error) => {
                    return Err(LlmError::AttemptsExhausted {
                        attempts: attempt + 1,
                        last_error: Box::new(error),
                    });
                }
            }
        }
        unreachable!("bounded retry loop always returns")
    }
}

fn parse_response<C: StructuredOutputContract>(
    mode: LlmApiMode,
    body: &Value,
) -> Result<C, LlmError> {
    let text = match parse_wire_response(mode, body).map_err(map_wire_error)? {
        WireResponse::FinalText(text) => text,
        WireResponse::ToolCalls { .. } => {
            return Err(LlmError::InvalidToolCall {
                message: "tool calls are not valid structured output".to_owned(),
            });
        }
    };
    let value = serde_json::from_str(&text).map_err(LlmError::InvalidJson)?;
    C::from_structured_value(value).map_err(LlmError::Contract)
}

fn map_wire_error(error: WireResponseError) -> LlmError {
    match error {
        WireResponseError::InvalidResponse(error) => LlmError::InvalidResponse(error),
        WireResponseError::UnexpectedStatus { status } => LlmError::UnexpectedStatus { status },
        WireResponseError::Incomplete { reason } => LlmError::Incomplete { reason },
        WireResponseError::Refusal { message } => LlmError::Refusal { message },
        WireResponseError::ContentFilter => LlmError::ContentFilter,
        WireResponseError::MissingResponse | WireResponseError::MissingOutput => {
            LlmError::MissingOutput
        }
        WireResponseError::InvalidToolCall { message } => LlmError::InvalidToolCall { message },
    }
}
