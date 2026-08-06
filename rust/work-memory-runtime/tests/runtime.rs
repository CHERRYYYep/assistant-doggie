use std::collections::VecDeque;

use serde_json::{Value, json};
use tempfile::tempdir;
use work_memory_agent::{
    AgentHarness, AgentToolExecutor, LlmEndpointConfig, LlmHttpRequest, LlmHttpResponse,
    LlmTransportError, StructuredOutputTransport,
};
use work_memory_contracts::{AgentToolArguments, ChatRole};
use work_memory_core::{
    BucketType, ClassificationResult, ConfidencePolicy, ExtractionResult, TimelineEventExtract,
};
use work_memory_runtime::{
    CanonicalAgentToolExecutor, CanonicalArchiveCoordinator, CanonicalRuntime, MemoryModel,
    RuntimeError, TurnRequest,
};
use work_memory_service::CanonicalService;
use work_memory_store::RustBucketDetail;

struct FixedModel {
    classifications: VecDeque<Result<ClassificationResult, String>>,
    extractions: VecDeque<Result<ExtractionResult, String>>,
}

impl FixedModel {
    fn new(
        classifications: impl IntoIterator<Item = Result<ClassificationResult, String>>,
        extractions: impl IntoIterator<Item = Result<ExtractionResult, String>>,
    ) -> Self {
        Self {
            classifications: classifications.into_iter().collect(),
            extractions: extractions.into_iter().collect(),
        }
    }
}

impl MemoryModel for FixedModel {
    type Error = String;

    fn classify(
        &mut self,
        _text: &str,
        _candidates: &[work_memory_core::BucketView],
    ) -> Result<ClassificationResult, Self::Error> {
        self.classifications
            .pop_front()
            .expect("test model classification queue")
    }

    fn extract(&mut self, _text: &str) -> Result<ExtractionResult, Self::Error> {
        self.extractions
            .pop_front()
            .expect("test model extraction queue")
    }
}

struct FakeTransport {
    responses: VecDeque<Value>,
    requests: Vec<LlmHttpRequest>,
}

impl FakeTransport {
    fn new(responses: impl IntoIterator<Item = Value>) -> Self {
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
            .map(LlmHttpResponse::new)
            .ok_or_else(|| LlmTransportError::request("fake response queue exhausted"))
    }
}

fn endpoint() -> LlmEndpointConfig {
    LlmEndpointConfig::resolve(Some("official"), None, Some("responses")).expect("endpoint")
}

fn rich_extraction(summary: &str) -> ExtractionResult {
    ExtractionResult::new(
        summary,
        vec!["follow up".to_owned()],
        vec!["observed evidence".to_owned()],
        vec![
            TimelineEventExtract::new(Some("next week".to_owned()), "schedule review")
                .expect("timeline"),
        ],
        vec!["use the canonical store".to_owned()],
        vec!["the cutover is safe".to_owned()],
        vec!["Rust".to_owned()],
        vec!["canonical".to_owned()],
    )
    .expect("extraction")
}

fn service(path: &std::path::Path) -> CanonicalService {
    CanonicalService::initialize(path).expect("canonical service")
}

fn create_bucket(service: &mut CanonicalService, model: &mut FixedModel) -> String {
    let mut coordinator = CanonicalArchiveCoordinator::new(
        service,
        model,
        ConfidencePolicy::default(),
        "fixture-model",
        "runtime-test-v1",
    )
    .expect("coordinator");
    coordinator
        .archive("The payment callback was restored.")
        .expect("create bucket")
        .outcome
        .bucket_id
        .expect("bucket id")
}

#[test]
fn archive_writes_entry_structured_memories_and_audit_to_canonical_service() {
    let directory = tempdir().expect("tempdir");
    let mut service = service(&directory.path().join("canonical.db"));
    let classification = ClassificationResult::create_new(
        BucketType::Incident,
        "Payment callback",
        0.99,
        "new incident",
        vec![],
    )
    .expect("classification");
    let mut model = FixedModel::new(
        [Ok(classification)],
        [Ok(rich_extraction("callback restored"))],
    );

    let mut coordinator = CanonicalArchiveCoordinator::new(
        &mut service,
        &mut model,
        ConfidencePolicy::default(),
        "fixture-model",
        "runtime-test-v1",
    )
    .expect("coordinator");
    let execution = coordinator
        .archive("The payment callback was restored.")
        .expect("archive");

    assert_eq!(execution.outcome.archive_state, "archived");
    assert!(execution.outcome.entry_id.is_some());
    assert_eq!(execution.outcome.memory_item_ids.len(), 7);
    let counts = service.counts().expect("counts");
    assert_eq!(counts.buckets, 1);
    assert_eq!(counts.entries, 1);
    assert_eq!(counts.memory_items, 7);
    assert_eq!(counts.archive_attempts, 1);
    let bucket_id = execution.outcome.bucket_id.expect("bucket id");
    let detail = service
        .bucket_detail(&bucket_id)
        .expect("detail")
        .expect("bucket detail");
    assert_detail_contains_entry_and_memories(&detail, execution.outcome.entry_id.as_deref());
}

#[test]
fn low_confidence_and_invalid_bucket_reference_only_persist_confirmation_attempts() {
    let directory = tempdir().expect("tempdir");
    let mut service = service(&directory.path().join("canonical.db"));
    let first = ClassificationResult::create_new(
        BucketType::Task,
        "Payment follow-up",
        0.99,
        "seed",
        vec![],
    )
    .expect("first classification");
    let second = ClassificationResult::create_new(
        BucketType::Incident,
        "Payment incident",
        0.99,
        "seed",
        vec![],
    )
    .expect("second classification");
    let ambiguous = ClassificationResult::append_existing(
        "not-a-candidate",
        Some(BucketType::Task),
        0.99,
        "model guessed an invalid ID",
        vec!["not-a-candidate".to_owned()],
    )
    .expect("invalid classification");
    let mut model = FixedModel::new(
        [Ok(first), Ok(second), Ok(ambiguous)],
        [
            Ok(ExtractionResult::minimal("first summary").expect("first extraction")),
            Ok(ExtractionResult::minimal("second summary").expect("second extraction")),
        ],
    );

    let first_bucket = create_bucket(&mut service, &mut model);
    let second_bucket = create_bucket(&mut service, &mut model);
    assert_ne!(first_bucket, second_bucket);

    // The model-provided invalid ID is downgraded before persistence, so the
    // canonical store never receives an Entry request for it.
    let mut coordinator = CanonicalArchiveCoordinator::new(
        &mut service,
        &mut model,
        ConfidencePolicy::default(),
        "fixture-model",
        "runtime-test-v1",
    )
    .expect("coordinator");
    let invalid = coordinator
        .archive("A concrete payment fact.")
        .expect("attempt");
    assert_eq!(invalid.outcome.archive_state, "needs_confirmation");
    assert!(invalid.outcome.entry_id.is_none());
    assert!(invalid.extraction.is_none());

    // A valid target with low confidence is also held. Use the actual target
    // ID in the fixture model response by testing the deterministic service
    // gate directly through the model's next response construction.
    drop(coordinator);
    let low = ClassificationResult::append_existing(
        first_bucket.clone(),
        Some(BucketType::Task),
        0.40,
        "uncertain",
        vec![first_bucket],
    )
    .expect("low confidence classification");
    model.classifications.push_back(Ok(low));
    let mut coordinator = CanonicalArchiveCoordinator::new(
        &mut service,
        &mut model,
        ConfidencePolicy::default(),
        "fixture-model",
        "runtime-test-v1",
    )
    .expect("coordinator");
    let held = coordinator
        .archive("A concrete payment fact.")
        .expect("attempt");
    assert_eq!(held.outcome.archive_state, "needs_confirmation");
    assert!(held.outcome.entry_id.is_none());
    assert!(held.extraction.is_none());

    let counts = service.counts().expect("counts");
    assert_eq!(counts.buckets, 2);
    assert_eq!(counts.entries, 2);
    assert_eq!(counts.archive_attempts, 4);
}

#[test]
fn explicit_write_tools_require_confirmation_and_append_after_confirmation() {
    let directory = tempdir().expect("tempdir");
    let mut service = service(&directory.path().join("canonical.db"));
    let initial = ClassificationResult::create_new(
        BucketType::Task,
        "Canonical cutover",
        0.99,
        "seed",
        vec![],
    )
    .expect("classification");
    let mut model = FixedModel::new(
        [Ok(initial)],
        [
            Ok(ExtractionResult::minimal("seed summary").expect("seed extraction")),
            Ok(ExtractionResult::minimal("confirmed summary").expect("confirmed extraction")),
        ],
    );
    let bucket_id = create_bucket(&mut service, &mut model);

    let arguments = AgentToolArguments::SaveToExistingBucket {
        bucket_id: bucket_id.clone(),
        text: "The confirmed follow-up is complete.".to_owned(),
    };
    let mut blocked = CanonicalAgentToolExecutor::new(
        &mut service,
        &mut model,
        ConfidencePolicy::default(),
        "fixture-model",
        "runtime-test-v1",
        false,
    )
    .expect("executor");
    let error = blocked
        .execute(arguments.clone())
        .expect_err("confirmation must be required");
    assert!(error.contains("confirmation"));
    drop(blocked);
    assert_eq!(service.counts().expect("counts").entries, 1);

    let mut confirmed = CanonicalAgentToolExecutor::new(
        &mut service,
        &mut model,
        ConfidencePolicy::default(),
        "fixture-model",
        "runtime-test-v1",
        true,
    )
    .expect("executor");
    let result = work_memory_agent::AgentToolExecutor::execute(&mut confirmed, arguments)
        .expect("confirmed append");
    assert_eq!(result["ok"], json!(true));
    drop(confirmed);
    assert_eq!(service.counts().expect("counts").entries, 2);
}

#[test]
fn agent_turn_persists_current_user_tool_and_assistant_and_survives_reopen() {
    let directory = tempdir().expect("tempdir");
    let database = directory.path().join("canonical.db");
    let service = service(&database);
    let model = FixedModel::new([], []);
    let transport = FakeTransport::new([
        responses_tool_call("call-1", "list_active_buckets", "{}"),
        responses_text("当前没有需要写入的新记忆。"),
    ]);
    let harness = AgentHarness::new(endpoint(), transport);
    let mut runtime = CanonicalRuntime::new(
        service,
        model,
        harness,
        ConfidencePolicy::default(),
        "fixture-model",
        "runtime-test-v1",
    )
    .expect("runtime");
    let request = TurnRequest::new("请检查当前工作记忆。", "fixture-agent").expect("turn request");

    let outcome = runtime.run_turn(&request).expect("turn");
    assert_eq!(outcome.tool_messages.len(), 1);
    assert_eq!(outcome.assistant.role, ChatRole::Assistant);
    assert_eq!(outcome.tool_executions.len(), 1);
    assert_eq!(runtime.service().counts().expect("counts").chat_messages, 3);
    let first_request = &runtime.harness().transport().requests[0];
    let input = first_request.body()["input"].as_array().expect("input");
    assert!(input.iter().any(|message| {
        message["role"] == json!("user") && message["content"] == json!("请检查当前工作记忆。")
    }));
    drop(runtime);

    let reopened = CanonicalService::open_existing(&database).expect("reopen");
    let history = reopened.history(10).expect("history");
    assert_eq!(history.chat_messages.len(), 3);
    assert_eq!(history.chat_messages[0].role, ChatRole::User);
    assert_eq!(history.chat_messages[1].role, ChatRole::Tool);
    assert_eq!(history.chat_messages[2].role, ChatRole::Assistant);
}

fn assert_detail_contains_entry_and_memories(detail: &RustBucketDetail, entry_id: Option<&str>) {
    assert_eq!(detail.entries.len(), 1);
    assert_eq!(detail.entries[0].id.as_str(), entry_id.unwrap_or_default());
    assert_eq!(detail.memories.len(), 7);
}

fn responses_text(text: &str) -> Value {
    json!({
        "status": "completed",
        "output": [{
            "type": "message",
            "id": "msg-final",
            "role": "assistant",
            "status": "completed",
            "phase": "final_answer",
            "content": [{"type": "output_text", "annotations": [], "text": text}]
        }]
    })
}

fn responses_tool_call(call_id: &str, name: &str, arguments: &str) -> Value {
    json!({
        "status": "completed",
        "output": [{
            "type": "function_call",
            "id": format!("fc-{call_id}"),
            "call_id": call_id,
            "name": name,
            "arguments": arguments,
            "status": "completed"
        }]
    })
}

#[test]
fn turn_limits_are_bounded_before_loading_history() {
    let request = TurnRequest::new("check limits", "fixture-agent").expect("request");
    let error = request
        .with_limits(
            work_memory_agent::MAX_AGENT_TOOL_ROUNDS,
            work_memory_agent::MAX_AGENT_HISTORY_MESSAGES + 1,
        )
        .expect_err("history limit must not exceed the harness bound");
    assert!(matches!(
        error,
        RuntimeError::InvalidLimit {
            field: "turn_limits"
        }
    ));
}
