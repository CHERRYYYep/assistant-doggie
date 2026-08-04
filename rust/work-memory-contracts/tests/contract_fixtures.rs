use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use work_memory_contracts::{
    AgentToolArguments, AgentTurnContract, ArchiveContract, BucketSearchResultContract,
    BucketSummaryContract, BucketViewContract, ChatMessageContract, ClassificationContract,
    ExtractionContract,
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
