//! Typed normalization for OpenAI Responses and Chat Completions payloads.
//!
//! The transport remains deliberately small and synchronous, but the wire envelopes and
//! discriminated output items are owned by the community `async-openai` type definitions. This
//! module only maps those typed values to the application's smaller, transport-independent
//! representation and error policy.

use async_openai::types::{
    chat::{ChatChoice, ChatCompletionMessageToolCalls, FinishReason},
    responses::{IncompleteDetails, MessagePhase, OutputItem, OutputMessageContent, Status},
};
use serde::Deserialize;
use serde_json::Value;

use crate::LlmApiMode;

#[derive(Debug)]
pub(crate) enum WireResponseError {
    InvalidResponse(serde_json::Error),
    UnexpectedStatus { status: String },
    Incomplete { reason: String },
    Refusal { message: String },
    ContentFilter,
    MissingResponse,
    MissingOutput,
    InvalidToolCall { message: String },
}

#[derive(Debug)]
pub(crate) struct WireToolCall {
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) arguments: String,
}

#[derive(Debug)]
pub(crate) enum WireResponse {
    FinalText(String),
    ToolCalls {
        calls: Vec<WireToolCall>,
        continuation: Vec<Value>,
    },
}

#[derive(Debug, Deserialize)]
struct ResponsesEnvelope {
    #[serde(default)]
    status: Option<Status>,
    #[serde(default)]
    incomplete_details: Option<IncompleteDetails>,
    #[serde(default)]
    output: Vec<OutputItem>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsEnvelope {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

pub(crate) fn parse_response(
    mode: LlmApiMode,
    body: &Value,
) -> Result<WireResponse, WireResponseError> {
    match mode {
        LlmApiMode::Responses => parse_responses(body),
        LlmApiMode::ChatCompletions => parse_chat_completions(body),
    }
}

fn parse_responses(body: &Value) -> Result<WireResponse, WireResponseError> {
    let response: ResponsesEnvelope =
        serde_json::from_value(body.clone()).map_err(WireResponseError::InvalidResponse)?;

    if let Some(status) = response.status.as_ref() {
        match status {
            Status::Completed => {}
            Status::Incomplete => {
                let reason = response
                    .incomplete_details
                    .map(|details| details.reason)
                    .unwrap_or_else(|| "unknown".to_owned());
                if reason.eq_ignore_ascii_case("content_filter") {
                    return Err(WireResponseError::ContentFilter);
                }
                return Err(WireResponseError::Incomplete { reason });
            }
            status => {
                return Err(WireResponseError::UnexpectedStatus {
                    status: response_status_name(status).to_owned(),
                });
            }
        }
    }

    if response.output.is_empty() {
        return Err(WireResponseError::MissingOutput);
    }

    let mut calls = Vec::new();
    let mut first_text = None;
    let mut final_answer_text = None;
    let mut continuation = Vec::with_capacity(response.output.len());

    for item in &response.output {
        continuation.push(serde_json::to_value(item).map_err(WireResponseError::InvalidResponse)?);
        match item {
            OutputItem::FunctionCall(call) => calls.push(WireToolCall {
                call_id: required_non_empty(call.call_id.as_str(), "Responses function call id")?,
                name: required_non_empty(call.name.as_str(), "Responses function call name")?,
                arguments: call.arguments.clone(),
            }),
            OutputItem::Message(message) => {
                for content in &message.content {
                    match content {
                        OutputMessageContent::Refusal(refusal) => {
                            let message = if refusal.refusal.is_empty() {
                                "request refused".to_owned()
                            } else {
                                refusal.refusal.clone()
                            };
                            return Err(WireResponseError::Refusal { message });
                        }
                        OutputMessageContent::OutputText(output_text)
                            if !output_text.text.trim().is_empty() =>
                        {
                            if matches!(message.phase, Some(MessagePhase::FinalAnswer)) {
                                if final_answer_text.is_none() {
                                    final_answer_text = Some(output_text.text.clone());
                                }
                            } else if first_text.is_none() {
                                first_text = Some(output_text.text.clone());
                            }
                        }
                        OutputMessageContent::OutputText(_) => {}
                    }
                }
            }
            _ => {}
        }
    }

    if !calls.is_empty() {
        return Ok(WireResponse::ToolCalls {
            calls,
            continuation,
        });
    }
    if let Some(text) = final_answer_text.or(first_text) {
        return Ok(WireResponse::FinalText(text));
    }
    Err(WireResponseError::MissingOutput)
}

#[allow(deprecated)]
fn parse_chat_completions(body: &Value) -> Result<WireResponse, WireResponseError> {
    let response: ChatCompletionsEnvelope =
        serde_json::from_value(body.clone()).map_err(WireResponseError::InvalidResponse)?;
    let choice = response
        .choices
        .first()
        .ok_or(WireResponseError::MissingResponse)?;

    match choice.finish_reason {
        Some(FinishReason::Length) => {
            return Err(WireResponseError::Incomplete {
                reason: "length".to_owned(),
            });
        }
        Some(FinishReason::ContentFilter) => return Err(WireResponseError::ContentFilter),
        _ => {}
    }

    let message = &choice.message;
    if let Some(refusal) = message.refusal.as_deref().filter(|value| !value.is_empty()) {
        return Err(WireResponseError::Refusal {
            message: refusal.to_owned(),
        });
    }

    let mut calls = Vec::new();
    if let Some(tool_calls) = &message.tool_calls {
        for tool_call in tool_calls {
            match tool_call {
                ChatCompletionMessageToolCalls::Function(tool_call) => {
                    calls.push(WireToolCall {
                        call_id: required_non_empty(
                            tool_call.id.as_str(),
                            "Chat Completions function call id",
                        )?,
                        name: required_non_empty(
                            tool_call.function.name.as_str(),
                            "Chat Completions function name",
                        )?,
                        arguments: tool_call.function.arguments.clone(),
                    });
                }
                ChatCompletionMessageToolCalls::Custom(_) => {
                    return Err(WireResponseError::InvalidToolCall {
                        message: "custom tool calls are not registered by this Harness".to_owned(),
                    });
                }
            }
        }
    }

    if !calls.is_empty() {
        return Ok(WireResponse::ToolCalls {
            calls,
            continuation: vec![
                serde_json::to_value(message).map_err(WireResponseError::InvalidResponse)?,
            ],
        });
    }

    if message.function_call.is_some() {
        return Err(WireResponseError::InvalidToolCall {
            message: "legacy Chat Completions function_call is unsupported; use tool_calls"
                .to_owned(),
        });
    }

    let text = message
        .content
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if text.is_empty() {
        return Err(WireResponseError::MissingOutput);
    }
    Ok(WireResponse::FinalText(text))
}

fn response_status_name(status: &Status) -> &'static str {
    match status {
        Status::Completed => "completed",
        Status::Failed => "failed",
        Status::InProgress => "in_progress",
        Status::Cancelled => "cancelled",
        Status::Queued => "queued",
        Status::Incomplete => "incomplete",
    }
}

fn required_non_empty(value: &str, description: &str) -> Result<String, WireResponseError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(WireResponseError::InvalidToolCall {
            message: format!("{description} is missing"),
        });
    }
    Ok(value.to_owned())
}
