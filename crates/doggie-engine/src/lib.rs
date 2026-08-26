//! The Doggie engine for the local Web UI.
//!
//! This crate composes the Doggie-owned SQLite service, deterministic safety
//! gates, and structured model adapter into the complete archive loop.

use std::fmt::Display;

use doggie_application::{
    CanonicalService, CanonicalServiceError, MemoryBucketGroup, MemoryQuery, MemorySearchHit,
    MemorySearchResponse,
};
use doggie_domain::{
    BucketType, BucketView, ClassificationAction, ClassificationResult, ConfidencePolicy,
    ExtractionResult,
};
use doggie_llm::{LlmError, StructuredOutputAdapter, StructuredOutputTransport};
use doggie_protocol::{ClassificationContract, ExtractionContract};
use doggie_storage_sqlite::{
    DoggieArchiveAudit, DoggieArchiveOutcome, DoggieBucket, DoggieBucketDetail, DoggieEntry,
    DoggieSearchHit, StoreError,
};
use serde_json::{Value, json};
use thiserror::Error;

/// Prompt version persisted in canonical archive audit rows.
pub const RUNTIME_PROMPT_VERSION: &str = "doggie-engine-v1";
/// Maximum number of active Buckets included in one classifier context.
pub const DEFAULT_ACTIVE_BUCKET_LIMIT: usize = 20;
/// Default model retry count for structured classification/extraction calls.
pub const DEFAULT_STRUCTURED_OUTPUT_RETRIES: usize = 2;

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
候选 Bucket 是服务端根据最近活跃和热门程度自动提供的唯一有效 ID，不代表用户手动选择。优先使用唯一且明确匹配的候选；无法安全判断时使用 ask_user。
如果输入只有“那个/这个/它/上次/相关”等模糊指代，或只有“继续/更新了/完成了/好了/正常了/记一下”等低信息状态动作，且没有数字、指标、错误、日志、决定、原因或其他可核验事实，必须使用 ask_user，即使你很确定最像哪个 Bucket。不要臆造 Bucket ID。"#;
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
    confirmation_attempt_id: Option<String>,
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
            confirmation_attempt_id: None,
            active_bucket_limit: DEFAULT_ACTIVE_BUCKET_LIMIT,
        })
    }

    pub fn with_focus_bucket(mut self, bucket_id: Option<String>) -> Self {
        self.current_focus_bucket_id = bucket_id.filter(|value| !value.trim().is_empty());
        self
    }

    pub fn with_confirmation_attempt(mut self, attempt_id: Option<String>) -> Self {
        self.confirmation_attempt_id = attempt_id.filter(|value| !value.trim().is_empty());
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
        let candidates = self
            .service
            .active_bucket_views(self.active_bucket_limit, None)?;
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
        let audit = DoggieArchiveAudit::new(
            vec![bucket.id.clone()],
            self.current_focus_bucket_id.clone(),
            self.prompt_version.clone(),
            self.model_name.clone(),
        )?
        .with_optional_confirmation_attempt(self.confirmation_attempt_id.clone())?;
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
            candidates: Vec::new(),
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
        let audit = DoggieArchiveAudit::new(
            Vec::new(),
            self.current_focus_bucket_id.clone(),
            self.prompt_version.clone(),
            self.model_name.clone(),
        )?
        .with_optional_confirmation_attempt(self.confirmation_attempt_id.clone())?;
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
            candidates: Vec::new(),
        })
    }

    fn archive_classification(
        &mut self,
        text: &str,
        classification: ClassificationResult,
        candidates: Vec<BucketView>,
        buckets: Vec<DoggieBucket>,
    ) -> Result<ArchiveExecution, RuntimeError> {
        let extraction = if classification.action() == ClassificationAction::AskUser {
            None
        } else {
            Some(self.model.extract(text).map_err(model_error)?)
        };
        let audit = DoggieArchiveAudit::new(
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
            candidates,
        })
    }
}

/// Store result plus the validated classification/extraction used to create it.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchiveExecution {
    pub outcome: DoggieArchiveOutcome,
    pub classification: ClassificationResult,
    pub extraction: Option<ExtractionResult>,
    pub bucket: Option<DoggieBucket>,
    /// Server-provided candidate metadata retained for confirmation clients.
    pub candidates: Vec<BucketView>,
}

/// Doggie engine owning the local store and structured memory model.
///
/// One call to [`Self::archive`] executes the complete MVP loop: classify,
/// apply server-side gates, extract structured memory, persist the archive, and
/// return the stored result. Explicit confirmation methods are separate so a
/// low-confidence classification can never silently become a write.
pub struct CanonicalRuntime<M> {
    service: CanonicalService,
    model: M,
    policy: ConfidencePolicy,
    model_name: String,
    prompt_version: String,
}

impl<M> CanonicalRuntime<M> {
    pub fn new(
        service: CanonicalService,
        model: M,
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
        })
    }

    pub fn service(&self) -> &CanonicalService {
        &self.service
    }

    pub fn service_mut(&mut self) -> &mut CanonicalService {
        &mut self.service
    }
}

impl<M: MemoryModel> CanonicalRuntime<M> {
    /// Classify, extract, and persist one user-provided memory.
    pub fn archive(
        &mut self,
        text: &str,
        current_focus_bucket_id: Option<String>,
    ) -> Result<ArchiveExecution, RuntimeError> {
        let coordinator = CanonicalArchiveCoordinator::new(
            &mut self.service,
            &mut self.model,
            self.policy,
            self.model_name.clone(),
            self.prompt_version.clone(),
        )?;
        coordinator
            .with_focus_bucket(current_focus_bucket_id)
            .archive(text)
    }

    /// Explicitly append one memory to an existing Bucket.
    pub fn append_confirmed(
        &mut self,
        bucket_id: &str,
        text: &str,
        current_focus_bucket_id: Option<String>,
    ) -> Result<ArchiveExecution, RuntimeError> {
        self.append_confirmed_for_attempt(bucket_id, text, current_focus_bucket_id, None)
    }

    /// Persist an explicitly confirmed append bound to a pending chat attempt.
    pub fn append_confirmed_for_attempt(
        &mut self,
        bucket_id: &str,
        text: &str,
        current_focus_bucket_id: Option<String>,
        confirmation_attempt_id: Option<String>,
    ) -> Result<ArchiveExecution, RuntimeError> {
        let coordinator = CanonicalArchiveCoordinator::new(
            &mut self.service,
            &mut self.model,
            self.policy,
            self.model_name.clone(),
            self.prompt_version.clone(),
        )?;
        coordinator
            .with_focus_bucket(current_focus_bucket_id)
            .with_confirmation_attempt(confirmation_attempt_id)
            .append_confirmed(bucket_id, text)
    }

    /// Explicitly create a Bucket and save its first memory.
    pub fn create_confirmed(
        &mut self,
        title: &str,
        bucket_type: BucketType,
        text: &str,
        current_focus_bucket_id: Option<String>,
    ) -> Result<ArchiveExecution, RuntimeError> {
        self.create_confirmed_for_attempt(title, bucket_type, text, current_focus_bucket_id, None)
    }

    /// Persist an explicitly confirmed new Bucket bound to a pending chat attempt.
    pub fn create_confirmed_for_attempt(
        &mut self,
        title: &str,
        bucket_type: BucketType,
        text: &str,
        current_focus_bucket_id: Option<String>,
        confirmation_attempt_id: Option<String>,
    ) -> Result<ArchiveExecution, RuntimeError> {
        let coordinator = CanonicalArchiveCoordinator::new(
            &mut self.service,
            &mut self.model,
            self.policy,
            self.model_name.clone(),
            self.prompt_version.clone(),
        )?;
        coordinator
            .with_focus_bucket(current_focus_bucket_id)
            .with_confirmation_attempt(confirmation_attempt_id)
            .create_confirmed(title, bucket_type, text)
    }
}

/// Read-only API projection helpers used by the HTTP server and embedded UI.
pub fn active_buckets(service: &CanonicalService, limit: usize) -> Result<Value, RuntimeError> {
    Ok(json!({
        "buckets": service
            .list_active_buckets(limit)?
            .iter()
            .map(doggie_bucket_to_value)
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

/// Execute the conversational Entry-level memory query and project both its
/// parsed plan and merged evidence into the JSON shape used by HTTP, UI, and
/// Agent callers.  The legacy [`search_memory`] projection above remains
/// Bucket-level for backwards compatibility.
pub fn query_memory(
    service: &CanonicalService,
    query: &str,
    limit: usize,
) -> Result<Value, RuntimeError> {
    let response = service.query_memory(query, limit)?;
    memory_search_response_to_value(&response)
}

/// Execute a caller-supplied conversational query plan.
pub fn query_memory_with_plan(
    service: &CanonicalService,
    plan: MemoryQuery,
) -> Result<Value, RuntimeError> {
    let response = service.query_memory_with_plan(plan)?;
    memory_search_response_to_value(&response)
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

fn bucket_view_to_value(view: &BucketView) -> Result<Value, doggie_protocol::ContractError> {
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

fn doggie_bucket_to_value(bucket: &DoggieBucket) -> Result<Value, RuntimeError> {
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

fn search_hit_to_value(hit: &DoggieSearchHit) -> Result<Value, RuntimeError> {
    Ok(json!({
        "bucket": doggie_bucket_to_value(&hit.bucket)?,
        "matched_entry_count": hit.matched_entry_count,
        "score": hit.score,
    }))
}

fn memory_search_response_to_value(response: &MemorySearchResponse) -> Result<Value, RuntimeError> {
    Ok(json!({
        "query": response.query.raw_text,
        "query_plan": memory_query_to_value(&response.query),
        "total_entries": response.results.len(),
        "total_buckets": response.buckets.len(),
        "results": response
            .results
            .iter()
            .map(memory_search_hit_to_value)
            .collect::<Result<Vec<_>, _>>()?,
        "buckets": response
            .buckets
            .iter()
            .map(memory_bucket_group_to_value)
            .collect::<Result<Vec<_>, _>>()?,
        "evidence": response
            .evidence
            .iter()
            .map(memory_item_to_value)
            .collect::<Vec<_>>(),
        "answer": response.answer,
    }))
}

fn memory_query_to_value(query: &MemoryQuery) -> Value {
    json!({
        "raw_text": query.raw_text,
        "terms": query.terms,
        "entity_terms": query.entity_terms,
        "topic_terms": query.topic_terms,
        "bucket_terms": query.bucket_terms,
        "time_range": query.time_range.as_ref().map(|range| json!({
            "start": range.start.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
            "end": range.end.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
            "label": range.label,
        })),
        "statuses": query.statuses.iter().map(|status| status.as_str()).collect::<Vec<_>>(),
        "structured_filters": query.structured_filters.iter().map(|filter| json!({
            "field": filter.field,
            "value": filter.value,
        })).collect::<Vec<_>>(),
        "limit": query.limit,
    })
}

fn memory_search_hit_to_value(hit: &MemorySearchHit) -> Result<Value, RuntimeError> {
    Ok(json!({
        "bucket": doggie_bucket_to_value(&hit.bucket)?,
        "entry": entry_to_value(&hit.entry)?,
        "memories": hit.memories.iter().map(memory_item_to_value).collect::<Vec<_>>(),
        "matched_fields": hit.matched_fields,
        "keyword_score": hit.keyword_score,
        "semantic_score": hit.semantic_score,
        "score": hit.score,
    }))
}

fn memory_bucket_group_to_value(group: &MemoryBucketGroup) -> Result<Value, RuntimeError> {
    Ok(json!({
        "bucket": doggie_bucket_to_value(&group.bucket)?,
        "matched_entry_count": group.matched_entry_count,
        "top_score": group.top_score,
    }))
}

fn memory_item_to_value(memory: &doggie_storage_sqlite::DoggieMemoryItem) -> Value {
    json!({
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
    })
}

fn bucket_detail_to_value(detail: &DoggieBucketDetail) -> Result<Value, RuntimeError> {
    Ok(json!({
        "bucket": doggie_bucket_to_value(&detail.bucket)?,
        "entries": detail.entries.iter().map(entry_to_value).collect::<Result<Vec<_>, _>>()?,
        "memories": detail.memories.iter().map(memory_item_to_value).collect::<Vec<_>>(),
    }))
}

fn entry_to_value(entry: &DoggieEntry) -> Result<Value, RuntimeError> {
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

pub fn archive_execution_to_value(execution: &ArchiveExecution) -> Result<Value, RuntimeError> {
    let recommended_bucket_id = execution
        .classification
        .bucket_id()
        .map(ToOwned::to_owned)
        .or_else(|| {
            execution
                .classification
                .candidate_bucket_ids()
                .first()
                .cloned()
        });
    let candidate_buckets = execution
        .classification
        .candidate_bucket_ids()
        .iter()
        .filter_map(|candidate_id| {
            execution
                .candidates
                .iter()
                .find(|candidate| candidate.id() == candidate_id)
        })
        .map(|candidate| {
            json!({
                "id": candidate.id(),
                "title": candidate.title(),
                "type": candidate.bucket_type().as_str(),
                "status": candidate.status().as_str(),
                "summary": candidate.summary(),
                "tags": candidate.tags(),
                "last_active_at_unix_ms": candidate.last_active_at_unix_ms(),
                "is_recommended": recommended_bucket_id.as_deref() == Some(candidate.id()),
            })
        })
        .collect::<Vec<_>>();
    let recommended_bucket = candidate_buckets
        .iter()
        .find(|candidate| candidate["is_recommended"] == json!(true));

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
        "recommended_bucket_id": recommended_bucket_id,
        "recommended_bucket": recommended_bucket,
        "candidate_buckets": candidate_buckets,
        // These fields describe a proposed new Bucket only. Existing Bucket
        // metadata is exposed separately through recommended_bucket and the
        // candidate_buckets list, so old clients cannot mistake an append
        // recommendation for a create-new request.
        "bucket_title": execution.classification.title(),
        "bucket_type": execution
            .classification
            .bucket_type()
            .map(BucketType::as_str),
        "bucket": execution.bucket.as_ref().map(doggie_bucket_to_value).transpose()?,
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
    Core(#[from] doggie_domain::CoreError),
    #[error("contract error: {0}")]
    Contract(#[from] doggie_protocol::ContractError),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("model error: {0}")]
    Model(String),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}
