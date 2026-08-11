use chrono::{Duration, NaiveDate};
use work_memory_core::{BucketStatus, BucketType, ClassificationResult, ExtractionResult};
use work_memory_service::{CanonicalService, MemoryQuery, StructuredFieldFilter, TimeRange};
use work_memory_store::RustArchiveAudit;

mod support;

use support::TemporaryPath;

fn audit() -> RustArchiveAudit {
    RustArchiveAudit::new(vec![], None, "query-test-v1", "fixture-model").expect("audit")
}

fn extraction(summary: &str, evidence: &str, entity: &str, tag: &str) -> ExtractionResult {
    ExtractionResult::new(
        summary,
        vec![],
        vec![evidence.to_owned()],
        vec![],
        vec![],
        vec![],
        vec![entity.to_owned()],
        vec![tag.to_owned()],
    )
    .expect("extraction")
}

fn create_bucket(
    service: &mut CanonicalService,
    title: &str,
    raw_text: &str,
    summary: &str,
    evidence: &str,
    entity: &str,
    tag: &str,
) -> (String, String) {
    let outcome = service
        .archive(
            raw_text,
            ClassificationResult::create_new(
                BucketType::Experiment,
                title,
                0.99,
                "explicit query fixture bucket",
                vec![],
            )
            .expect("classification"),
            Some(extraction(summary, evidence, entity, tag)),
            audit(),
        )
        .expect("archive");
    (
        outcome.bucket_id.expect("bucket id"),
        outcome.entry_id.expect("entry id"),
    )
}

fn append_entry(
    service: &mut CanonicalService,
    bucket_id: &str,
    raw_text: &str,
    summary: &str,
    evidence: &str,
    entity: &str,
    tag: &str,
) -> String {
    service
        .archive(
            raw_text,
            ClassificationResult::append_existing(
                bucket_id,
                Some(BucketType::Experiment),
                0.98,
                "explicit query fixture append",
                vec![bucket_id.to_owned()],
            )
            .expect("classification"),
            Some(extraction(summary, evidence, entity, tag)),
            audit(),
        )
        .expect("archive")
        .entry_id
        .expect("entry id")
}

#[test]
fn parses_natural_language_entity_topic_and_relative_time() {
    let now = NaiveDate::from_ymd_opt(2026, 8, 6)
        .expect("date")
        .and_hms_opt(12, 0, 0)
        .expect("time");
    let plan = MemoryQuery::parse_at("查询接口 A 最近两周的压测结果", 20, now).expect("plan");

    assert_eq!(plan.entity_terms, ["接口 A"]);
    assert_eq!(plan.topic_terms, ["压测结果"]);
    assert_eq!(plan.terms, ["接口 A", "压测结果"]);
    let range = plan.time_range.expect("time range");
    assert_eq!(range.start, now - Duration::days(14));
    assert_eq!(range.end, now);

    let status_plan =
        MemoryQuery::parse_at("查询接口 A 最近两周的压测结果，并只看 ACTIVE 状态", 20, now)
            .expect("status plan");
    assert_eq!(status_plan.statuses, [BucketStatus::Active]);
    assert_eq!(status_plan.entity_terms, ["接口 A"]);
    assert_eq!(status_plan.topic_terms, ["压测结果"]);
}

#[test]
fn returns_multiple_entries_and_buckets_with_deduplicated_evidence() {
    let database = TemporaryPath::new("natural-language-query");
    let mut service = CanonicalService::initialize(database.path()).expect("service");
    let (first_bucket, _) = create_bucket(
        &mut service,
        "接口 A 压测",
        "接口 A 首轮压测完成，P99 为 120ms。",
        "接口 A 压测结果：P99 为 120ms。",
        "P99 为 120ms",
        "接口 A",
        "压测",
    );
    append_entry(
        &mut service,
        &first_bucket,
        "接口 A 第二轮压测完成，P99 为 110ms。",
        "接口 A 压测结果：P99 为 110ms。",
        "P99 为 120ms",
        "接口 A",
        "压测",
    );
    let (second_bucket, _) = create_bucket(
        &mut service,
        "接口 A 回归",
        "接口 A 回归测试发现无错误。",
        "接口 A 压测回归结果：无错误。",
        "P99 为 120ms",
        "接口 A",
        "回归",
    );

    let plan = MemoryQuery::parse("查询接口 A 最近两周的压测结果", 20).expect("plan");
    let response = service
        .query_memory_with_plan(plan)
        .expect("query response");

    assert_eq!(response.results.len(), 3);
    assert_eq!(response.buckets.len(), 2);
    assert!(
        response
            .buckets
            .iter()
            .any(|group| group.bucket.id == first_bucket)
    );
    assert!(
        response
            .buckets
            .iter()
            .any(|group| group.bucket.id == second_bucket)
    );
    assert_eq!(
        response
            .evidence
            .iter()
            .filter(|memory| memory.text == "P99 为 120ms")
            .count(),
        1
    );
    assert!(response.answer.contains("3 条相关 Entry"));
    for marker in [
        "接口 A 压测",
        "接口 A 回归",
        "P99 为 120ms",
        "P99 为 110ms",
        "无错误",
    ] {
        assert!(
            response.answer.contains(marker),
            "answer should synthesize marker: {marker}; answer was: {}",
            response.answer
        );
    }
}

#[test]
fn searches_entry_summary_entity_tag_and_applies_structured_and_time_filters() {
    let database = TemporaryPath::new("natural-language-filters");
    let mut service = CanonicalService::initialize(database.path()).expect("service");
    let (bucket_id, _entry_id) = create_bucket(
        &mut service,
        "接口 A 质量",
        "原文没有直接写压测主题。",
        "压测结果摘要位于 summary 字段。",
        "共享证据",
        "接口 A",
        "性能",
    );
    let counts_before = service.counts().expect("counts before");

    let summary_plan = MemoryQuery::parse("压测结果摘要", 10).expect("summary plan");
    assert_eq!(
        service
            .query_memory_with_plan(summary_plan)
            .expect("summary query")
            .results
            .len(),
        1
    );

    let entity_plan = MemoryQuery::parse("接口 A", 10).expect("entity plan");
    assert_eq!(
        service
            .query_memory_with_plan(entity_plan)
            .expect("entity query")
            .results
            .len(),
        1
    );

    let tag_filter = StructuredFieldFilter::new("tag", "性能").expect("tag filter");
    let filtered_plan = MemoryQuery::parse("质量", 10)
        .expect("filtered plan")
        .with_structured_filters(vec![tag_filter])
        .expect("structured plan");
    let filtered = service
        .query_memory_with_plan(filtered_plan)
        .expect("filtered query");
    assert_eq!(filtered.results.len(), 1);
    assert_eq!(filtered.results[0].bucket.id, bucket_id);

    let future_range = TimeRange::new(
        NaiveDate::from_ymd_opt(2099, 1, 1)
            .expect("future date")
            .and_hms_opt(0, 0, 0)
            .expect("future start"),
        NaiveDate::from_ymd_opt(2099, 1, 2)
            .expect("future date")
            .and_hms_opt(0, 0, 0)
            .expect("future end"),
        "future",
    )
    .expect("time range");
    let no_results = service
        .query_memory_with_plan(
            MemoryQuery::parse("质量", 10)
                .expect("time plan")
                .with_time_range(Some(future_range)),
        )
        .expect("time query");
    assert!(no_results.results.is_empty());

    assert_eq!(service.counts().expect("counts after"), counts_before);
}

#[test]
fn status_filter_includes_archived_lifecycle_when_requested() {
    let database = TemporaryPath::new("natural-language-status");
    let mut service = CanonicalService::initialize(database.path()).expect("service");
    let (bucket_id, _) = create_bucket(
        &mut service,
        "归档压测记录",
        "接口 B 压测已经归档。",
        "接口 B 压测结果",
        "归档证据",
        "接口 B",
        "压测",
    );
    service
        .set_bucket_status(&bucket_id, BucketStatus::Archived)
        .expect("archive bucket status");

    let active_plan = MemoryQuery::parse("接口 B 压测", 10)
        .expect("active plan")
        .with_statuses(vec![BucketStatus::Active]);
    let active = service
        .query_memory_with_plan(active_plan)
        .expect("active query");
    assert!(active.results.is_empty());

    let archived_plan = MemoryQuery::parse("查询接口 B 压测 已归档", 10).expect("status plan");
    let archived = service
        .query_memory_with_plan(archived_plan)
        .expect("archived query");
    assert_eq!(archived.results.len(), 1);
    assert_eq!(archived.results[0].bucket.status, BucketStatus::Archived);
}

#[test]
fn rejects_invalid_query_inputs() {
    assert!(MemoryQuery::parse("  ", 10).is_err());
    assert!(MemoryQuery::parse("query", 0).is_err());
    assert!(TimeRange::from_strings("not-a-date", "2026-08-06", "bad").is_err());
    assert!(TimeRange::from_strings("2026-08-07", "2026-08-06", "backwards").is_err());
}
