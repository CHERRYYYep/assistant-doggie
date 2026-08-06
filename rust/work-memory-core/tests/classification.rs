use work_memory_core::{
    BucketStatus, BucketType, BucketView, ClassificationAction, ClassificationResult,
    ConfidencePolicy, CoreError, apply_confidence_gate, apply_low_information_reference_gate,
    build_bucket_candidates, postprocess_classification, validate_candidate_reference,
};

fn bucket(id: &str, title: &str, last_active_at_unix_ms: i64) -> BucketView {
    BucketView::new(
        id,
        title,
        BucketType::Incident,
        BucketStatus::Active,
        "摘要",
        vec![" payment ".to_owned(), "payment".to_owned()],
        last_active_at_unix_ms,
    )
    .unwrap()
}

#[test]
fn classification_contract_rejects_inconsistent_actions() {
    let error = ClassificationResult::try_new(
        ClassificationAction::AppendExisting,
        None,
        None,
        None,
        0.91,
        "缺少目标 bucket。",
        false,
        None,
        vec![],
    )
    .unwrap_err();
    assert_eq!(
        error,
        CoreError::InconsistentClassification("append_existing requires bucket_id")
    );

    let error =
        ClassificationResult::create_new(BucketType::Idea, "新想法", 1.2, "新主题。", vec![])
            .unwrap_err();
    assert_eq!(error, CoreError::ConfidenceOutOfRange(1.2));
}

#[test]
fn classification_contract_normalizes_text_and_candidate_ids() {
    let result = ClassificationResult::ask_user(
        None,
        None,
        0.31,
        "  两个 bucket 都可能匹配。  ",
        "  这条内容属于哪一个？  ",
        vec![
            " bucket-1 ".to_owned(),
            "bucket-1".to_owned(),
            "".to_owned(),
            "bucket-2".to_owned(),
        ],
    )
    .unwrap();

    assert_eq!(result.reason(), "两个 bucket 都可能匹配。");
    assert_eq!(result.question(), Some("这条内容属于哪一个？"));
    assert_eq!(
        result.candidate_bucket_ids(),
        &["bucket-1".to_owned(), "bucket-2".to_owned()]
    );
    assert!(result.should_ask_user());
}

#[test]
fn bucket_view_normalizes_fields() {
    let view = BucketView::new(
        " bucket-1 ",
        " 支付故障 ",
        BucketType::Incident,
        BucketStatus::Active,
        " 摘要 ",
        vec![" payment ".to_owned(), "payment".to_owned()],
        100,
    )
    .unwrap();

    assert_eq!(view.id(), "bucket-1");
    assert_eq!(view.title(), "支付故障");
    assert_eq!(view.summary(), "摘要");
    assert_eq!(view.tags(), &["payment".to_owned()]);
}

#[test]
fn candidates_put_focus_first_then_sort_by_recency_and_deduplicate() {
    let candidates = build_bucket_candidates(
        vec![
            bucket("older", "旧事务", 100),
            bucket("focus", "焦点旧标题", 50),
            bucket("newer", "最新事务", 300),
            bucket("focus", "焦点新标题", 200),
        ],
        Some("focus"),
        2,
    )
    .unwrap();

    assert_eq!(
        candidates.iter().map(BucketView::id).collect::<Vec<_>>(),
        vec!["focus", "newer"]
    );
    assert_eq!(candidates[0].title(), "焦点新标题");
}

#[test]
fn candidate_limit_must_be_positive() {
    let error = build_bucket_candidates(vec![], None, 0).unwrap_err();
    assert_eq!(error, CoreError::CandidateLimitTooSmall);
}

#[test]
fn generated_bucket_id_outside_server_candidates_requires_confirmation() {
    let result = ClassificationResult::append_existing(
        "invented",
        Some(BucketType::Incident),
        0.99,
        "模型认为是同一故障。",
        vec![],
    )
    .unwrap();
    let candidates = vec![bucket("bucket-1", "支付故障", 100)];

    let gated = validate_candidate_reference(result, &candidates).unwrap();

    assert_eq!(gated.action(), ClassificationAction::AskUser);
    assert_eq!(gated.bucket_id(), None);
    assert_eq!(gated.candidate_bucket_ids(), &["bucket-1".to_owned()]);
    assert!(
        gated
            .reason()
            .contains("目标 Bucket ID 不在服务端候选列表中")
    );
}

#[test]
fn invalid_suggested_candidates_are_filtered() {
    let result = ClassificationResult::ask_user(
        None,
        None,
        0.4,
        "需要确认。",
        "请选择。",
        vec!["bucket-1".to_owned(), "invented".to_owned()],
    )
    .unwrap();
    let candidates = vec![bucket("bucket-1", "支付故障", 100)];

    let gated = validate_candidate_reference(result, &candidates).unwrap();

    assert_eq!(gated.action(), ClassificationAction::AskUser);
    assert_eq!(gated.candidate_bucket_ids(), &["bucket-1".to_owned()]);
    assert!(gated.reason().contains("模型返回了不存在的候选 ID"));
}

#[test]
fn ambiguous_result_requires_confirmation_even_with_high_confidence() {
    let result = ClassificationResult::append_existing(
        "bucket-1",
        Some(BucketType::Incident),
        0.99,
        "两个事务相似。",
        vec!["bucket-1".to_owned(), "bucket-2".to_owned()],
    )
    .unwrap();

    let gated = apply_confidence_gate(result, ConfidencePolicy::default()).unwrap();

    assert_eq!(gated.action(), ClassificationAction::AskUser);
    assert_eq!(
        gated.question(),
        Some("多个 Bucket 都可能匹配，请确认本条内容的归属。")
    );
}

#[test]
fn confidence_gate_preserves_high_confidence_unique_result() {
    let result = ClassificationResult::append_existing(
        "bucket-1",
        Some(BucketType::Incident),
        0.91,
        "同一支付故障。",
        vec![],
    )
    .unwrap();

    let gated = apply_confidence_gate(result, ConfidencePolicy::default()).unwrap();

    assert_eq!(gated.action(), ClassificationAction::AppendExisting);
    assert_eq!(gated.bucket_id(), Some("bucket-1"));
}

#[test]
fn confidence_gate_uses_medium_and_low_confirmation_messages() {
    let medium = ClassificationResult::create_new(
        BucketType::Experiment,
        "接口压测",
        0.7,
        "新实验。",
        vec![],
    )
    .unwrap();
    let low = ClassificationResult::append_existing(
        "bucket-1",
        Some(BucketType::Incident),
        0.2,
        "信息不足。",
        vec![],
    )
    .unwrap();

    let medium = apply_confidence_gate(medium, ConfidencePolicy::default()).unwrap();
    let low = apply_confidence_gate(low, ConfidencePolicy::default()).unwrap();

    assert_eq!(medium.question(), Some("请确认是否创建这个新 Bucket。"));
    assert_eq!(
        low.question(),
        Some("当前信息不足以安全归档，请确认目标 Bucket 或新建事务。")
    );
}

#[test]
fn low_information_reference_blocks_automatic_append() {
    let result = ClassificationResult::append_existing(
        "bucket-1",
        Some(BucketType::Task),
        0.95,
        "指向当前焦点。",
        vec![],
    )
    .unwrap();

    let gated = apply_low_information_reference_gate("刚才那个继续处理一下", result).unwrap();

    assert_eq!(gated.action(), ClassificationAction::AskUser);
    assert_eq!(
        gated.question(),
        Some("输入只有模糊指代和低信息动作，请确认要追加到哪个 Bucket。")
    );
}

#[test]
fn concrete_fact_allows_a_referenced_append_to_continue() {
    let result = ClassificationResult::append_existing(
        "bucket-1",
        Some(BucketType::Incident),
        0.95,
        "指向当前焦点并包含状态。",
        vec![],
    )
    .unwrap();

    let gated =
        apply_low_information_reference_gate("刚才那个继续处理一下，错误率已经降到 2%", result)
            .unwrap();

    assert_eq!(gated.action(), ClassificationAction::AppendExisting);
}

#[test]
fn unicode_digits_count_as_concrete_facts() {
    let result = ClassificationResult::append_existing(
        "bucket-1",
        Some(BucketType::Incident),
        0.95,
        "指向当前焦点并包含状态。",
        vec![],
    )
    .unwrap();

    let gated =
        apply_low_information_reference_gate("刚才那个继续处理一下，重试了３次", result).unwrap();

    assert_eq!(gated.action(), ClassificationAction::AppendExisting);
}

#[test]
fn empty_workspace_requires_confirmation_for_medium_confidence_new_bucket() {
    let result = ClassificationResult::create_new(
        BucketType::Task,
        "准备 Rust 重构",
        0.7,
        "工作区为空且输入是明确的新任务。",
        vec![],
    )
    .unwrap();

    let gated = postprocess_classification(
        "开始准备 Rust 重构",
        result,
        &[],
        ConfidencePolicy::default(),
    )
    .unwrap();

    assert_eq!(gated.action(), ClassificationAction::AskUser);
    assert_eq!(gated.question(), Some("请确认是否创建这个新 Bucket。"));
}

#[test]
fn empty_workspace_can_bootstrap_a_high_confidence_bucket() {
    let result = ClassificationResult::create_new(
        BucketType::Task,
        "准备 Rust 重构",
        0.99,
        "工作区为空且输入是明确的新任务。",
        vec![],
    )
    .unwrap();

    let gated = postprocess_classification(
        "开始准备 Rust 重构",
        result,
        &[],
        ConfidencePolicy::default(),
    )
    .unwrap();

    assert_eq!(gated.action(), ClassificationAction::CreateNew);
}

#[test]
fn confidence_policy_rejects_invalid_order_and_non_finite_values() {
    assert!(ConfidencePolicy::new(0.5, 0.8).is_err());
    assert!(ConfidencePolicy::new(f64::NAN, 0.5).is_err());
    assert_eq!(
        ConfidencePolicy::new(0.9, 0.6)
            .unwrap()
            .auto_archive_threshold(),
        0.9
    );
}
