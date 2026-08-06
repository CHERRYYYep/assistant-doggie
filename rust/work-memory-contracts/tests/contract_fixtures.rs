use std::fs;
use std::path::PathBuf;

use serde_json::{Value, json};
use work_memory_contracts::{
    AgentToolArguments, AgentTurnContract, ArchiveContract, BucketSearchResultContract,
    BucketSummaryContract, BucketViewContract, ChatMessageContract, ClassificationContract,
    ExtractionContract, MAX_AGENT_QUERY_CHARS, SEARCH_MEMORY_TOOL, agent_tool_definition,
};

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/contract_cases.json");
    let json = fs::read_to_string(path).expect("shared contract fixture should be readable");
    serde_json::from_str(&json).expect("shared contract fixture should be valid JSON")
}

fn normalized(contract: &str, case: &Value) -> Result<Value, String> {
    let input = case["input"].clone();
    match contract {
        "classification" => ClassificationContract::from_value(input)
            .and_then(|value| value.to_value())
            .map_err(|error| error.to_string()),
        "extraction" => ExtractionContract::from_value(input)
            .and_then(|value| value.to_value())
            .map_err(|error| error.to_string()),
        "bucket_summary" => BucketSummaryContract::from_value(input)
            .map(|value| value.to_value())
            .map_err(|error| error.to_string()),
        "archive" => ArchiveContract::from_value(input)
            .and_then(|value| value.to_value())
            .map_err(|error| error.to_string()),
        "bucket_view" => BucketViewContract::from_value(input)
            .and_then(|value| value.to_value())
            .map_err(|error| error.to_string()),
        "chat_message" => ChatMessageContract::from_value(input)
            .map(|value| value.to_value())
            .map_err(|error| error.to_string()),
        "agent_turn" => AgentTurnContract::from_value(input)
            .map(|value| value.to_value())
            .map_err(|error| error.to_string()),
        "bucket_search" => BucketSearchResultContract::from_value(input)
            .map(|value| value.to_value())
            .map_err(|error| error.to_string()),
        "agent_tool_arguments" => {
            let tool = case["tool"]
                .as_str()
                .expect("tool argument fixture should include a tool name");
            AgentToolArguments::from_value(tool, input)
                .map(|value| value.to_value())
                .map_err(|error| error.to_string())
        }
        name => panic!("unsupported contract fixture: {name}"),
    }
}

#[test]
fn valid_cases_match_python_normalization() {
    let fixture = fixture();
    let suites = fixture
        .as_object()
        .expect("contract fixture root should be an object");

    for (contract, suite) in suites {
        let cases = suite["valid"]
            .as_array()
            .expect("valid contract cases should be an array");
        for case in cases {
            let id = case["id"].as_str().expect("case should have an id");
            let actual = normalized(contract, case)
                .unwrap_or_else(|error| panic!("{contract}:{id} was rejected: {error}"));
            assert_eq!(actual, case["expected"], "{contract}:{id}");
        }
    }
}

#[test]
fn invalid_cases_are_rejected() {
    let fixture = fixture();
    let suites = fixture
        .as_object()
        .expect("contract fixture root should be an object");

    for (contract, suite) in suites {
        let cases = suite["invalid"]
            .as_array()
            .expect("invalid contract cases should be an array");
        for case in cases {
            let id = case["id"].as_str().expect("case should have an id");
            assert!(
                normalized(contract, case).is_err(),
                "{contract}:{id} should be rejected"
            );
        }
    }
}

#[test]
fn search_memory_description_covers_natural_language_query_dimensions_and_cardinality() {
    let definition =
        agent_tool_definition(SEARCH_MEMORY_TOOL).expect("search_memory must be registered");
    assert_eq!(definition.required, &["query"]);
    assert_eq!(definition.properties.len(), 1);
    assert_eq!(definition.properties[0].name, "query");

    let description = format!(
        "{} {}",
        definition.description,
        definition.properties[0]
            .description
            .expect("query description should guide the model")
    );
    for phrase in [
        "自然语言",
        "Bucket 名称",
        "Entry 原文",
        "summary",
        "tag",
        "entity",
        "时间范围",
        "状态",
        "结构化字段",
        "多条 Entry",
        "多个 Bucket",
    ] {
        assert!(
            description.contains(phrase),
            "missing search contract phrase: {phrase}"
        );
    }
    assert!(description.contains("接口 A 最近两周的压测结果"));

    let schema = definition.parameters_schema();
    assert_eq!(schema["type"], json!("object"));
    assert_eq!(schema["required"], json!(["query"]));
    assert_eq!(schema["additionalProperties"], json!(false));
    assert_eq!(schema["properties"]["query"]["type"], json!("string"));
}

#[test]
fn search_memory_accepts_full_natural_language_queries_and_round_trips_them() {
    let query = " 查询接口 A 最近两周的压测结果，并只看 active 状态 ";
    let arguments = AgentToolArguments::from_value(SEARCH_MEMORY_TOOL, json!({"query": query}))
        .expect("natural-language search query should be accepted");

    assert_eq!(arguments.tool_name(), SEARCH_MEMORY_TOOL);
    assert_eq!(
        arguments.to_value(),
        json!({"query": "查询接口 A 最近两周的压测结果，并只看 active 状态"})
    );
}

#[test]
fn search_memory_keeps_strict_argument_validation_and_query_length_bounds() {
    for (case, input) in [
        ("missing query", json!({})),
        ("empty query", json!({"query": " \n\t "})),
        ("unknown field", json!({"query": "接口 A", "limit": 20})),
        ("non-string query", json!({"query": 42})),
    ] {
        assert!(
            AgentToolArguments::from_value(SEARCH_MEMORY_TOOL, input).is_err(),
            "{case} must be rejected by the search_memory contract"
        );
    }

    let max_query = "界".repeat(MAX_AGENT_QUERY_CHARS);
    let accepted = AgentToolArguments::from_value(SEARCH_MEMORY_TOOL, json!({"query": max_query}))
        .expect("query at the contract limit should be accepted");
    assert_eq!(
        accepted.to_value()["query"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        MAX_AGENT_QUERY_CHARS
    );

    let too_long_query = "界".repeat(MAX_AGENT_QUERY_CHARS + 1);
    assert!(
        AgentToolArguments::from_value(SEARCH_MEMORY_TOOL, json!({"query": too_long_query}))
            .is_err(),
        "query over the contract limit must be rejected"
    );
}
