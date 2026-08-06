use std::collections::{HashMap, HashSet};

use crate::{BucketView, ClassificationAction, ClassificationResult, CoreError};

// These markers are deliberately broader than the model prompt. A model can be
// highly confident about a plausible Bucket even when the user supplied no new
// fact. The server-side gate must therefore treat vague references and status-
// only updates as confirmation-worthy regardless of the model score.
const VAGUE_REFERENCE_MARKERS: &[&str] = &[
    "刚才",
    "刚刚",
    "那个",
    "这个",
    "它",
    "上次",
    "之前",
    "前面",
    "那块",
    "这块",
    "相关",
    "该问题",
    "这件事",
    "那个任务",
    "这个任务",
];
const LOW_INFORMATION_ACTION_MARKERS: &[&str] = &[
    "继续",
    "更新",
    "完成",
    "好了",
    "正常了",
    "有进展",
    "搞定",
    "解决",
    "记一下",
    "记下",
    "再补一点",
    "补一点",
    "补一下",
    "补充一下",
    "跟进一下",
    "处理",
    "看一下",
];
const CONCRETE_FACT_MARKERS: &[&str] = &[
    "恢复",
    "决定",
    "确认",
    "回复说",
    "导致",
    "原因",
    "失败",
    "报错",
    "错误率",
    "日志",
    "影响",
    "降到",
    "升到",
    "验证",
    "上线",
    "回滚",
    "阻塞",
    "502",
    "P99",
    "QPS",
];
const LOW_INFORMATION_CHAR_LIMIT: usize = 24;

/// Configurable thresholds for automatic persistence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConfidencePolicy {
    auto_archive_threshold: f64,
    confirm_threshold: f64,
}

impl ConfidencePolicy {
    pub fn new(auto_archive_threshold: f64, confirm_threshold: f64) -> Result<Self, CoreError> {
        let valid = auto_archive_threshold.is_finite()
            && confirm_threshold.is_finite()
            && 0.0 <= confirm_threshold
            && confirm_threshold <= auto_archive_threshold
            && auto_archive_threshold <= 1.0;
        if !valid {
            return Err(CoreError::InvalidConfidenceThresholds {
                confirm_threshold,
                auto_archive_threshold,
            });
        }
        Ok(Self {
            auto_archive_threshold,
            confirm_threshold,
        })
    }

    pub const fn auto_archive_threshold(self) -> f64 {
        self.auto_archive_threshold
    }

    pub const fn confirm_threshold(self) -> f64 {
        self.confirm_threshold
    }
}

impl Default for ConfidencePolicy {
    fn default() -> Self {
        Self {
            auto_archive_threshold: 0.85,
            confirm_threshold: 0.55,
        }
    }
}

/// De-duplicate and order candidates with the current focus first, then by recency.
pub fn build_bucket_candidates(
    buckets: Vec<BucketView>,
    current_focus_bucket_id: Option<&str>,
    limit: usize,
) -> Result<Vec<BucketView>, CoreError> {
    if limit < 1 {
        return Err(CoreError::CandidateLimitTooSmall);
    }

    // Match Python dict-comprehension behavior: the last duplicate value wins,
    // while the first insertion position remains the stable tie-break position.
    let mut positions = HashMap::<String, usize>::new();
    let mut deduplicated = Vec::new();
    for bucket in buckets {
        if let Some(position) = positions.get(bucket.id()).copied() {
            deduplicated[position] = bucket;
        } else {
            positions.insert(bucket.id().to_owned(), deduplicated.len());
            deduplicated.push(bucket);
        }
    }

    deduplicated.sort_by(|left, right| {
        let left_is_focus = Some(left.id()) == current_focus_bucket_id;
        let right_is_focus = Some(right.id()) == current_focus_bucket_id;
        right_is_focus.cmp(&left_is_focus).then_with(|| {
            right
                .last_active_at_unix_ms()
                .cmp(&left.last_active_at_unix_ms())
        })
    });
    deduplicated.truncate(limit);
    Ok(deduplicated)
}

fn likely_candidate_ids(result: &ClassificationResult) -> Vec<String> {
    let mut ids = Vec::with_capacity(result.candidate_bucket_ids().len() + 1);
    if let Some(bucket_id) = result.bucket_id() {
        ids.push(bucket_id.to_owned());
    }
    for candidate_id in result.candidate_bucket_ids() {
        if !ids.iter().any(|item| item == candidate_id) {
            ids.push(candidate_id.clone());
        }
    }
    ids
}

/// Reject generated Bucket IDs that were not supplied by the server.
pub fn validate_candidate_reference(
    result: ClassificationResult,
    candidates: &[BucketView],
) -> Result<ClassificationResult, CoreError> {
    let candidate_ids = candidates
        .iter()
        .map(BucketView::id)
        .collect::<HashSet<_>>();
    let original_ids = result.candidate_bucket_ids().to_vec();
    let mut merged_ids = Vec::with_capacity(original_ids.len() + candidates.len() + 1);

    // An explicit model target is the strongest recommendation. Then retain the
    // model's valid candidates, followed by the bounded server list so the UI
    // can always present a real alternative-Bucket selector.
    if let Some(bucket_id) = result.bucket_id()
        && candidate_ids.contains(bucket_id)
    {
        merged_ids.push(bucket_id.to_owned());
    }
    for candidate_id in &original_ids {
        if candidate_ids.contains(candidate_id.as_str())
            && !merged_ids.iter().any(|item| item == candidate_id)
        {
            merged_ids.push(candidate_id.clone());
        }
    }

    if result.action() == ClassificationAction::AppendExisting
        && result
            .bucket_id()
            .is_none_or(|bucket_id| !candidate_ids.contains(bucket_id))
    {
        return result.into_confirmation(
            "模型给出的目标不存在，请选择要归档到哪个 Bucket。",
            candidates
                .iter()
                .map(|candidate| candidate.id().to_owned())
                .collect(),
            "目标 Bucket ID 不在服务端候选列表中，已阻止自动归档。",
        );
    }

    let has_invalid_candidates = original_ids
        .iter()
        .any(|candidate_id| !candidate_ids.contains(candidate_id.as_str()));
    let should_include_server_candidates =
        result.action() == ClassificationAction::AskUser || has_invalid_candidates;
    if should_include_server_candidates {
        for candidate in candidates {
            if !merged_ids.iter().any(|item| item == candidate.id()) {
                merged_ids.push(candidate.id().to_owned());
            }
        }
    }

    if has_invalid_candidates {
        let question = result
            .question()
            .unwrap_or("请从有效候选中选择目标 Bucket。")
            .to_owned();
        return result.into_confirmation(
            question,
            merged_ids,
            "模型返回了不存在的候选 ID，已过滤并要求确认。",
        );
    }

    if result.action() == ClassificationAction::AskUser && merged_ids != original_ids {
        let question = result
            .question()
            .unwrap_or("请从活跃 Bucket 中选择归档目标。")
            .to_owned();
        return result.into_confirmation(
            question,
            merged_ids,
            "已补充服务端候选列表，方便用户确认归档目标。",
        );
    }

    Ok(result)
}

/// Convert uncertain or ambiguous automatic actions into confirmation.
pub fn apply_confidence_gate(
    result: ClassificationResult,
    policy: ConfidencePolicy,
) -> Result<ClassificationResult, CoreError> {
    if result.action() == ClassificationAction::AskUser {
        return Ok(result);
    }

    let likely_ids = likely_candidate_ids(&result);

    if likely_ids.len() > 1 {
        return result.into_confirmation(
            "多个 Bucket 都可能匹配，请确认本条内容的归属。",
            likely_ids,
            "存在多个相似候选，已降级为用户确认。",
        );
    }

    if result.confidence() >= policy.auto_archive_threshold() {
        return Ok(result);
    }

    let question = if result.confidence() >= policy.confirm_threshold() {
        if result.action() == ClassificationAction::CreateNew {
            "请确认是否创建这个新 Bucket。"
        } else {
            "分类置信度一般，请确认是否追加到该 Bucket。"
        }
    } else {
        "当前信息不足以安全归档，请确认目标 Bucket 或新建事务。"
    };

    result.into_confirmation(question, likely_ids, "置信度未达到自动归档阈值。")
}

/// Ask before automatically persisting vague or status-only input.
pub fn apply_low_information_reference_gate(
    text: &str,
    result: ClassificationResult,
) -> Result<ClassificationResult, CoreError> {
    if result.action() == ClassificationAction::AskUser || !is_low_information_reference(text) {
        return Ok(result);
    }

    let likely_ids = likely_candidate_ids(&result);

    let question = if result.action() == ClassificationAction::CreateNew {
        "输入只有模糊指代和低信息动作，请确认是否创建新 Bucket 或选择已有 Bucket。"
    } else {
        "输入只有模糊指代和低信息动作，请确认要追加到哪个 Bucket。"
    };

    result.into_confirmation(
        question,
        likely_ids,
        "输入缺少可核验事实、状态变化、决策或待办，已阻止高风险自动合并。",
    )
}

/// Apply all deterministic safeguards after an adapter parses the LLM output.
pub fn postprocess_classification(
    text: &str,
    result: ClassificationResult,
    candidates: &[BucketView],
    policy: ConfidencePolicy,
) -> Result<ClassificationResult, CoreError> {
    if text.trim().is_empty() {
        return Err(CoreError::EmptyText("text"));
    }

    let result = validate_candidate_reference(result, candidates)?;
    let result = apply_low_information_reference_gate(text.trim(), result)?;
    let result = apply_confidence_gate(result, policy)?;
    // Confidence and low-information gates can create a fresh ask_user result
    // after the first candidate validation pass. Populate its displayable
    // candidates as well, so clients never receive a confirmation without a
    // usable Bucket selector when active candidates exist.
    validate_candidate_reference(result, candidates)
}

fn is_low_information_reference(text: &str) -> bool {
    let has_vague_reference = VAGUE_REFERENCE_MARKERS
        .iter()
        .any(|marker| text.contains(marker));
    let has_low_information_action = LOW_INFORMATION_ACTION_MARKERS
        .iter()
        .any(|marker| text.contains(marker));
    let has_digit_or_percent = text
        .chars()
        .any(|character| character.is_numeric() || character == '%');
    let has_concrete_fact = has_digit_or_percent
        || CONCRETE_FACT_MARKERS
            .iter()
            .any(|marker| text.contains(marker));
    let compact_status_update = text.chars().count() <= LOW_INFORMATION_CHAR_LIMIT;

    // The first branch catches references such as “那个任务继续” and “校验
    // 相关的记一下”. The second catches inputs such as “压测结果更新了”、
    // “切备用后好了” and “它现在正常了”, which may not contain one of the
    // reference markers but still contain no durable fact.
    (has_vague_reference && has_low_information_action && !has_concrete_fact)
        || (has_low_information_action && compact_status_update && !has_concrete_fact)
}
