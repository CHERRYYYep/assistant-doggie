use std::collections::VecDeque;

use tempfile::tempdir;
use work_memory_core::{
    BucketType, ClassificationResult, ConfidencePolicy, ExtractionResult, TimelineEventExtract,
};
use work_memory_runtime::{CanonicalRuntime, MemoryModel};
use work_memory_service::CanonicalService;

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
        vec!["the MVP is safe".to_owned()],
        vec!["Rust".to_owned()],
        vec!["mvp".to_owned()],
    )
    .expect("extraction")
}

fn service(path: &std::path::Path) -> CanonicalService {
    CanonicalService::initialize(path).expect("canonical service")
}

fn runtime(service: CanonicalService, model: FixedModel) -> CanonicalRuntime<FixedModel> {
    CanonicalRuntime::new(
        service,
        model,
        ConfidencePolicy::default(),
        "fixture-model",
        "runtime-test-v1",
    )
    .expect("runtime")
}

#[test]
fn archive_runs_the_complete_rust_mvp_loop() {
    let directory = tempdir().expect("tempdir");
    let classification = ClassificationResult::create_new(
        BucketType::Incident,
        "Payment callback",
        0.99,
        "new incident",
        vec![],
    )
    .expect("classification");
    let mut runtime = runtime(
        service(&directory.path().join("memory.db")),
        FixedModel::new(
            [Ok(classification)],
            [Ok(rich_extraction("callback restored"))],
        ),
    );

    let execution = runtime
        .archive("The payment callback was restored.", None)
        .expect("archive");

    assert_eq!(execution.outcome.archive_state, "archived");
    assert!(execution.outcome.entry_id.is_some());
    assert_eq!(execution.outcome.memory_item_ids.len(), 7);
    let counts = runtime.service().counts().expect("counts");
    assert_eq!(counts.buckets, 1);
    assert_eq!(counts.entries, 1);
    assert_eq!(counts.memory_items, 7);
    assert_eq!(counts.archive_attempts, 1);

    let bucket_id = execution.outcome.bucket_id.expect("bucket id");
    let detail = runtime
        .service()
        .bucket_detail(&bucket_id)
        .expect("detail")
        .expect("bucket detail");
    assert_eq!(detail.entries.len(), 1);
    assert_eq!(detail.memories.len(), 7);
}

#[test]
fn low_confidence_archive_only_creates_a_confirmation_attempt() {
    let directory = tempdir().expect("tempdir");
    let classification = ClassificationResult::create_new(
        BucketType::Task,
        "Payment follow-up",
        0.40,
        "uncertain",
        vec![],
    )
    .expect("classification");
    let mut runtime = runtime(
        service(&directory.path().join("memory.db")),
        FixedModel::new([Ok(classification)], []),
    );

    let execution = runtime
        .archive("A concrete payment fact.", None)
        .expect("attempt");

    assert_eq!(execution.outcome.archive_state, "needs_confirmation");
    assert!(execution.outcome.bucket_id.is_none());
    assert!(execution.outcome.entry_id.is_none());
    assert!(execution.extraction.is_none());
    let counts = runtime.service().counts().expect("counts");
    assert_eq!(counts.buckets, 0);
    assert_eq!(counts.entries, 0);
    assert_eq!(counts.archive_attempts, 1);
}

#[test]
fn confirmed_append_and_create_are_explicit_rust_writes() {
    let directory = tempdir().expect("tempdir");
    let seed =
        ClassificationResult::create_new(BucketType::Task, "Canonical MVP", 0.99, "seed", vec![])
            .expect("seed classification");
    let mut runtime = runtime(
        service(&directory.path().join("memory.db")),
        FixedModel::new(
            [Ok(seed)],
            [
                Ok(ExtractionResult::minimal("seed").expect("seed extraction")),
                Ok(ExtractionResult::minimal("append").expect("append extraction")),
                Ok(ExtractionResult::minimal("create").expect("create extraction")),
            ],
        ),
    );

    let initial = runtime
        .archive("The Rust MVP is started.", None)
        .expect("initial archive");
    let source_bucket = initial.outcome.bucket_id.expect("source bucket");

    let appended = runtime
        .append_confirmed(
            &source_bucket,
            "The Rust MVP now persists entries.",
            Some(source_bucket.clone()),
        )
        .expect("append");
    assert_eq!(
        appended.outcome.bucket_id.as_deref(),
        Some(source_bucket.as_str())
    );
    assert!(appended.outcome.entry_id.is_some());

    let created = runtime
        .create_confirmed(
            "Second Rust bucket",
            BucketType::Experiment,
            "A separately confirmed memory.",
            None,
        )
        .expect("create");
    assert_eq!(created.outcome.archive_state, "archived");
    assert_ne!(
        created.outcome.bucket_id.as_deref(),
        Some(source_bucket.as_str())
    );

    let counts = runtime.service().counts().expect("counts");
    assert_eq!(counts.buckets, 2);
    assert_eq!(counts.entries, 3);
    assert_eq!(counts.archive_attempts, 3);
}

#[test]
fn archive_state_survives_reopening_the_rust_database() {
    let directory = tempdir().expect("tempdir");
    let database = directory.path().join("memory.db");
    let classification = ClassificationResult::create_new(
        BucketType::Idea,
        "Rust-only memory",
        0.99,
        "new idea",
        vec![],
    )
    .expect("classification");
    let mut runtime = runtime(
        service(&database),
        FixedModel::new(
            [Ok(classification)],
            [Ok(
                ExtractionResult::minimal("persisted").expect("extraction")
            )],
        ),
    );
    let execution = runtime
        .archive("Persist this fact.", None)
        .expect("archive");
    let bucket_id = execution.outcome.bucket_id.expect("bucket id");
    drop(runtime);

    let reopened = CanonicalService::open_existing(&database).expect("reopen");
    let detail = reopened
        .bucket_detail(&bucket_id)
        .expect("detail")
        .expect("bucket");
    assert_eq!(detail.entries.len(), 1);
    assert_eq!(detail.entries[0].raw_text, "Persist this fact.");
}
