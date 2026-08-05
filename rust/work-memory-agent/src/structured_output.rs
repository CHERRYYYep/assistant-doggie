use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde_json::{Value, json};
use work_memory_contracts::{ContractError, StructuredOutputContract};

use crate::{LlmApiMode, LlmEndpointConfig};

/// JSON request ready for a concrete HTTP transport.
#[derive(Debug, Clone, PartialEq)]
pub struct LlmHttpRequest {
    url: String,
    body: Value,
}

impl LlmHttpRequest {
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
        Self {
            url: endpoint.request_url(),
            body,
        }
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmTransportError {
    Request { message: String },
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

impl Display for LlmTransportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request { message } => formatter.write_str(message),
            Self::HttpStatus { status, message } => {
                write!(formatter, "HTTP {status}: {message}")
            }
        }
    }
}

impl Error for LlmTransportError {}

/// Injectable transport boundary; ordinary tests provide a deterministic fake.
pub trait StructuredOutputTransport {
    fn send(&mut self, request: &LlmHttpRequest) -> Result<LlmHttpResponse, LlmTransportError>;
}

/// Structured-output failures after request validation or response handling.
#[derive(Debug)]
pub enum LlmError {
    EmptyModel,
    EmptySystemPrompt,
    EmptyUserPrompt,
    Transport(LlmTransportError),
    Incomplete {
        reason: String,
    },
    Refusal {
        message: String,
    },
    ContentFilter,
    MissingOutput,
    InvalidJson(serde_json::Error),
    Contract(ContractError),
    AttemptsExhausted {
        attempts: usize,
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
            Self::Refusal { .. } | Self::ContentFilter => false,
            Self::Incomplete { reason } => !reason.eq_ignore_ascii_case("content_filter"),
            Self::MissingOutput | Self::InvalidJson(_) | Self::Contract(_) => true,
            Self::EmptyModel
            | Self::EmptySystemPrompt
            | Self::EmptyUserPrompt
            | Self::AttemptsExhausted { .. } => false,
        }
    }
}

impl Display for LlmError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyModel => formatter.write_str("model must not be empty"),
            Self::EmptySystemPrompt => formatter.write_str("system_prompt must not be empty"),
            Self::EmptyUserPrompt => formatter.write_str("user_prompt must not be empty"),
            Self::Transport(error) => write!(formatter, "transport error: {error}"),
            Self::Incomplete { reason } => write!(formatter, "model response incomplete: {reason}"),
            Self::Refusal { message } => write!(formatter, "model refused request: {message}"),
            Self::ContentFilter => formatter.write_str("model response blocked by content filter"),
            Self::MissingOutput => {
                formatter.write_str("model response did not contain structured output")
            }
            Self::InvalidJson(error) => {
                write!(formatter, "structured output was not valid JSON: {error}")
            }
            Self::Contract(error) => write!(
                formatter,
                "structured output violated the contract: {error}"
            ),
            Self::AttemptsExhausted {
                attempts,
                last_error,
            } => write!(
                formatter,
                "structured model call failed after {attempts} attempt(s): {last_error}"
            ),
        }
    }
}

impl Error for LlmError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::InvalidJson(error) => Some(error),
            Self::Contract(error) => Some(error),
            Self::AttemptsExhausted { last_error, .. } => Some(last_error),
            Self::EmptyModel
            | Self::EmptySystemPrompt
            | Self::EmptyUserPrompt
            | Self::Incomplete { .. }
            | Self::Refusal { .. }
            | Self::ContentFilter
            | Self::MissingOutput => None,
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
    let text = match mode {
        LlmApiMode::Responses => responses_output_text(body)?,
        LlmApiMode::ChatCompletions => chat_output_text(body)?,
    };
    let value = serde_json::from_str(&text).map_err(LlmError::InvalidJson)?;
    C::from_structured_value(value).map_err(LlmError::Contract)
}

fn responses_output_text(body: &Value) -> Result<String, LlmError> {
    if body
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "incomplete")
    {
        let reason = body
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if reason.eq_ignore_ascii_case("content_filter") {
            return Err(LlmError::ContentFilter);
        }
        return Err(LlmError::Incomplete {
            reason: reason.to_owned(),
        });
    }

    let mut output_text = String::new();
    for item in body
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for content in item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match content.get("type").and_then(Value::as_str) {
                Some("refusal") => {
                    let message = content
                        .get("refusal")
                        .and_then(Value::as_str)
                        .unwrap_or("request refused")
                        .to_owned();
                    return Err(LlmError::Refusal { message });
                }
                Some("output_text") => {
                    if let Some(text) = content.get("text").and_then(Value::as_str) {
                        output_text.push_str(text);
                    }
                }
                _ => {}
            }
        }
    }

    if output_text.trim().is_empty() {
        Err(LlmError::MissingOutput)
    } else {
        Ok(output_text)
    }
}

fn chat_output_text(body: &Value) -> Result<String, LlmError> {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or(LlmError::MissingOutput)?;

    match choice.get("finish_reason").and_then(Value::as_str) {
        Some("length") => {
            return Err(LlmError::Incomplete {
                reason: "length".to_owned(),
            });
        }
        Some("content_filter") => return Err(LlmError::ContentFilter),
        _ => {}
    }

    let message = choice.get("message").ok_or(LlmError::MissingOutput)?;
    if let Some(refusal) = message.get("refusal").and_then(Value::as_str) {
        if !refusal.is_empty() {
            return Err(LlmError::Refusal {
                message: refusal.to_owned(),
            });
        }
    }

    match message.get("content") {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text.to_owned()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>();
            if text.trim().is_empty() {
                Err(LlmError::MissingOutput)
            } else {
                Ok(text)
            }
        }
        _ => Err(LlmError::MissingOutput),
    }
}
