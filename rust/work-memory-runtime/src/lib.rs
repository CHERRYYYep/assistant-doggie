//! The canonical Rust application runtime.
//!
//! This crate is the composition boundary between the Rust-owned SQLite
//! schema, deterministic classification policy, the LLM adapters, and the
//! transport-independent Agent Harness. The legacy Python-compatible store is
//! intentionally not used here.

use std::fmt::Display;

use serde_json::{Value, json};
use thiserror::Error;
use work_memory_agent::{
    AGENT_SYSTEM_PROMPT, AgentHarness, AgentHarnessError, AgentHarnessRequest, AgentHistoryMessage,
    AgentToolExecution, AgentToolExecutor, LlmError, StructuredOutputAdapter,
    StructuredOutputTransport,
};
use work_memory_contracts::{
    AgentToolArguments, ChatRole, ClassificationContract, ExtractionContract,
};
use work_memory_core::{
    BucketType, BucketView, ClassificationAction, ClassificationResult, ConfidencePolicy,
    ExtractionResult,
};
use work_memory_service::{CanonicalService, CanonicalServiceError};
use work_memory_store::{
    RustArchiveAudit, RustArchiveOutcome, RustBucket, RustBucketDetail, RustChatMessage, RustEntry,
    RustSearchHit, StoreError,
};

/// Prompt version persisted in canonical archive audit rows.
pub const RUNTIME_PROMPT_VERSION: &str = "rust-runtime-v1";
/// Maximum number of active Buckets included in one classifier context.
pub const DEFAULT_ACTIVE_BUCKET_LIMIT: usize = 20;
/// Default model retry count for structured classification/extraction calls.
pub const DEFAULT_STRUCTURED_OUTPUT_RETRIES: usize = 2;
/// Default number of chat messages loaded into one Agent context.
pub const DEFAULT_CHAT_HISTORY_LIMIT: usize = 40;

/// The model boundary used by the canonical archive coordinator.
///
/// Implementations must return validated domain values. The runtime still
/// applies server-side candidate, confidence, and low-information gates before
/// any write, so a model implementation cannot bypass persistence policy.
pub trait MemoryModel {
    type Error: Display;

    fn classify(
        &mut self,
        text: &str,
        candidates: &[BucketView],
    ) -> Result<ClassificationResult, Self::Error>;

    fn extract(&mut self, text: &str) -> Result<ExtractionResult, Self::Error>;
}

/// A production model implementation backed by the existing strict structured
/// output adapter. Tests can instead implement [`MemoryModel`] with a fixed
/// deterministic response and never call a real API.
pub struct StructuredMemoryModel<T> {
    adapter: StructuredOutputAdapter<T>,
    model_name: String,
    policy: ConfidencePolicy,
    max_retries: usize,
}

impl<T: StructuredOutputTransport> StructuredMemoryModel<T> {
    pub fn new(
        adapter: StructuredOutputAdapter<T>,
        model_name: impl Into<String>,
        policy: ConfidencePolicy,
        max_retries: usize,
    ) -> Result<Self, RuntimeError> {
        let model_name = non_empty(model_name.into(), "model_name")?;
        Ok(Self {
            adapter,
            model_name,
            policy,
            max_retries,
        })
    }

    pub fn adapter(&self) -> &StructuredOutputAdapter<T> {
        &self.adapter
    }

    pub fn adapter_mut(&mut self) -> &mut StructuredOutputAdapter<T> {
        &mut self.adapter
    }

    pub fn policy(&self) -> ConfidencePolicy {
        self.policy
    }

    pub fn model_name(&self) -> &str {
        &self.model_name
    }
}

impl<T> MemoryModel for StructuredMemoryModel<T>
where
    T: StructuredOutputTransport,
{
    type Error = LlmError;

    fn classify(
        &mut self,
        text: &str,
        candidates: &[BucketView],
    ) -> Result<ClassificationResult, Self::Error> {
        let candidate_values = candidates
            .iter()
            .map(bucket_view_to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(LlmError::Contract)?;
        let user_prompt = serde_json::to_string(&json!({
            "text": text,
            "candidates": candidate_values,
        }))
        .map_err(LlmError::InvalidJson)?;
        let contract = self.adapter.parse::<ClassificationContract>(
            &self.model_name,
            CLASSIFICATION_SYSTEM_PROMPT,
            &user_prompt,
            self.max_retries,
        )?;
        Ok(contract.into_inner())
    }

    fn extract(&mut self, text: &str) -> Result<ExtractionResult, Self::Error> {
        let user_prompt =
            serde_json::to_string(&json!({"text": text})).map_err(LlmError::InvalidJson)?;
        let contract = self.adapter.parse::<ExtractionContract>(
            &self.model_name,
            EXTRACTION_SYSTEM_PROMPT,
            &user_prompt,
            self.max_retries,
        )?;
        Ok(contract.into_inner())
    }
}

/// Structured-output prompt boundary. The persisted audit stores only the
/// stable version string, not these full prompts.
const CLASSIFICATION_SYSTEM_PROMPT: &str = r#"你是工作记忆分类器。只返回符合 ClassificationResult schema 的 JSON。
候选 Bucket 是服务端提供的唯一有效 ID。优先使用唯一且明确匹配的候选；无法安全判断时使用 ask_user。不要臆造 Bucket ID。"#;
const EXTRACTION_SYSTEM_PROMPT: &str = r#"你是工作记忆提取器。只返回符合 ExtractionResult schema 的 JSON。
完整保留用户事实，不要把建议、猜测或助手内容伪装成已发生事实；时间表达式保留用户原文。"#;

/// A bounded archive coordinator around the canonical store.
pub struct CanonicalArchiveCoordinator<'a, M> {
    service: &'a mut CanonicalService,
    model: &'a mut M,
    policy: ConfidencePolicy,
    model_name: String,
    prompt_version: String,
    current_focus_bucket_id: Option<String>,
    active_bucket_limit: usize,
}

impl<'a, M: MemoryModel> CanonicalArchiveCoordinator<'a, M> {
    pub fn new(
        service: &'a mut CanonicalService,
        model: &'a mut M,
        policy: ConfidencePolicy,
        model_name: impl Into<String>,
        prompt_version: impl Into<String>,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            service,
            model,
            policy,
            model_name: non_empty(model_name.into(), "model_name")?,
            prompt_version: non_empty(prompt_version.into(), "prompt_version")?,
            current_focus_bucket_id: None,
            active_bucket_limit: DEFAULT_ACTIVE_BUCKET_LIMIT,
        })
    }

    pub fn with_focus_bucket(mut self, bucket_id: Option<String>) -> Self {
        self.current_focus_bucket_id = bucket_id.filter(|value| !value.trim().is_empty());
        self
    }

    pub fn with_active_bucket_limit(mut self, limit: usize) -> Result<Self, RuntimeError> {
        if limit == 0 {
            return Err(RuntimeError::InvalidLimit {
                field: "active_bucket_limit",
            });
        }
        self.active_bucket_limit = limit;
        Ok(self)
    }

    /// Classify, apply all deterministic gates, optionally extract, and write
    /// one canonical archive attempt. `ask_user` creates only the audit row.
    pub fn archive(&mut self, text: &str) -> Result<ArchiveExecution, RuntimeError> {
        let text = required_text(text, "text")?;
        let buckets = self.service.list_active_buckets(self.active_bucket_limit)?;
        let candidates = self.service.active_bucket_views(
            self.active_bucket_limit,
            self.current_focus_bucket_id.as_deref(),
        )?;
        let raw_classification = self
            .model
            .classify(&text, &candidates)
            .map_err(model_error)?;
        let classification = self.service.postprocess_classification_with_candidates(
            &text,
            raw_classification,
            &candidates,
            self.policy,
        )?;
        self.archive_classification(&text, classification, candidates, buckets)
    }

    /// Persist an explicitly confirmed append. Confirmation is represented by
    /// the caller selecting this method; the Agent executor adds a separate
    /// per-turn confirmation guard before calling it.
    pub fn append_confirmed(
        &mut self,
        bucket_id: &str,
        text: &str,
    ) -> Result<ArchiveExecution, RuntimeError> {
        let text = required_text(text, "text")?;
        let bucket = self
            .service
            .get_bucket(bucket_id)?
            .ok_or_else(|| RuntimeError::MissingBucket(bucket_id.to_owned()))?;
        let classification = ClassificationResult::append_existing(
            bucket.id.clone(),
            Some(bucket.bucket_type),
            1.0,
            "用户已明确确认目标 Bucket。",
            vec![bucket.id.clone()],
        )?;
        let extraction = self.model.extract(&text).map_err(model_error)?;
        let audit = RustArchiveAudit::new(
            vec![bucket.id.clone()],
            self.current_focus_bucket_id.clone(),
            self.prompt_version.clone(),
            self.model_name.clone(),
        )?;
        let outcome = self.service.archive(
            text,
            classification.clone(),
            Some(extraction.clone()),
            audit,
        )?;
        Ok(ArchiveExecution {
            outcome,
            classification,
            extraction: Some(extraction),
            bucket: Some(bucket),
        })
    }

    /// Persist an explicitly confirmed new Bucket and its first Entry.
    pub fn create_confirmed(
        &mut self,
        title: &str,
        bucket_type: BucketType,
        text: &str,
    ) -> Result<ArchiveExecution, RuntimeError> {
        let title = required_text(title, "title")?;
        let text = required_text(text, "text")?;
        let classification = ClassificationResult::create_new(
            bucket_type,
            title.to_owned(),
            1.0,
            "用户已明确确认创建新 Bucket。",
            Vec::new(),
        )?;
        let extraction = self.model.extract(&text).map_err(model_error)?;
        let audit = RustArchiveAudit::new(
            Vec::new(),
            self.current_focus_bucket_id.clone(),
            self.prompt_version.clone(),
            self.model_name.clone(),
        )?;
        let outcome = self.service.archive(
            text,
            classification.clone(),
            Some(extraction.clone()),
            audit,
        )?;
        let bucket_id = outcome
            .bucket_id
            .as_deref()
            .ok_or(RuntimeError::MissingArchiveBucket)?;
        let bucket = self
            .service
            .get_bucket(bucket_id)?
            .ok_or_else(|| RuntimeError::MissingBucket(bucket_id.to_owned()))?;
        Ok(ArchiveExecution {
            outcome,
            classification,
            extraction: Some(extraction),
            bucket: Some(bucket),
        })
    }

    fn archive_classification(
        &mut self,
        text: &str,
        classification: ClassificationResult,
        candidates: Vec<BucketView>,
        buckets: Vec<RustBucket>,
    ) -> Result<ArchiveExecution, RuntimeError> {
        let extraction = if classification.action() == ClassificationAction::AskUser {
            None
        } else {
            Some(self.model.extract(text).map_err(model_error)?)
        };
        let audit = RustArchiveAudit::new(
            candidates
                .iter()
                .map(|candidate| candidate.id().to_owned())
                .collect(),
            self.current_focus_bucket_id.clone(),
            self.prompt_version.clone(),
            self.model_name.clone(),
        )?;
        let outcome =
            self.service
                .archive(text, classification.clone(), extraction.clone(), audit)?;
        let bucket = match outcome.bucket_id.as_deref() {
            Some(id) => match buckets.iter().find(|bucket| bucket.id == id).cloned() {
                Some(bucket) => Some(bucket),
                None => Some(
                    self.service
                        .get_bucket(id)?
                        .ok_or_else(|| RuntimeError::MissingBucket(id.to_owned()))?,
                ),
            },
            None => None,
        };
        Ok(ArchiveExecution {
            outcome,
            classification,
            extraction,
            bucket,
        })
    }
}

/// Store result plus the validated classification/extraction used to create it.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchiveExecution {
    pub outcome: RustArchiveOutcome,
    pub classification: ClassificationResult,
    pub extraction: Option<ExtractionResult>,
    pub bucket: Option<RustBucket>,
}

/// One allow-listed tool executor connected to the canonical Rust store.
pub struct CanonicalAgentToolExecutor<'a, M> {
    service: &'a mut CanonicalService,
    model: &'a mut M,
    policy: ConfidencePolicy,
    model_name: String,
    prompt_version: String,
    current_focus_bucket_id: Option<String>,
    confirmation_granted: bool,
    active_bucket_limit: usize,
}

impl<'a, M: MemoryModel> CanonicalAgentToolExecutor<'a, M> {
    pub fn new(
        service: &'a mut CanonicalService,
        model: &'a mut M,
        policy: ConfidencePolicy,
        model_name: impl Into<String>,
        prompt_version: impl Into<String>,
        confirmation_granted: bool,
    ) -> Result<Self, RuntimeError> {
        let model_name = non_empty(model_name.into(), "model_name")?;
        let prompt_version = non_empty(prompt_version.into(), "prompt_version")?;
        Ok(Self {
            service,
            model,
            policy,
            model_name,
            prompt_version,
            current_focus_bucket_id: None,
            confirmation_granted,
            active_bucket_limit: DEFAULT_ACTIVE_BUCKET_LIMIT,
        })
    }

    pub fn with_focus_bucket(mut self, bucket_id: Option<String>) -> Self {
        self.current_focus_bucket_id = bucket_id.filter(|value| !value.trim().is_empty());
        self
    }

    pub fn with_active_bucket_limit(mut self, limit: usize) -> Result<Self, RuntimeError> {
        if limit == 0 {
            return Err(RuntimeError::InvalidLimit {
                field: "active_bucket_limit",
            });
        }
        self.active_bucket_limit = limit;
        Ok(self)
    }

    fn archive_coordinator(&mut self) -> Result<CanonicalArchiveCoordinator<'_, M>, RuntimeError> {
        CanonicalArchiveCoordinator::new(
            self.service,
            self.model,
            self.policy,
            self.model_name.clone(),
            self.prompt_version.clone(),
        )
        .map(|coordinator| coordinator.with_focus_bucket(self.current_focus_bucket_id.clone()))
    }
}

impl<M: MemoryModel> AgentToolExecutor for CanonicalAgentToolExecutor<'_, M> {
    fn execute(&mut self, arguments: AgentToolArguments) -> Result<Value, String> {
        self.execute_inner(arguments)
            .map_err(|error| error.to_string())
    }
}

impl<M: MemoryModel> CanonicalAgentToolExecutor<'_, M> {
    fn execute_inner(&mut self, arguments: AgentToolArguments) -> Result<Value, RuntimeError> {
        match arguments {
            AgentToolArguments::ListActiveBuckets => {
                let buckets = self.service.list_active_buckets(self.active_bucket_limit)?;
                Ok(
                    json!({"ok": true, "buckets": buckets.iter().map(rust_bucket_to_value).collect::<Result<Vec<_>, _>>()?}),
                )
            }
            AgentToolArguments::SearchMemory { query } => {
                let hits = self.service.search(&query, self.active_bucket_limit)?;
                Ok(
                    json!({"ok": true, "results": hits.iter().map(search_hit_to_value).collect::<Result<Vec<_>, _>>()?}),
                )
            }
            AgentToolArguments::GetBucketDetail { bucket_id } => {
                let detail = self
                    .service
                    .bucket_detail(&bucket_id)?
                    .ok_or_else(|| RuntimeError::MissingBucket(bucket_id.clone()))?;
                Ok(json!({"ok": true, "detail": bucket_detail_to_value(&detail)?}))
            }
            AgentToolArguments::ArchiveMemory { text } => {
                let mut coordinator = self.archive_coordinator()?;
                let execution = coordinator.archive(&text)?;
                Ok(archive_execution_to_value(&execution)?)
            }
            AgentToolArguments::SaveToExistingBucket { bucket_id, text } => {
                if !self.confirmation_granted {
                    return Err(RuntimeError::ConfirmationRequired);
                }
                let mut coordinator = self.archive_coordinator()?;
                let execution = coordinator.append_confirmed(&bucket_id, &text)?;
                Ok(archive_execution_to_value(&execution)?)
            }
            AgentToolArguments::CreateBucketAndSave {
                title,
                bucket_type,
                text,
            } => {
                if !self.confirmation_granted {
                    return Err(RuntimeError::ConfirmationRequired);
                }
                let mut coordinator = self.archive_coordinator()?;
                let execution = coordinator.create_confirmed(&title, bucket_type, &text)?;
                Ok(archive_execution_to_value(&execution)?)
            }
        }
    }
}

/// Input for one complete persisted canonical Agent turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRequest {
    pub user_text: String,
    pub model: String,
    pub system_prompt: String,
    pub current_focus_bucket_id: Option<String>,
    pub confirmation_granted: bool,
    pub max_tool_rounds: usize,
    pub history_limit: usize,
}

impl TurnRequest {
    pub fn new(
        user_text: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            user_text: required_text(user_text.into(), "user_text")?,
            model: required_text(model.into(), "model")?,
            system_prompt: AGENT_SYSTEM_PROMPT.to_owned(),
            current_focus_bucket_id: None,
            confirmation_granted: false,
            max_tool_rounds: work_memory_agent::DEFAULT_AGENT_MAX_TOOL_ROUNDS,
            history_limit: DEFAULT_CHAT_HISTORY_LIMIT,
        })
    }

    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Result<Self, RuntimeError> {
        self.system_prompt = required_text(prompt.into(), "system_prompt")?;
        Ok(self)
    }

    pub fn with_focus_bucket(mut self, bucket_id: Option<String>) -> Self {
        self.current_focus_bucket_id = bucket_id.filter(|value| !value.trim().is_empty());
        self
    }

    pub const fn with_confirmation(mut self, granted: bool) -> Self {
        self.confirmation_granted = granted;
        self
    }

    pub fn with_limits(
        mut self,
        max_tool_rounds: usize,
        history_limit: usize,
    ) -> Result<Self, RuntimeError> {
        if history_limit == 0
            || history_limit > work_memory_agent::MAX_AGENT_HISTORY_MESSAGES
            || max_tool_rounds > work_memory_agent::MAX_AGENT_TOOL_ROUNDS
        {
            return Err(RuntimeError::InvalidLimit {
                field: "turn_limits",
            });
        }
        self.max_tool_rounds = max_tool_rounds;
        self.history_limit = history_limit;
        Ok(self)
    }
}

/// Canonical runtime owning the application store and composing a model with
/// the existing Agent Harness.
pub struct CanonicalRuntime<M, T> {
    service: CanonicalService,
    model: M,
    harness: AgentHarness<T>,
    policy: ConfidencePolicy,
    model_name: String,
    prompt_version: String,
}

impl<M, T> CanonicalRuntime<M, T> {
    pub fn new(
        service: CanonicalService,
        model: M,
        harness: AgentHarness<T>,
        policy: ConfidencePolicy,
        model_name: impl Into<String>,
        prompt_version: impl Into<String>,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            service,
            model,
            harness,
            policy,
            model_name: non_empty(model_name.into(), "model_name")?,
            prompt_version: non_empty(prompt_version.into(), "prompt_version")?,
        })
    }

    pub fn service(&self) -> &CanonicalService {
        &self.service
    }

    pub fn service_mut(&mut self) -> &mut CanonicalService {
        &mut self.service
    }

    pub fn harness(&self) -> &AgentHarness<T> {
        &self.harness
    }

    pub fn harness_mut(&mut self) -> &mut AgentHarness<T> {
        &mut self.harness
    }
}

impl<M, T> CanonicalRuntime<M, T>
where
    M: MemoryModel,
    T: StructuredOutputTransport,
{
    /// Persist the user message, run the bounded Agent loop against canonical
    /// tools, persist tool activity, and only then persist a successful answer.
    pub fn run_turn(&mut self, request: &TurnRequest) -> Result<TurnOutcome, RuntimeError> {
        let user_text = required_text(request.user_text.clone(), "user_text")?;
        let prior_history = self.service.list_chat_messages(request.history_limit)?;
        self.service
            .append_chat_message(ChatRole::User, user_text.clone(), None, None, None)?;
        let mut history = prior_history
            .into_iter()
            .map(chat_to_history)
            .collect::<Result<Vec<_>, _>>()?;
        history.push(AgentHistoryMessage::new(ChatRole::User, user_text.clone())?);
        let active_buckets = self
            .service
            .list_active_buckets(DEFAULT_ACTIVE_BUCKET_LIMIT)?;
        let memory_context =
            memory_context_to_string(&active_buckets, request.current_focus_bucket_id.as_deref())?;
        let harness_request = AgentHarnessRequest::new(
            request.model.clone(),
            request.system_prompt.clone(),
            memory_context,
            history,
            request.max_tool_rounds,
        )?;
        let mut executor = CanonicalAgentToolExecutor::new(
            &mut self.service,
            &mut self.model,
            self.policy,
            self.model_name.clone(),
            self.prompt_version.clone(),
            request.confirmation_granted,
        )?
        .with_focus_bucket(request.current_focus_bucket_id.clone());
        let result = self.harness.run(&harness_request, &mut executor)?;
        let tool_messages = persist_tool_executions(&mut self.service, result.tool_executions())?;
        let assistant = self.service.append_chat_message(
            ChatRole::Assistant,
            result.assistant_text().to_owned(),
            None,
            None,
            None,
        )?;
        Ok(TurnOutcome {
            assistant,
            tool_messages,
            tool_executions: result.tool_executions().to_vec(),
        })
    }
}

/// Successful durable turn projection.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnOutcome {
    pub assistant: RustChatMessage,
    pub tool_messages: Vec<RustChatMessage>,
    pub tool_executions: Vec<AgentToolExecution>,
}

/// Read-only API projection helpers used by the future HTTP server/UI.
pub fn active_buckets(service: &CanonicalService, limit: usize) -> Result<Value, RuntimeError> {
    Ok(json!({
        "buckets": service
            .list_active_buckets(limit)?
            .iter()
            .map(rust_bucket_to_value)
            .collect::<Result<Vec<_>, _>>()?
    }))
}

pub fn search_memory(
    service: &CanonicalService,
    query: &str,
    limit: usize,
) -> Result<Value, RuntimeError> {
    Ok(json!({
        "results": service
            .search(query, limit)?
            .iter()
            .map(search_hit_to_value)
            .collect::<Result<Vec<_>, _>>()?
    }))
}

pub fn bucket_detail(
    service: &CanonicalService,
    bucket_id: &str,
) -> Result<Option<Value>, RuntimeError> {
    service
        .bucket_detail(bucket_id)?
        .map(|detail| bucket_detail_to_value(&detail))
        .transpose()
}

fn persist_tool_executions(
    service: &mut CanonicalService,
    executions: &[AgentToolExecution],
) -> Result<Vec<RustChatMessage>, RuntimeError> {
    executions
        .iter()
        .map(|execution| {
            let output = execution.output().to_string();
            let details = json!({
                "arguments": execution.arguments(),
                "output": execution.output(),
            });
            service
                .append_chat_message(
                    ChatRole::Tool,
                    output,
                    Some(execution.name().to_owned()),
                    Some(execution.call_id().to_owned()),
                    Some(details),
                )
                .map_err(RuntimeError::from)
        })
        .collect()
}

fn chat_to_history(message: RustChatMessage) -> Result<AgentHistoryMessage, RuntimeError> {
    AgentHistoryMessage::new(message.role, message.content).map_err(RuntimeError::from)
}

fn memory_context_to_string(
    buckets: &[RustBucket],
    focus_bucket_id: Option<&str>,
) -> Result<String, RuntimeError> {
    Ok(serde_json::to_string(&json!({
        "current_focus_bucket_id": focus_bucket_id,
        "active_buckets": buckets
            .iter()
            .map(rust_bucket_to_value)
            .collect::<Result<Vec<_>, _>>()?,
    }))?)
}

fn bucket_view_to_value(view: &BucketView) -> Result<Value, work_memory_contracts::ContractError> {
    Ok(json!({
        "id": view.id(),
        "title": view.title(),
        "type": view.bucket_type().as_str(),
        "status": view.status().as_str(),
        "summary": view.summary(),
        "tags": view.tags(),
        "last_active_at": view.last_active_at_unix_ms(),
    }))
}

fn rust_bucket_to_value(bucket: &RustBucket) -> Result<Value, RuntimeError> {
    Ok(json!({
        "id": bucket.id,
        "title": bucket.title,
        "type": bucket.bucket_type.as_str(),
        "status": bucket.status.as_str(),
        "summary": bucket.summary,
        "tags": bucket.tags,
        "created_at": bucket.created_at.raw(),
        "updated_at": bucket.updated_at.raw(),
        "last_active_at": bucket.last_active_at.raw(),
        "archived_at": bucket.archived_at.as_ref().map(|value| value.raw()),
    }))
}

fn search_hit_to_value(hit: &RustSearchHit) -> Result<Value, RuntimeError> {
    Ok(json!({
        "bucket": rust_bucket_to_value(&hit.bucket)?,
        "matched_entry_count": hit.matched_entry_count,
        "score": hit.score,
    }))
}

fn bucket_detail_to_value(detail: &RustBucketDetail) -> Result<Value, RuntimeError> {
    Ok(json!({
        "bucket": rust_bucket_to_value(&detail.bucket)?,
        "entries": detail.entries.iter().map(entry_to_value).collect::<Result<Vec<_>, _>>()?,
        "memories": detail.memories.iter().map(|memory| json!({
            "id": memory.id,
            "bucket_id": memory.bucket_id,
            "entry_id": memory.entry_id,
            "kind": memory.kind.as_str(),
            "text": memory.text,
            "status": memory.status,
            "due_at": memory.due_at.as_ref().map(|value| value.raw()),
            "occurred_at": memory.occurred_at,
            "source": memory.source,
            "reason": memory.reason,
            "created_at": memory.created_at.raw(),
            "updated_at": memory.updated_at.raw(),
            "metadata": memory.metadata,
        })).collect::<Vec<_>>(),
    }))
}

fn entry_to_value(entry: &RustEntry) -> Result<Value, RuntimeError> {
    Ok(json!({
        "id": entry.id,
        "bucket_id": entry.bucket_id,
        "raw_text": entry.raw_text,
        "summary": entry.summary,
        "content_type": entry.content_type,
        "classification_confidence": entry.classification_confidence,
        "classification_reason": entry.classification_reason,
        "created_at": entry.created_at.raw(),
        "moved_from_bucket_id": entry.moved_from_bucket_id,
        "archive_state": entry.archive_state,
        "archived_at": entry.archived_at.raw(),
    }))
}

fn archive_execution_to_value(execution: &ArchiveExecution) -> Result<Value, RuntimeError> {
    Ok(json!({
        "ok": true,
        "attempt_id": execution.outcome.attempt_id,
        "archive_state": execution.outcome.archive_state,
        "bucket_id": execution.outcome.bucket_id,
        "entry_id": execution.outcome.entry_id,
        "memory_item_ids": execution.outcome.memory_item_ids,
        "action": execution.classification.action().as_str(),
        "confidence": execution.classification.confidence(),
        "reason": execution.classification.reason(),
        "question": execution.classification.question(),
        "candidate_bucket_ids": execution.classification.candidate_bucket_ids(),
        "bucket": execution.bucket.as_ref().map(rust_bucket_to_value).transpose()?,
        "extraction": execution.extraction.as_ref().map(extraction_to_value),
    }))
}

fn extraction_to_value(extraction: &ExtractionResult) -> Value {
    json!({
        "summary": extraction.summary(),
        "todos": extraction.todos(),
        "evidences": extraction.evidences(),
        "timeline_events": extraction.timeline_events().iter().map(|event| json!({
            "event_time": event.event_time(),
            "text": event.text(),
        })).collect::<Vec<_>>(),
        "decisions": extraction.decisions(),
        "hypotheses": extraction.hypotheses(),
        "entities": extraction.entities(),
        "tags": extraction.tags(),
    })
}

fn non_empty(value: String, field: &'static str) -> Result<String, RuntimeError> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(RuntimeError::EmptyField(field));
    }
    Ok(value)
}

fn required_text(value: impl Into<String>, field: &'static str) -> Result<String, RuntimeError> {
    non_empty(value.into(), field)
}

fn model_error<E: Display>(error: E) -> RuntimeError {
    RuntimeError::Model(error.to_string())
}

/// Errors at the canonical runtime boundary.
#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("{0} must not be empty")]
    EmptyField(&'static str),
    #[error("invalid runtime limit for {field}")]
    InvalidLimit { field: &'static str },
    #[error("Bucket does not exist: {0}")]
    MissingBucket(String),
    #[error("archive did not create or select a Bucket")]
    MissingArchiveBucket,
    #[error("this write requires an explicit user confirmation")]
    ConfirmationRequired,
    #[error("canonical service error: {0}")]
    Canonical(#[from] CanonicalServiceError),
    #[error("domain error: {0}")]
    Core(#[from] work_memory_core::CoreError),
    #[error("contract error: {0}")]
    Contract(#[from] work_memory_contracts::ContractError),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("agent error: {0}")]
    Agent(#[from] AgentHarnessError),
    #[error("model error: {0}")]
    Model(String),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}
