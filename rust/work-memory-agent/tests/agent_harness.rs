use std::collections::VecDeque;

use serde_json::{Value, json};
use work_memory_agent::{
    AgentHarness, AgentHarnessError, AgentHarnessRequest, AgentHistoryMessage, LlmEndpointConfig,
    LlmHttpRequest, LlmHttpResponse, LlmTransportError, StructuredOutputTransport,
    chat_tool_definitions, response_tool_definitions,
};
use work_memory_contracts::{AgentToolArguments, ChatRole, SEARCH_MEMORY_TOOL};

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

#[test]
fn search_memory_responses_and_chat_schemas_share_the_strict_natural_language_contract() {
    let response = response_tool_definitions()
        .into_iter()
        .find(|tool| tool["name"] == SEARCH_MEMORY_TOOL)
        .expect("Responses search_memory definition");
    let chat = chat_tool_definitions()
        .into_iter()
        .find(|tool| tool["function"]["name"] == SEARCH_MEMORY_TOOL)
        .expect("Chat Completions search_memory definition");

    assert_eq!(response["type"], json!("function"));
    assert_eq!(response["strict"], json!(true));
    assert_eq!(chat["type"], json!("function"));
    assert_eq!(chat["function"]["strict"], json!(true));
    assert_eq!(response["description"], chat["function"]["description"]);
    assert_eq!(response["parameters"], chat["function"]["parameters"]);

    let description = response["description"]
        .as_str()
        .expect("search description should be a string");
    for phrase in [
        "自然语言",
        "实体",
        "主题",
        "时间范围",
        "状态",
        "多条 Entry",
        "多个 Bucket",
    ] {
        assert!(
            description.contains(phrase),
            "missing model guidance: {phrase}"
        );
    }

    assert_eq!(response["parameters"]["required"], json!(["query"]));
    assert_eq!(response["parameters"]["additionalProperties"], json!(false));
    assert_eq!(
        response["parameters"]["properties"]["query"]["type"],
        json!("string")
    );
}

#[test]
fn responses_search_harness_forwards_query_plan_and_multiple_buckets_and_entries() {
    let transport = FakeTransport::new([
        responses_tool_calls(&[(
            "search-1",
            "search_memory",
            r#"{"query":"查询接口 A 最近两周的压测结果，并只看 active 状态"}"#,
        )]),
        responses_text("已找到「接口 A 压测」和「网关性能回归」两个 Bucket，共 3 条 Entry。"),
    ]);
    let mut harness = AgentHarness::new(endpoint("responses"), transport);
    let request = AgentHarnessRequest::new(
        "test-model",
        "test system prompt",
        "当前记忆上下文",
        Vec::new(),
        2,
    )
    .unwrap();
    let expected = multi_bucket_search_output();
    let mut observed = Vec::new();
    let mut executor = |arguments: AgentToolArguments| {
        observed.push(arguments.clone());
        Ok(expected.clone())
    };

    let result = harness.run(&request, &mut executor).unwrap();

    assert_eq!(
        observed,
        vec![AgentToolArguments::SearchMemory {
            query: "查询接口 A 最近两周的压测结果，并只看 active 状态".to_owned(),
        }]
    );
    assert!(result.assistant_text().contains("接口 A 压测"));
    assert!(result.assistant_text().contains("网关性能回归"));
    assert_multi_bucket_search_output(result.tool_executions()[0].output());

    let second_input = harness.transport().requests()[1].body()["input"]
        .as_array()
        .expect("Responses continuation input");
    let tool_output = second_input
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .expect("Responses tool output");
    assert_eq!(tool_output["call_id"], json!("search-1"));
    let forwarded: Value = serde_json::from_str(
        tool_output["output"]
            .as_str()
            .expect("Responses tool output should be JSON text"),
    )
    .expect("forwarded Responses tool output should be valid JSON");
    assert_multi_bucket_search_output(&forwarded);
}

#[test]
fn chat_search_harness_forwards_query_plan_and_multiple_buckets_and_entries() {
    let transport = FakeTransport::new([
        chat_tool_call(
            "search-1",
            "search_memory",
            r#"{"query":"查询接口 A 最近两周的压测结果，并只看 active 状态"}"#,
        ),
        chat_text("已找到「接口 A 压测」和「网关性能回归」两个 Bucket，共 3 条 Entry。"),
    ]);
    let mut harness = AgentHarness::new(endpoint("chat"), transport);
    let request = AgentHarnessRequest::new(
        "test-model",
        "test system prompt",
        "当前记忆上下文",
        Vec::new(),
        2,
    )
    .unwrap();
    let expected = multi_bucket_search_output();
    let mut observed = Vec::new();
    let mut executor = |arguments: AgentToolArguments| {
        observed.push(arguments.clone());
        Ok(expected.clone())
    };

    let result = harness.run(&request, &mut executor).unwrap();

    assert_eq!(
        observed,
        vec![AgentToolArguments::SearchMemory {
            query: "查询接口 A 最近两周的压测结果，并只看 active 状态".to_owned(),
        }]
    );
    assert!(result.assistant_text().contains("接口 A 压测"));
    assert!(result.assistant_text().contains("网关性能回归"));
    assert_multi_bucket_search_output(result.tool_executions()[0].output());

    let second_messages = harness.transport().requests()[1].body()["messages"]
        .as_array()
        .expect("Chat continuation messages");
    let tool_message = second_messages
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("Chat tool message");
    assert_eq!(tool_message["tool_call_id"], json!("search-1"));
    let forwarded: Value = serde_json::from_str(
        tool_message["content"]
            .as_str()
            .expect("Chat tool content should be JSON text"),
    )
    .expect("forwarded Chat tool output should be valid JSON");
    assert_multi_bucket_search_output(&forwarded);
}

#[test]
fn search_memory_unknown_fields_are_rejected_before_the_agent_executor() {
    let transport = FakeTransport::new([
        responses_tool_calls(&[(
            "bad-search",
            "search_memory",
            r#"{"query":"接口 A","status":"active"}"#,
        )]),
        responses_text("参数无效。"),
    ]);
    let mut harness = AgentHarness::new(endpoint("responses"), transport);
    let request = AgentHarnessRequest::new("model", "system", "memory", Vec::new(), 1).unwrap();
    let mut execution_count = 0;
    let mut executor = |_: AgentToolArguments| {
        execution_count += 1;
        Ok(json!({"ok": true}))
    };

    let result = harness.run(&request, &mut executor).unwrap();

    assert_eq!(execution_count, 0);
    let error = result.tool_executions()[0].output()["error"]
        .as_str()
        .expect("strict argument error");
    assert!(error.contains("unknown field"), "unexpected error: {error}");
    assert!(error.contains("status"), "unexpected error: {error}");
}

fn multi_bucket_search_output() -> Value {
    json!({
        "ok": true,
        "query": "查询接口 A 最近两周的压测结果，并只看 active 状态",
        "query_plan": {
            "raw_text": "查询接口 A 最近两周的压测结果，并只看 active 状态",
            "terms": ["接口 A", "压测结果"],
            "entity_terms": ["接口 A"],
            "topic_terms": ["压测结果"],
            "bucket_terms": [],
            "time_range": {
                "start": "2026-07-23 12:00:00",
                "end": "2026-08-06 12:00:00",
                "label": "最近两周"
            },
            "statuses": ["active"],
            "structured_filters": [],
            "limit": 20
        },
        "total_entries": 3,
        "total_buckets": 2,
        "results": [
            {
                "bucket": {"id": "bucket-a", "title": "接口 A 压测"},
                "entry": {
                    "id": "entry-a1",
                    "bucket_id": "bucket-a",
                    "raw_text": "接口 A P99 为 120ms",
                    "summary": "压测结果摘要",
                    "created_at": "2026-08-01 12:00:00"
                },
                "memories": [],
                "matched_fields": ["entity", "topic", "raw_text"],
                "keyword_score": 30,
                "semantic_score": 0.0,
                "score": 30
            },
            {
                "bucket": {"id": "bucket-a", "title": "接口 A 压测"},
                "entry": {
                    "id": "entry-a2",
                    "bucket_id": "bucket-a",
                    "raw_text": "接口 A 无错误",
                    "summary": "压测无错误",
                    "created_at": "2026-08-03 12:00:00"
                },
                "memories": [],
                "matched_fields": ["entity", "topic"],
                "keyword_score": 20,
                "semantic_score": 0.0,
                "score": 20
            },
            {
                "bucket": {"id": "bucket-b", "title": "网关性能回归"},
                "entry": {
                    "id": "entry-b1",
                    "bucket_id": "bucket-b",
                    "raw_text": "接口 A 压测回归完成",
                    "summary": "回归结果",
                    "created_at": "2026-08-05 12:00:00"
                },
                "memories": [],
                "matched_fields": ["entity", "topic", "summary"],
                "keyword_score": 15,
                "semantic_score": 0.0,
                "score": 15
            }
        ],
        "buckets": [
            {
                "bucket": {"id": "bucket-a", "title": "接口 A 压测"},
                "matched_entry_count": 2,
                "top_score": 30
            },
            {
                "bucket": {"id": "bucket-b", "title": "网关性能回归"},
                "matched_entry_count": 1,
                "top_score": 15
            }
        ],
        "evidence": [
            {
                "id": "memory-a1",
                "bucket_id": "bucket-a",
                "entry_id": "entry-a1",
                "kind": "entity",
                "text": "接口 A",
                "status": "active",
                "due_at": null,
                "occurred_at": null,
                "source": "test",
                "reason": "test evidence",
                "created_at": "2026-08-01 12:00:00",
                "updated_at": "2026-08-01 12:00:00",
                "metadata": {}
            }
        ],
        "answer": "共找到 3 条 Entry，分布在 2 个 Bucket。"
    })
}

fn assert_multi_bucket_search_output(output: &Value) {
    assert_eq!(output["total_entries"], json!(3));
    assert_eq!(output["total_buckets"], json!(2));
    assert_eq!(output["query_plan"]["entity_terms"], json!(["接口 A"]));
    assert_eq!(output["query_plan"]["topic_terms"], json!(["压测结果"]));
    assert_eq!(output["query_plan"]["statuses"], json!(["active"]));

    let buckets = output["buckets"]
        .as_array()
        .expect("search output should group results by Bucket");
    assert_eq!(buckets.len(), 2);
    assert_eq!(buckets[0]["matched_entry_count"], json!(2));
    assert_eq!(buckets[0]["top_score"], json!(30));
    assert_eq!(buckets[1]["matched_entry_count"], json!(1));
    assert_eq!(buckets[1]["top_score"], json!(15));
    assert!(!buckets[0].as_object().unwrap().contains_key("entries"));

    let results = output["results"]
        .as_array()
        .expect("search output should expose Entry-level results");
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["entry"]["id"], json!("entry-a1"));
    assert_eq!(results[1]["entry"]["id"], json!("entry-a2"));
    assert_eq!(results[2]["entry"]["id"], json!("entry-b1"));
    assert!(results.iter().all(|result| result["entry"].is_object()));
}
