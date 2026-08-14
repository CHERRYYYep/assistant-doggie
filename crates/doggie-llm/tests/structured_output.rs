use std::collections::VecDeque;

use doggie_llm::{
    LlmApiMode, LlmConfigurationError, LlmEndpointConfig, LlmError, LlmHttpRequest,
    LlmHttpResponse, LlmTransportError, StructuredOutputAdapter, StructuredOutputTransport,
};
use doggie_protocol::{BucketSummaryContract, StructuredOutputContract};
use serde_json::json;

#[derive(Default)]
struct FakeTransport {
    responses: VecDeque<Result<LlmHttpResponse, LlmTransportError>>,
    requests: Vec<LlmHttpRequest>,
}

impl FakeTransport {
    fn new(
        responses: impl IntoIterator<Item = Result<LlmHttpResponse, LlmTransportError>>,
    ) -> Self {
        Self {
            responses: responses.into_iter().collect(),
            requests: Vec::new(),
        }
    }
}

impl StructuredOutputTransport for FakeTransport {
    fn send(&mut self, request: &LlmHttpRequest) -> Result<LlmHttpResponse, LlmTransportError> {
        self.requests.push(request.clone());
        self.responses
            .pop_front()
            .expect("fake transport must have a queued response")
    }
}

#[test]
fn endpoint_parser_keeps_security_policy_around_community_url_parsing() {
    assert_eq!(
        LlmEndpointConfig::resolve(
            Some("local-gateway"),
            Some("http://localhost:8000/v1/"),
            Some("responses"),
        )
        .unwrap()
        .base_url(),
        "http://localhost:8000/v1"
    );
    assert_eq!(
        LlmEndpointConfig::resolve(
            Some("local-gateway"),
            Some("http://127.0.0.2:8000/v1"),
            Some("responses"),
        ),
        Err(LlmConfigurationError::InsecureRemoteBaseUrl)
    );
    assert_eq!(
        LlmEndpointConfig::resolve(
            Some("relay"),
            Some("https://relay.example:not-a-port/v1"),
            Some("responses"),
        ),
        Err(LlmConfigurationError::InvalidBaseUrl)
    );
}

#[test]
fn responses_adapter_builds_the_official_request_and_parses_a_contract() {
    let endpoint = LlmEndpointConfig::resolve(Some("official"), None, Some("responses")).unwrap();
    let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
        "status": "completed",
        "output": [{
            "type": "message",
            "id": "msg_fixture",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "annotations": [],
                "logprobs": null,
                "text": "{\"summary\":\"  completed  \"}"
            }]
        }]
    })))]);
    let mut adapter = StructuredOutputAdapter::new(endpoint, transport);

    let result = adapter
        .parse::<BucketSummaryContract>("  test-model  ", " system prompt ", " user prompt ", 0)
        .unwrap();

    assert_eq!(result.inner().summary(), "completed");
    let requests = &adapter.transport().requests;
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url(), "https://api.openai.com/v1/responses");
    assert_eq!(
        requests[0].body(),
        &json!({
            "model": "test-model",
            "input": [
                {"role": "system", "content": " system prompt "},
                {"role": "user", "content": " user prompt "}
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "BucketSummaryResult",
                    "strict": true,
                    "schema": BucketSummaryContract::strict_json_schema()
                }
            }
        })
    );
}

#[test]
fn chat_completions_adapter_builds_the_compatible_request() {
    let endpoint = LlmEndpointConfig::resolve(
        Some("relay"),
        Some("https://relay.example/v1/"),
        Some("chat_completions"),
    )
    .unwrap();
    let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "refusal": null,
                "content": "{\"summary\":\"relay complete\"}"
            }
        }]
    })))]);
    let mut adapter = StructuredOutputAdapter::new(endpoint, transport);

    let result = adapter
        .parse::<BucketSummaryContract>("relay-model", "system", "user", 0)
        .unwrap();

    assert_eq!(result.inner().summary(), "relay complete");
    let request = &adapter.transport().requests[0];
    assert_eq!(request.url(), "https://relay.example/v1/chat/completions");
    assert_eq!(
        request.body(),
        &json!({
            "model": "relay-model",
            "messages": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "user"}
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "BucketSummaryResult",
                    "strict": true,
                    "schema": BucketSummaryContract::strict_json_schema()
                }
            }
        })
    );
}

#[test]
fn retryable_incomplete_invalid_json_and_contract_errors_are_bounded() {
    let endpoint = LlmEndpointConfig::resolve(Some("official"), None, None).unwrap();
    let transport = FakeTransport::new([
        Ok(LlmHttpResponse::new(json!({
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": []
        }))),
        Ok(responses_text("not-json")),
        Ok(responses_text("{\"summary\":\"\"}")),
        Ok(responses_text("{\"summary\":\"recovered\"}")),
    ]);
    let mut adapter = StructuredOutputAdapter::new(endpoint, transport);

    let result = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 3)
        .unwrap();

    assert_eq!(result.inner().summary(), "recovered");
    assert_eq!(adapter.transport().requests.len(), 4);
}

#[test]
fn retry_policy_distinguishes_transient_http_from_refusal_and_filtering() {
    let endpoint = LlmEndpointConfig::resolve(Some("official"), None, None).unwrap();
    let transport = FakeTransport::new([
        Err(LlmTransportError::request("connection reset")),
        Err(LlmTransportError::http_status(500, "server error")),
        Err(LlmTransportError::http_status(429, "rate limited")),
        Ok(responses_text("{\"summary\":\"after retry\"}")),
    ]);
    let mut adapter = StructuredOutputAdapter::new(endpoint.clone(), transport);
    let result = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 3)
        .unwrap();
    assert_eq!(result.inner().summary(), "after retry");
    assert_eq!(adapter.transport().requests.len(), 4);

    let transport = FakeTransport::new([
        Err(LlmTransportError::http_status(401, "unauthorized")),
        Ok(responses_text("{\"summary\":\"must not run\"}")),
    ]);
    let mut adapter = StructuredOutputAdapter::new(endpoint.clone(), transport);
    let error = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 2)
        .unwrap_err();
    assert_eq!(error.attempts(), Some(1));
    assert!(matches!(
        error.last_error(),
        Some(LlmError::Transport(LlmTransportError::HttpStatus {
            status: 401,
            ..
        }))
    ));
    assert_eq!(adapter.transport().requests.len(), 1);

    let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
        "status": "completed",
        "output": [{
            "type": "message",
            "id": "msg_fixture",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "refusal", "refusal": "cannot process"}]
        }]
    })))]);
    let mut adapter = StructuredOutputAdapter::new(endpoint.clone(), transport);
    let error = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 2)
        .unwrap_err();
    assert_eq!(error.attempts(), Some(1));
    assert!(matches!(error.last_error(), Some(LlmError::Refusal { .. })));
    assert_eq!(adapter.transport().requests.len(), 1);

    let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
        "status": "incomplete",
        "incomplete_details": {"reason": "content_filter"},
        "output": []
    })))]);
    let mut adapter = StructuredOutputAdapter::new(endpoint, transport);
    let error = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 2)
        .unwrap_err();
    assert_eq!(error.attempts(), Some(1));
    assert!(matches!(error.last_error(), Some(LlmError::ContentFilter)));
    assert_eq!(adapter.transport().requests.len(), 1);

    let chat_endpoint = LlmEndpointConfig::resolve(
        Some("relay"),
        Some("https://relay.example/v1"),
        Some("chat"),
    )
    .unwrap();
    let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
        "choices": [{
            "index": 0,
            "finish_reason": "content_filter",
            "message": {"role": "assistant", "content": null, "refusal": null}
        }]
    })))]);
    let mut adapter = StructuredOutputAdapter::new(chat_endpoint, transport);
    let error = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 2)
        .unwrap_err();
    assert_eq!(error.attempts(), Some(1));
    assert!(matches!(error.last_error(), Some(LlmError::ContentFilter)));
}

#[test]
fn responses_parser_prefers_final_answer_phase_when_multiple_messages_are_returned() {
    let endpoint = LlmEndpointConfig::resolve(Some("official"), None, None).unwrap();
    let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
        "status": "completed",
        "output": [
            {
                "type": "message",
                "id": "msg-commentary",
                "role": "assistant",
                "status": "completed",
                "phase": "commentary",
                "content": [{
                    "type": "output_text",
                    "annotations": [],
                    "logprobs": null,
                    "text": "{\"summary\":\"intermediate\"}"
                }]
            },
            {
                "type": "message",
                "id": "msg-final",
                "role": "assistant",
                "status": "completed",
                "phase": "final_answer",
                "content": [{
                    "type": "output_text",
                    "annotations": [],
                    "logprobs": null,
                    "text": "{\"summary\":\"final\"}"
                }]
            }
        ]
    })))]);
    let mut adapter = StructuredOutputAdapter::new(endpoint, transport);

    let result = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 0)
        .unwrap();

    assert_eq!(result.inner().summary(), "final");
}

#[test]
fn responses_nonterminal_statuses_are_explicit_errors() {
    for status in ["failed", "cancelled", "queued", "in_progress"] {
        let endpoint = LlmEndpointConfig::resolve(Some("official"), None, None).unwrap();
        let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
            "status": status,
            "output": []
        })))]);
        let mut adapter = StructuredOutputAdapter::new(endpoint, transport);

        let error = adapter
            .parse::<BucketSummaryContract>("model", "system", "user", 2)
            .unwrap_err();

        assert_eq!(error.attempts(), Some(1));
        assert!(matches!(
            error.last_error(),
            Some(LlmError::UnexpectedStatus { status: observed }) if observed == status
        ));
    }
}

#[test]
fn structured_output_rejects_tool_calls_and_legacy_function_call_without_silent_loss() {
    let endpoint = LlmEndpointConfig::resolve(Some("official"), None, None).unwrap();
    let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
        "status": "completed",
        "output": [{
            "type": "function_call",
            "id": "fc-1",
            "call_id": "call-1",
            "name": "search_memory",
            "arguments": "{}",
            "status": "completed"
        }]
    })))]);
    let mut adapter = StructuredOutputAdapter::new(endpoint, transport);
    let error = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 2)
        .unwrap_err();
    assert_eq!(error.attempts(), Some(1));
    assert!(matches!(
        error.last_error(),
        Some(LlmError::InvalidToolCall { message }) if message == "tool calls are not valid structured output"
    ));

    let chat_endpoint = LlmEndpointConfig::resolve(
        Some("relay"),
        Some("https://relay.example/v1"),
        Some("chat"),
    )
    .unwrap();
    let transport = FakeTransport::new([Ok(LlmHttpResponse::new(json!({
        "choices": [{
            "index": 0,
            "finish_reason": "function_call",
            "message": {
                "role": "assistant",
                "content": null,
                "refusal": null,
                "function_call": {"name": "search_memory", "arguments": "{}"}
            }
        }]
    })))]);
    let mut adapter = StructuredOutputAdapter::new(chat_endpoint, transport);
    let error = adapter
        .parse::<BucketSummaryContract>("model", "system", "user", 2)
        .unwrap_err();
    assert_eq!(error.attempts(), Some(1));
    assert!(matches!(
        error.last_error(),
        Some(LlmError::InvalidToolCall { message })
            if message.contains("legacy Chat Completions function_call")
    ));
}

#[test]
fn invalid_requests_are_rejected_before_the_transport_boundary() {
    let endpoint = LlmEndpointConfig::resolve(Some("official"), None, None).unwrap();
    let mut adapter = StructuredOutputAdapter::new(endpoint, FakeTransport::default());

    assert!(matches!(
        adapter.parse::<BucketSummaryContract>("  ", "system", "user", 0),
        Err(LlmError::EmptyModel)
    ));
    assert!(matches!(
        adapter.parse::<BucketSummaryContract>("model", " \n ", "user", 0),
        Err(LlmError::EmptySystemPrompt)
    ));
    assert!(matches!(
        adapter.parse::<BucketSummaryContract>("model", "system", " \t ", 0),
        Err(LlmError::EmptyUserPrompt)
    ));
    assert!(adapter.transport().requests.is_empty());
}

fn responses_text(text: &str) -> LlmHttpResponse {
    LlmHttpResponse::new(json!({
        "status": "completed",
        "output": [{
            "type": "message",
            "id": "msg_fixture",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "annotations": [], "logprobs": null, "text": text}]
        }]
    }))
}

#[test]
fn api_modes_expose_stable_names_and_paths() {
    assert_eq!(LlmApiMode::Responses.as_str(), "responses");
    assert_eq!(LlmApiMode::Responses.path(), "responses");
    assert_eq!(LlmApiMode::ChatCompletions.as_str(), "chat_completions");
    assert_eq!(LlmApiMode::ChatCompletions.path(), "chat/completions");
}
