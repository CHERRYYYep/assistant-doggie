use std::collections::VecDeque;

use serde_json::{Value, json};
use work_memory_agent::{
    AgentHarness, AgentHarnessError, AgentHarnessRequest, AgentHistoryMessage, LlmEndpointConfig,
    LlmHttpRequest, LlmHttpResponse, LlmTransportError, StructuredOutputTransport,
};
use work_memory_contracts::{AgentToolArguments, ChatRole};

struct FakeTransport {
    responses: VecDeque<Result<LlmHttpResponse, LlmTransportError>>,
    requests: Vec<LlmHttpRequest>,
}

impl FakeTransport {
    fn new(responses: impl IntoIterator<Item = Value>) -> Self {
        Self {
            responses: responses
                .into_iter()
                .map(|body| Ok(LlmHttpResponse::new(body)))
                .collect(),
            requests: Vec::new(),
        }
    }

    fn requests(&self) -> &[LlmHttpRequest] {
        &self.requests
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

fn endpoint(mode: &str) -> LlmEndpointConfig {
    match mode {
        "responses" => LlmEndpointConfig::resolve(Some("official"), None, Some(mode)).unwrap(),
        "chat" => {
            LlmEndpointConfig::resolve(Some("relay"), Some("https://relay.example/v1"), Some(mode))
                .unwrap()
        }
        _ => unreachable!("test mode"),
    }
}

fn responses_text(text: &str) -> Value {
    json!({
        "status": "completed",
        "output": [{
            "type": "message",
            "id": "msg_final",
            "role": "assistant",
            "status": "completed",
            "phase": "final_answer",
            "content": [{
                "type": "output_text",
                "annotations": [],
                "logprobs": null,
                "text": text
            }]
        }]
    })
}

fn responses_tool_calls(calls: &[(&str, &str, &str)]) -> Value {
    json!({
        "status": "completed",
        "output": calls.iter().map(|(call_id, name, arguments)| json!({
            "type": "function_call",
            "id": format!("fc-{call_id}"),
            "call_id": call_id,
            "name": name,
            "arguments": arguments,
            "status": "completed"
        })).collect::<Vec<_>>()
    })
}

fn chat_text(text: &str) -> Value {
    json!({
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": text,
                "refusal": null
            }
        }]
    })
}

fn chat_tool_call(call_id: &str, name: &str, arguments: &str) -> Value {
    json!({
        "choices": [{
            "index": 0,
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": null,
                "refusal": null,
                "tool_calls": [{
                    "type": "function",
                    "id": call_id,
                    "function": {"name": name, "arguments": arguments}
                }]
            }
        }]
    })
}

fn history_with_persisted_tool() -> Vec<AgentHistoryMessage> {
    vec![
        AgentHistoryMessage::new(ChatRole::User, "previous user").unwrap(),
        AgentHistoryMessage::new(ChatRole::Assistant, "previous assistant").unwrap(),
        AgentHistoryMessage::new(ChatRole::Tool, "persisted tool payload").unwrap(),
    ]
}

#[test]
fn responses_harness_runs_a_tool_then_returns_final_text_and_preserves_context_roles() {
    let transport = FakeTransport::new([
        responses_tool_calls(&[("call-1", "search_memory", r#"{"query":"支付"}"#)]),
        responses_text("根据记忆，先检查支付回调日志。"),
    ]);
    let mut harness = AgentHarness::new(endpoint("responses"), transport);
    let request = AgentHarnessRequest::new(
        "test-model",
        "test system prompt",
        "当前记忆：支付回调曾经超时",
        history_with_persisted_tool(),
        2,
    )
    .unwrap();
    let mut executed = Vec::new();
    let mut executor = |arguments: AgentToolArguments| {
        executed.push(arguments.clone());
        Ok(json!({"ok": true, "results": [{"title": "支付故障"}]}))
    };

    let result = harness.run(&request, &mut executor).unwrap();

    assert_eq!(result.assistant_text(), "根据记忆，先检查支付回调日志。");
    assert_eq!(result.tool_executions().len(), 1);
    assert_eq!(
        executed,
        vec![AgentToolArguments::SearchMemory {
            query: "支付".to_owned()
        }]
    );

    let requests = harness.transport().requests();
    assert_eq!(requests.len(), 2);
    let first_input = requests[0]
        .body()
        .get("input")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(first_input[0]["role"], json!("system"));
    assert_eq!(first_input[1]["role"], json!("user"));
    assert!(
        first_input[1]["content"]
            .as_str()
            .unwrap()
            .contains("当前记忆")
    );
    assert_eq!(
        first_input[2],
        json!({"role": "user", "content": "previous user"})
    );
    assert_eq!(
        first_input[3],
        json!({"role": "assistant", "content": "previous assistant"})
    );
    assert_eq!(
        first_input.len(),
        4,
        "persisted tool history must be filtered"
    );

    let second_input = requests[1]
        .body()
        .get("input")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(second_input[4]["type"], json!("function_call"));
    assert_eq!(second_input[5]["type"], json!("function_call_output"));
    assert_eq!(second_input[5]["call_id"], json!("call-1"));
    assert_eq!(
        second_input[5]["output"],
        json!(r#"{"ok":true,"results":[{"title":"支付故障"}]}"#)
    );
}

#[test]
fn chat_harness_runs_tool_call_and_serializes_assistant_and_tool_messages() {
    let transport = FakeTransport::new([
        chat_tool_call("chat-call-1", "list_active_buckets", "{}"),
        chat_text("目前没有活跃 Bucket。"),
    ]);
    let mut harness = AgentHarness::new(endpoint("chat"), transport);
    let request = AgentHarnessRequest::new(
        "test-model",
        "test system prompt",
        "当前没有活跃 Bucket",
        history_with_persisted_tool(),
        2,
    )
    .unwrap();
    let mut executor = |arguments: AgentToolArguments| {
        assert_eq!(arguments, AgentToolArguments::ListActiveBuckets);
        Ok(json!({"ok": true, "buckets": []}))
    };

    let result = harness.run(&request, &mut executor).unwrap();

    assert_eq!(result.assistant_text(), "目前没有活跃 Bucket。");
    let requests = harness.transport().requests();
    assert_eq!(requests.len(), 2);
    let first_messages = requests[0]
        .body()
        .get("messages")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(first_messages[0]["role"], json!("system"));
    assert_eq!(first_messages[1]["role"], json!("user"));
    assert_eq!(first_messages[2]["role"], json!("user"));
    assert_eq!(first_messages[3]["role"], json!("assistant"));
    assert_eq!(
        first_messages.len(),
        4,
        "persisted tool history must be filtered"
    );

    let second_messages = requests[1]
        .body()
        .get("messages")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(second_messages[4]["role"], json!("assistant"));
    assert_eq!(
        second_messages[4]["tool_calls"][0]["id"],
        json!("chat-call-1")
    );
    assert_eq!(second_messages[5]["role"], json!("tool"));
    assert_eq!(second_messages[5]["tool_call_id"], json!("chat-call-1"));
    assert_eq!(
        serde_json::from_str::<Value>(second_messages[5]["content"].as_str().unwrap()).unwrap(),
        json!({"ok": true, "buckets": []})
    );
}

#[test]
fn invalid_tool_arguments_become_data_errors_without_arbitrary_execution() {
    let transport = FakeTransport::new([
        responses_tool_calls(&[
            ("unknown", "not_registered", "{}"),
            ("bad-json", "search_memory", "not-json"),
        ]),
        responses_text("工具参数已处理。"),
    ]);
    let mut harness = AgentHarness::new(endpoint("responses"), transport);
    let request = AgentHarnessRequest::new("model", "system", "memory", Vec::new(), 1).unwrap();
    let mut execution_count = 0;
    let mut executor = |_: AgentToolArguments| {
        execution_count += 1;
        Err("executor should not receive invalid calls".to_owned())
    };

    let result = harness.run(&request, &mut executor).unwrap();

    assert_eq!(execution_count, 0);
    assert_eq!(result.tool_executions().len(), 2);
    assert_eq!(result.tool_executions()[0].output()["ok"], json!(false));
    assert_eq!(result.tool_executions()[1].output()["ok"], json!(false));
    let continuation = &harness.transport().requests()[1].body()["input"];
    let outputs = continuation.as_array().unwrap();
    assert_eq!(outputs[4]["type"], json!("function_call_output"));
    assert_eq!(outputs[5]["type"], json!("function_call_output"));
    let first_error =
        serde_json::from_str::<Value>(outputs[4]["output"].as_str().unwrap()).unwrap();
    let second_error =
        serde_json::from_str::<Value>(outputs[5]["output"].as_str().unwrap()).unwrap();
    assert!(
        first_error["error"]
            .as_str()
            .unwrap()
            .contains("unknown tool")
    );
    assert!(
        second_error["error"]
            .as_str()
            .unwrap()
            .contains("valid JSON")
    );
}

#[test]
fn tool_execution_errors_are_returned_to_the_model_as_json_data() {
    let transport = FakeTransport::new([
        responses_tool_calls(&[("call-error", "search_memory", r#"{"query":"x"}"#)]),
        responses_text("搜索暂时不可用。"),
    ]);
    let mut harness = AgentHarness::new(endpoint("responses"), transport);
    let request = AgentHarnessRequest::new("model", "system", "memory", Vec::new(), 1).unwrap();
    let mut executor = |_: AgentToolArguments| Err("store unavailable".to_owned());

    let result = harness.run(&request, &mut executor).unwrap();

    assert_eq!(result.assistant_text(), "搜索暂时不可用。");
    assert_eq!(
        result.tool_executions()[0].output(),
        &json!({
            "ok": false,
            "error": "store unavailable"
        })
    );
}

#[test]
fn max_tool_rounds_stop_a_repeating_model_loop() {
    let transport = FakeTransport::new([
        responses_tool_calls(&[("call-1", "list_active_buckets", "{}")]),
        responses_tool_calls(&[("call-2", "list_active_buckets", "{}")]),
    ]);
    let mut harness = AgentHarness::new(endpoint("responses"), transport);
    let request = AgentHarnessRequest::new("model", "system", "memory", Vec::new(), 1).unwrap();
    let mut executor = |_: AgentToolArguments| Ok(json!({"ok": true}));

    let error = harness.run(&request, &mut executor).unwrap_err();

    assert!(matches!(
        error,
        AgentHarnessError::MaxToolRoundsExceeded { max_tool_rounds: 1 }
    ));
    assert_eq!(harness.transport().requests().len(), 2);
}

#[test]
fn refusal_incomplete_content_filter_and_nonterminal_statuses_are_not_silently_accepted() {
    for status in ["failed", "cancelled", "queued", "in_progress"] {
        let mut harness = AgentHarness::new(
            endpoint("responses"),
            FakeTransport::new([json!({"status": status, "output": []})]),
        );
        let request = AgentHarnessRequest::new("model", "system", "memory", Vec::new(), 0).unwrap();
        let mut executor = |_: AgentToolArguments| Ok(json!({"ok": true}));
        let error = harness.run(&request, &mut executor).unwrap_err();
        assert!(matches!(
            error,
            AgentHarnessError::UnexpectedStatus { status: ref observed } if observed == status
        ));
    }

    let cases = [
        (
            json!({
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": []
            }),
            "incomplete",
        ),
        (
            json!({
                "status": "completed",
                "output": [{
                    "type": "message",
                    "id": "msg-refusal",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "refusal", "refusal": "not allowed"}]
                }]
            }),
            "refusal",
        ),
        (
            json!({
                "status": "incomplete",
                "incomplete_details": {"reason": "content_filter"},
                "output": []
            }),
            "content_filter",
        ),
    ];

    for (body, kind) in cases {
        let mut harness = AgentHarness::new(endpoint("responses"), FakeTransport::new([body]));
        let request = AgentHarnessRequest::new("model", "system", "memory", Vec::new(), 0).unwrap();
        let mut executor = |_: AgentToolArguments| Ok(json!({"ok": true}));
        let error = harness.run(&request, &mut executor).unwrap_err();
        match kind {
            "incomplete" => assert!(matches!(
                error,
                AgentHarnessError::Incomplete { reason } if reason == "max_output_tokens"
            )),
            "refusal" => assert!(matches!(
                error,
                AgentHarnessError::Refusal { message } if message == "not allowed"
            )),
            "content_filter" => assert!(matches!(error, AgentHarnessError::ContentFilter)),
            _ => unreachable!("test error kind"),
        }
    }
}

#[test]
fn provider_tool_definitions_match_contract_metadata() {
    use work_memory_agent::{chat_tool_definitions, response_tool_definitions};
    use work_memory_contracts::AGENT_TOOL_DEFINITIONS;

    let responses = response_tool_definitions();
    let chats = chat_tool_definitions();
    assert_eq!(responses.len(), AGENT_TOOL_DEFINITIONS.len());
    assert_eq!(chats.len(), AGENT_TOOL_DEFINITIONS.len());

    for ((definition, response), chat) in AGENT_TOOL_DEFINITIONS.iter().zip(responses).zip(chats) {
        assert_eq!(response["type"], json!("function"));
        assert_eq!(response["name"], json!(definition.name));
        assert_eq!(response["description"], json!(definition.description));
        assert_eq!(response["parameters"], definition.parameters_schema());
        assert_eq!(response["strict"], json!(true));

        assert_eq!(chat["type"], json!("function"));
        assert_eq!(chat["function"]["name"], json!(definition.name));
        assert_eq!(
            chat["function"]["description"],
            json!(definition.description)
        );
        assert_eq!(
            chat["function"]["parameters"],
            definition.parameters_schema()
        );
        assert_eq!(chat["function"]["strict"], json!(true));
    }
}
