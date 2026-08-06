//! Natural-language memory query planning and deterministic result aggregation.
//!
//! This is deliberately model-independent.  The parser turns common Chinese
//! time/status phrases into a bounded query plan, while the scorer combines
//! exact keyword matches, structured-memory matches, and a small lexical
//! similarity fallback.  A vector index can replace the fallback later without
//! changing the public result shape.

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use thiserror::Error;
use work_memory_core::{BucketStatus, unicode_case_fold};
use work_memory_store::{RustBucket, RustEntry, RustMemoryItem, RustStore};

const MAX_QUERY_CHARS: usize = 500;
const MAX_STRUCTURED_FILTERS: usize = 16;

/// A half-open time interval used by a memory query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeRange {
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
    pub label: String,
}

impl TimeRange {
    pub fn new(
        start: NaiveDateTime,
        end: NaiveDateTime,
        label: impl Into<String>,
    ) -> Result<Self, MemoryQueryError> {
        if start >= end {
            return Err(MemoryQueryError::InvalidTimeRange(
                "start must be before end".to_owned(),
            ));
        }
        Ok(Self {
            start,
            end,
            label: label.into(),
        })
    }

    /// Parse either an RFC3339 timestamp or the SQLite timestamp format used by
    /// the canonical store.
    pub fn parse_timestamp(value: &str) -> Result<NaiveDateTime, MemoryQueryError> {
        let value = value.trim();
        if let Ok(timestamp) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f") {
            return Ok(timestamp);
        }
        if let Ok(timestamp) = DateTime::parse_from_rfc3339(value) {
            return Ok(timestamp.with_timezone(&Utc).naive_utc());
        }
        if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
            && let Some(timestamp) = date.and_hms_opt(0, 0, 0)
        {
            return Ok(timestamp);
        }
        Err(MemoryQueryError::InvalidTimeRange(format!(
            "invalid timestamp: {value}"
        )))
    }

    pub fn from_strings(
        start: &str,
        end: &str,
        label: impl Into<String>,
    ) -> Result<Self, MemoryQueryError> {
        Self::new(
            Self::parse_timestamp(start)?,
            Self::parse_timestamp(end)?,
            label,
        )
    }
}

/// A structured field predicate supplied by an API client or a future model
/// query planner.  `field` accepts `kind`, `status`, `entity`, `tag`, `source`,
/// `content_type`, or a key in a memory item's metadata JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredFieldFilter {
    pub field: String,
    pub value: String,
}

impl StructuredFieldFilter {
    pub fn new(
        field: impl Into<String>,
        value: impl Into<String>,
    ) -> Result<Self, MemoryQueryError> {
        let field = field.into().trim().to_owned();
        let value = value.into().trim().to_owned();
        if field.is_empty() || value.is_empty() {
            return Err(MemoryQueryError::InvalidStructuredFilter(
                "field and value must not be empty".to_owned(),
            ));
        }
        Ok(Self { field, value })
    }
}

/// Parsed plan for one natural-language memory query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryQuery {
    pub raw_text: String,
    pub terms: Vec<String>,
    pub entity_terms: Vec<String>,
    pub topic_terms: Vec<String>,
    pub bucket_terms: Vec<String>,
    pub time_range: Option<TimeRange>,
    pub statuses: Vec<BucketStatus>,
    pub structured_filters: Vec<StructuredFieldFilter>,
    pub limit: usize,
}

impl MemoryQuery {
    /// Parse common Chinese conversational search phrases.
    pub fn parse(text: &str, limit: usize) -> Result<Self, MemoryQueryError> {
        Self::parse_at(text, limit, current_utc_naive())
    }

    /// Parse common Chinese conversational search phrases against a supplied
    /// clock.  The injectable clock keeps relative-time behavior deterministic
    /// in tests and in callers that need a stable query snapshot.
    pub fn parse_at(
        text: &str,
        limit: usize,
        now: NaiveDateTime,
    ) -> Result<Self, MemoryQueryError> {
        let raw_text = text.trim().to_owned();
        if raw_text.is_empty() {
            return Err(MemoryQueryError::EmptyQuery);
        }
        if raw_text.chars().count() > MAX_QUERY_CHARS {
            return Err(MemoryQueryError::QueryTooLong {
                max_chars: MAX_QUERY_CHARS,
            });
        }
        if limit == 0 {
            return Err(MemoryQueryError::InvalidLimit);
        }

        let (without_time, time_range) = parse_time_range_at(&raw_text, now)?;
        let (without_status, statuses) = parse_statuses(&without_time);
        let mut residual = strip_query_prefixes(&without_status);
        residual = residual.replace('的', " ");
        residual = residual.replace(['，', '。', '？', '?', '！', '!', ',', ':', '：'], " ");

        let entity_terms = extract_entity_terms(&residual);
        for entity in &entity_terms {
            residual = residual.replace(entity, " ");
        }
        let topic_terms = meaningful_terms(&residual);
        let terms = dedupe_terms(
            entity_terms
                .iter()
                .chain(topic_terms.iter())
                .cloned()
                .collect(),
        );
        let bucket_terms = terms.clone();

        Ok(Self {
            raw_text,
            terms,
            entity_terms,
            topic_terms,
            bucket_terms,
            time_range,
            statuses,
            structured_filters: Vec::new(),
            limit,
        })
    }

    pub fn with_statuses(mut self, statuses: Vec<BucketStatus>) -> Self {
        self.statuses = dedupe_statuses(statuses);
        self
    }

    pub fn with_time_range(mut self, time_range: Option<TimeRange>) -> Self {
        self.time_range = time_range;
        self
    }

    pub fn with_structured_filters(
        mut self,
        filters: Vec<StructuredFieldFilter>,
    ) -> Result<Self, MemoryQueryError> {
        if filters.len() > MAX_STRUCTURED_FILTERS {
            return Err(MemoryQueryError::TooManyStructuredFilters {
                max_filters: MAX_STRUCTURED_FILTERS,
            });
        }
        self.structured_filters = filters;
        Ok(self)
    }

    pub fn has_constraints(&self) -> bool {
        self.time_range.is_some()
            || !self.statuses.is_empty()
            || !self.structured_filters.is_empty()
    }
}

/// One Entry-level result.  The owning Bucket is retained so clients can merge
/// hits from multiple Buckets without a second lookup.
#[derive(Debug, Clone, PartialEq)]
pub struct MemorySearchHit {
    pub bucket: RustBucket,
    pub entry: RustEntry,
    pub memories: Vec<RustMemoryItem>,
    pub matched_fields: Vec<String>,
    pub keyword_score: usize,
    pub semantic_score: f64,
    pub score: usize,
}

/// Bucket-level grouping for a merged conversational answer.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryBucketGroup {
    pub bucket: RustBucket,
    pub matched_entry_count: usize,
    pub top_score: usize,
}

/// Search output consumed by the runtime, Agent tool, HTTP API, and UI.
#[derive(Debug, Clone, PartialEq)]
pub struct MemorySearchResponse {
    pub query: MemoryQuery,
    pub results: Vec<MemorySearchHit>,
    pub buckets: Vec<MemoryBucketGroup>,
    pub evidence: Vec<RustMemoryItem>,
    pub answer: String,
}

/// Errors raised while turning a conversational query into a bounded plan.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum MemoryQueryError {
    #[error("memory query must not be empty")]
    EmptyQuery,
    #[error("memory query exceeds {max_chars} characters")]
    QueryTooLong { max_chars: usize },
    #[error("memory query limit must be positive")]
    InvalidLimit,
    #[error("invalid time range: {0}")]
    InvalidTimeRange(String),
    #[error("invalid structured filter: {0}")]
    InvalidStructuredFilter(String),
    #[error("memory query has more than {max_filters} structured filters")]
    TooManyStructuredFilters { max_filters: usize },
    #[error("memory query store error: {0}")]
    Store(String),
}

/// Execute a parsed plan against the canonical store.
pub fn search_memory(
    store: &RustStore,
    query: &MemoryQuery,
) -> Result<MemorySearchResponse, MemoryQueryError> {
    search_memory_at(store, query, current_utc_naive())
}

/// Execute a parsed plan against a stable clock.  Relative query ranges are
/// parsed before this function, but the clock is also used for deterministic
/// recency ranking.
pub fn search_memory_at(
    store: &RustStore,
    query: &MemoryQuery,
    now: NaiveDateTime,
) -> Result<MemorySearchResponse, MemoryQueryError> {
    let buckets = store
        .list_buckets()
        .map_err(|error| MemoryQueryError::Store(error.to_string()))?;
    let mut results = Vec::new();

    for bucket in buckets {
        if !query.statuses.is_empty() && !query.statuses.contains(&bucket.status) {
            continue;
        }
        let Some(detail) = store
            .bucket_detail(&bucket.id)
            .map_err(|error| MemoryQueryError::Store(error.to_string()))?
        else {
            continue;
        };
        let bucket_score = score_bucket(&bucket, query);

        for entry in detail.entries {
            if !in_time_range(entry.created_at.utc_naive(), query.time_range.as_ref()) {
                continue;
            }
            let entry_memories: Vec<RustMemoryItem> = detail
                .memories
                .iter()
                .filter(|memory| memory.entry_id.as_deref() == Some(entry.id.as_str()))
                .cloned()
                .collect();
            if !query
                .structured_filters
                .iter()
                .all(|filter| matches_structured_filter(filter, &bucket, &entry, &entry_memories))
            {
                continue;
            }

            let mut matched_fields = Vec::new();
            let mut keyword_score = bucket_score;
            score_field(
                &mut keyword_score,
                &mut matched_fields,
                "entry.raw_text",
                &entry.raw_text,
                &query.terms,
                55,
            );
            if let Some(summary) = &entry.summary {
                score_field(
                    &mut keyword_score,
                    &mut matched_fields,
                    "entry.summary",
                    summary,
                    &query.topic_terms,
                    42,
                );
            }
            for memory in &entry_memories {
                let label = format!("memory.{}", memory.kind.as_str());
                score_field(
                    &mut keyword_score,
                    &mut matched_fields,
                    &label,
                    &memory.text,
                    &query.terms,
                    24,
                );
                if memory.kind.as_str() == "entity" {
                    score_field(
                        &mut keyword_score,
                        &mut matched_fields,
                        "memory.entity",
                        &memory.text,
                        &query.entity_terms,
                        48,
                    );
                }
                if memory.kind.as_str() == "tag" {
                    score_field(
                        &mut keyword_score,
                        &mut matched_fields,
                        "memory.tag",
                        &memory.text,
                        &query.topic_terms,
                        34,
                    );
                }
            }

            let has_lexical_match = keyword_score > 0;
            let has_only_constraints = query.terms.is_empty() && query.has_constraints();
            if !has_lexical_match && !has_only_constraints {
                continue;
            }
            // A Bucket title/summary/tag match is allowed to return its Entry
            // rows, which is what makes Bucket-name search useful at Entry level.
            if query.terms.is_empty() {
                keyword_score = 1;
            }
            let semantic_score = lexical_similarity(query, &bucket, &entry, &entry_memories);
            let recency_bonus = recency_bonus(entry.created_at.utc_naive(), now);
            let score = keyword_score
                .saturating_add((semantic_score * 10.0).round() as usize)
                .saturating_add(recency_bonus);
            matched_fields.sort();
            matched_fields.dedup();
            results.push(MemorySearchHit {
                bucket: bucket.clone(),
                entry,
                memories: entry_memories,
                matched_fields,
                keyword_score,
                semantic_score,
                score,
            });
        }
    }

    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| {
                right
                    .entry
                    .created_at
                    .utc_naive()
                    .cmp(left.entry.created_at.utc_naive())
            })
            .then_with(|| left.entry.id.cmp(&right.entry.id))
    });
    results.truncate(query.limit);

    let buckets = group_buckets(&results);
    let evidence = dedupe_evidence(&results);
    let answer = build_answer(query, &results, &buckets);
    Ok(MemorySearchResponse {
        query: query.clone(),
        results,
        buckets,
        evidence,
        answer,
    })
}

fn parse_time_range_at(
    text: &str,
    now: NaiveDateTime,
) -> Result<(String, Option<TimeRange>), MemoryQueryError> {
    let patterns: &[(&str, i64, &str)] = &[
        ("最近两周", 14, "最近两周"),
        ("过去两周", 14, "过去两周"),
        ("近两周", 14, "近两周"),
        ("最近2周", 14, "最近2周"),
        ("过去2周", 14, "过去2周"),
        ("最近一周", 7, "最近一周"),
        ("过去一周", 7, "过去一周"),
        ("最近1周", 7, "最近1周"),
        ("最近7天", 7, "最近7天"),
        ("过去7天", 7, "过去7天"),
        ("最近一个月", 30, "最近一个月"),
        ("过去一个月", 30, "过去一个月"),
        ("最近1个月", 30, "最近1个月"),
        ("最近30天", 30, "最近30天"),
        ("过去30天", 30, "过去30天"),
    ];
    for (phrase, days, label) in patterns {
        if text.contains(phrase) {
            let range = TimeRange::new(now - Duration::days(*days), now, *label)?;
            return Ok((text.replace(phrase, " "), Some(range)));
        }
    }
    Ok((text.to_owned(), None))
}

fn current_utc_naive() -> NaiveDateTime {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    DateTime::<Utc>::from_timestamp(duration.as_secs() as i64, duration.subsec_nanos())
        .expect("system time must fit in chrono range")
        .naive_utc()
}

fn parse_statuses(text: &str) -> (String, Vec<BucketStatus>) {
    let mut residual = text.to_owned();
    let mut statuses = Vec::new();
    let values = [
        ("active", BucketStatus::Active),
        ("paused", BucketStatus::Paused),
        ("done", BucketStatus::Done),
        ("archived", BucketStatus::Archived),
        ("活跃", BucketStatus::Active),
        ("暂停", BucketStatus::Paused),
        ("已完成", BucketStatus::Done),
        ("完成", BucketStatus::Done),
        ("已归档", BucketStatus::Archived),
        ("归档", BucketStatus::Archived),
    ];
    for (phrase, status) in values {
        if residual.to_ascii_lowercase().contains(phrase) {
            statuses.push(status);
            residual = if phrase.is_ascii() {
                remove_ascii_case_insensitive(&residual, phrase)
            } else {
                residual.replace(phrase, " ")
            };
        }
    }
    let statuses = dedupe_statuses(statuses);
    if !statuses.is_empty() {
        // These words describe the status predicate rather than the memory
        // being searched: “只看 active 状态” should not search for “状态”.
        for phrase in ["状态为", "生命周期", "只看", "仅看", "状态", "并", "且"] {
            residual = residual.replace(phrase, " ");
        }
        for phrase in ["status", "only", "show", "and"] {
            residual = remove_ascii_case_insensitive(&residual, phrase);
        }
    }
    (residual, statuses)
}

fn remove_ascii_case_insensitive(text: &str, needle: &str) -> String {
    let folded = text.to_ascii_lowercase();
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, matched) in folded.match_indices(needle) {
        if start < cursor {
            continue;
        }
        output.push_str(&text[cursor..start]);
        output.push(' ');
        cursor = start + matched.len();
    }
    output.push_str(&text[cursor..]);
    output
}

fn strip_query_prefixes(text: &str) -> String {
    let mut value = text.trim().to_owned();
    let prefixes = [
        "请帮我查询",
        "请帮我查一下",
        "帮我查询",
        "帮我查一下",
        "请查询",
        "查询",
        "查一下",
        "查找",
        "搜索",
        "查看",
        "找出",
        "找",
    ];
    for prefix in prefixes {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.trim().to_owned();
            break;
        }
    }
    value
}

fn extract_entity_terms(text: &str) -> Vec<String> {
    let mut entities = Vec::new();
    for marker in ["接口", "服务", "系统", "项目"] {
        let Some(start) = text.find(marker) else {
            continue;
        };
        let rest = text[start..].trim();
        let phrase = rest
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        if !phrase.is_empty() {
            entities.push(phrase);
            break;
        }
    }
    dedupe_terms(entities)
}

fn meaningful_terms(text: &str) -> Vec<String> {
    let stop_words = [
        "请",
        "帮我",
        "查询",
        "查",
        "一下",
        "看看",
        "关于",
        "有关",
        "最近",
        "过去",
        "的",
        "和",
        "与",
        "以及",
        "结果",
        "记录",
        "信息",
        "有哪些",
        "是什么",
    ];
    let terms = text
        .split_whitespace()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .filter(|term| !stop_words.contains(term))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        let fallback = text.trim();
        if fallback.is_empty() {
            Vec::new()
        } else {
            vec![fallback.to_owned()]
        }
    } else {
        dedupe_terms(terms)
    }
}

fn dedupe_terms(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && seen.insert(unicode_case_fold(value)))
        .collect()
}

fn dedupe_statuses(values: Vec<BucketStatus>) -> Vec<BucketStatus> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(*value))
        .collect()
}

fn score_bucket(bucket: &RustBucket, query: &MemoryQuery) -> usize {
    let mut score = 0;
    for term in &query.bucket_terms {
        let folded = unicode_case_fold(term);
        let title = unicode_case_fold(&bucket.title);
        let summary = unicode_case_fold(&bucket.summary);
        if title == folded {
            score += 110;
        } else if title.contains(&folded) {
            score += 65;
        }
        if summary.contains(&folded) {
            score += 30;
        }
        if bucket
            .tags
            .iter()
            .any(|tag| unicode_case_fold(tag).contains(&folded))
        {
            score += 35;
        }
    }
    score
}

fn score_field(
    score: &mut usize,
    fields: &mut Vec<String>,
    label: &str,
    value: &str,
    terms: &[String],
    weight: usize,
) {
    let folded_value = unicode_case_fold(value);
    for term in terms {
        let folded_term = unicode_case_fold(term);
        if folded_term.is_empty() || !folded_value.contains(&folded_term) {
            continue;
        }
        *score = score.saturating_add(if folded_value == folded_term {
            weight.saturating_add(weight / 2)
        } else {
            weight
        });
        fields.push(label.to_owned());
    }
}

fn matches_structured_filter(
    filter: &StructuredFieldFilter,
    bucket: &RustBucket,
    entry: &RustEntry,
    memories: &[RustMemoryItem],
) -> bool {
    let field = unicode_case_fold(&filter.field);
    let value = unicode_case_fold(&filter.value);
    if field == "status" || field == "状态" {
        return unicode_case_fold(bucket.status.as_str()) == value
            || memories.iter().any(|memory| {
                memory
                    .status
                    .as_deref()
                    .map(unicode_case_fold)
                    .is_some_and(|status| status == value)
            });
    }
    if field == "kind" || field == "类型" {
        return memories
            .iter()
            .any(|memory| unicode_case_fold(memory.kind.as_str()) == value)
            || unicode_case_fold(bucket.bucket_type.as_str()) == value;
    }
    if field == "content_type" || field == "内容类型" {
        return unicode_case_fold(&entry.content_type) == value;
    }
    if field == "entity" || field == "实体" {
        return memories.iter().any(|memory| {
            memory.kind.as_str() == "entity" && unicode_case_fold(&memory.text).contains(&value)
        });
    }
    if field == "tag" || field == "标签" {
        return bucket
            .tags
            .iter()
            .any(|tag| unicode_case_fold(tag).contains(&value))
            || memories.iter().any(|memory| {
                memory.kind.as_str() == "tag" && unicode_case_fold(&memory.text).contains(&value)
            });
    }
    if field == "source" || field == "来源" {
        return memories.iter().any(|memory| {
            memory
                .source
                .as_deref()
                .map(unicode_case_fold)
                .is_some_and(|source| source.contains(&value))
        });
    }
    memories
        .iter()
        .any(|memory| metadata_contains(&memory.metadata, &field, &value))
}

fn metadata_contains(value: &serde_json::Value, field: &str, expected: &str) -> bool {
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(key, value)| {
            (unicode_case_fold(key) == field && scalar_contains(value, expected))
                || metadata_contains(value, field, expected)
        }),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| metadata_contains(value, field, expected)),
        _ => false,
    }
}

fn scalar_contains(value: &serde_json::Value, expected: &str) -> bool {
    value
        .as_str()
        .map(unicode_case_fold)
        .is_some_and(|actual| actual.contains(expected))
        || value.to_string().to_ascii_lowercase().contains(expected)
}

fn lexical_similarity(
    query: &MemoryQuery,
    bucket: &RustBucket,
    entry: &RustEntry,
    memories: &[RustMemoryItem],
) -> f64 {
    if query.terms.is_empty() {
        return 0.0;
    }
    let mut corpus = format!(
        "{} {} {} {}",
        bucket.title,
        bucket.summary,
        entry.raw_text,
        entry.summary.as_deref().unwrap_or_default()
    );
    for memory in memories {
        corpus.push(' ');
        corpus.push_str(&memory.text);
    }
    let folded_corpus = unicode_case_fold(&corpus);
    let matched = query
        .terms
        .iter()
        .filter(|term| folded_corpus.contains(&unicode_case_fold(term)))
        .count();
    let ratio = matched as f64 / query.terms.len() as f64;
    let whole_phrase = unicode_case_fold(&query.terms.join(" "));
    if !whole_phrase.is_empty() && folded_corpus.contains(&whole_phrase) {
        1.0
    } else {
        ratio.clamp(0.0, 1.0)
    }
}

fn in_time_range(timestamp: &NaiveDateTime, range: Option<&TimeRange>) -> bool {
    range.is_none_or(|range| *timestamp >= range.start && *timestamp < range.end)
}

fn recency_bonus(timestamp: &NaiveDateTime, now: NaiveDateTime) -> usize {
    let age = now.signed_duration_since(*timestamp).num_days();
    if age < 0 {
        10
    } else {
        10usize.saturating_sub(age as usize).min(10)
    }
}

fn group_buckets(results: &[MemorySearchHit]) -> Vec<MemoryBucketGroup> {
    let mut groups: Vec<MemoryBucketGroup> = Vec::new();
    for result in results {
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.bucket.id == result.bucket.id)
        {
            group.matched_entry_count += 1;
            group.top_score = group.top_score.max(result.score);
        } else {
            groups.push(MemoryBucketGroup {
                bucket: result.bucket.clone(),
                matched_entry_count: 1,
                top_score: result.score,
            });
        }
    }
    groups.sort_by(|left, right| {
        right
            .top_score
            .cmp(&left.top_score)
            .then_with(|| left.bucket.id.cmp(&right.bucket.id))
    });
    groups
}

fn dedupe_evidence(results: &[MemorySearchHit]) -> Vec<RustMemoryItem> {
    let mut seen = HashSet::new();
    let mut evidence = Vec::new();
    for result in results {
        for memory in &result.memories {
            let key = format!(
                "{}:{}",
                memory.kind.as_str(),
                unicode_case_fold(memory.text.trim())
            );
            if seen.insert(key) {
                evidence.push(memory.clone());
            }
        }
    }
    evidence
}

fn build_answer(
    query: &MemoryQuery,
    results: &[MemorySearchHit],
    buckets: &[MemoryBucketGroup],
) -> String {
    if results.is_empty() {
        return format!("没有找到与「{}」匹配的记忆。", query.raw_text);
    }
    let mut answer = format!(
        "找到 {} 条相关 Entry，涉及 {} 个 Bucket。",
        results.len(),
        buckets.len()
    );
    for result in results.iter().take(5) {
        let snippet = result
            .entry
            .summary
            .as_deref()
            .unwrap_or(&result.entry.raw_text)
            .trim();
        let snippet = snippet.chars().take(180).collect::<String>();
        answer.push_str(&format!("\n- 「{}」：{}", result.bucket.title, snippet));
    }
    answer
}
