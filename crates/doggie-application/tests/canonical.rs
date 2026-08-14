use doggie_application::{CanonicalService, CanonicalServiceError};
use doggie_domain::{
    BucketStatus, BucketType, ClassificationAction, ClassificationResult, ExtractionResult,
};
use doggie_storage_sqlite::{ChatRole, DoggieArchiveAudit};
use serde_json::json;

mod support;

use support::TemporaryPath;

fn audit() -> DoggieArchiveAudit {
    DoggieArchiveAudit::new(vec![], None, "canonical-test-v1", "fixture-model").expect("audit")
}

fn extraction(summary: &str) -> ExtractionResult {
    ExtractionResult::minimal(summary).expect("extraction")
}

#[test]
fn canonical_facade_covers_archive_chat_history_and_correction() {
    let database = TemporaryPath::new("canonical-service");
    let mut service = CanonicalService::initialize(database.path()).expect("canonical database");

    let created = service
        .archive(
            "Initial incident note.",
            ClassificationResult::create_new(
                BucketType::Incident,
                "Callback incident",
                0.99,
                "new incident",
                vec![],
            )
            .expect("create classification"),
            Some(extraction("Initial incident summary")),
            audit(),
        )
        .expect("create_new archive");
    assert_eq!(created.archive_state, "archived");
    let source_bucket_id = created.bucket_id.clone().expect("source bucket");
    let source_entry_id = created.entry_id.clone().expect("source entry");

    let appended = service
        .archive(
            "Follow-up incident note.",
            ClassificationResult::append_existing(
                source_bucket_id.clone(),
                Some(BucketType::Incident),
                0.96,
                "continues incident",
                vec![source_bucket_id.clone()],
            )
            .expect("append classification"),
            Some(extraction("Follow-up summary")),
            audit(),
        )
        .expect("append_existing archive");
    assert_eq!(
        appended.bucket_id.as_deref(),
        Some(source_bucket_id.as_str())
    );
    assert!(appended.entry_id.is_some());

    let awaiting_confirmation = service
        .archive(
            "An ambiguous note.",
            ClassificationResult::ask_user(
                Some(BucketType::Incident),
                Some("Possible incident".to_owned()),
                0.40,
                "two possible destinations",
                "Which incident should receive this note?",
                vec![source_bucket_id.clone()],
            )
            .expect("ask classification"),
            None,
            audit(),
        )
        .expect("ask_user archive");
    assert_eq!(awaiting_confirmation.archive_state, "needs_confirmation");
    assert!(awaiting_confirmation.entry_id.is_none());
    assert!(awaiting_confirmation.bucket_id.is_none());

    let destination = service
        .archive(
            "Destination bucket seed.",
            ClassificationResult::create_new(
                BucketType::Task,
                "Callback follow-up",
                0.99,
                "new destination",
                vec![],
            )
            .expect("destination classification"),
            Some(extraction("Destination summary")),
            audit(),
        )
        .expect("destination archive");
    let destination_bucket_id = destination.bucket_id.expect("destination bucket");

    let user_message = service
        .append_chat_message(
            ChatRole::User,
            "Please move the initial note.",
            None,
            None,
            Some(json!({"source": "test"})),
        )
        .expect("user message");
    let assistant_message = service
        .append_chat_message(ChatRole::Assistant, "Moved the note.", None, None, None)
        .expect("assistant message");
    assert_eq!(user_message.sequence, 1);
    assert_eq!(assistant_message.sequence, 2);

    let moved = service
        .move_entry(
            &source_entry_id,
            &destination_bucket_id,
            "Move initial incident note to follow-up bucket.",
        )
        .expect("move entry");
    assert_eq!(moved.id, source_entry_id);
    assert_eq!(moved.bucket_id, destination_bucket_id);

    let source_detail = service
        .bucket_detail(&source_bucket_id)
        .expect("source detail")
        .expect("source bucket exists");
    assert_eq!(source_detail.entries.len(), 1);
    assert_eq!(source_detail.entries[0].bucket_id, source_bucket_id);

    let destination_detail = service
        .bucket_detail(&destination_bucket_id)
        .expect("destination detail")
        .expect("destination bucket exists");
    assert_eq!(destination_detail.entries.len(), 2);
    assert_eq!(destination_detail.entries[0].id, source_entry_id);
    assert_eq!(
        destination_detail.entries[0]
            .moved_from_bucket_id
            .as_deref(),
        Some(source_bucket_id.as_str())
    );

    let active = service.list_active_buckets(10).expect("active buckets");
    assert_eq!(active.len(), 2);
    let search_hits = service.search("follow-up", 10).expect("search");
    assert_eq!(search_hits.len(), 2);
    assert!(
        search_hits
            .iter()
            .any(|hit| hit.bucket.id == destination_bucket_id)
    );

    let history = service.history(20).expect("history");
    assert_eq!(history.archive_attempts.len(), 4);
    assert_eq!(history.chat_messages.len(), 2);
    assert_eq!(history.corrections.len(), 1);
    assert!(
        history
            .archive_attempts
            .iter()
            .any(|attempt| attempt.action == ClassificationAction::AskUser
                && attempt.archive_state == "needs_confirmation")
    );

    let counts = service.counts().expect("counts");
    assert_eq!(counts.buckets, 2);
    assert_eq!(counts.entries, 3);
    assert_eq!(counts.archive_attempts, 4);
    assert_eq!(counts.corrections, 1);
    assert_eq!(counts.chat_messages, 2);

    let paused = service
        .set_bucket_status(&destination_bucket_id, BucketStatus::Paused)
        .expect("pause bucket");
    assert_eq!(paused.status, BucketStatus::Paused);

    assert!(matches!(
        service.archive(
            "invalid automatic request",
            ClassificationResult::create_new(BucketType::Idea, "Invalid", 0.99, "test", vec![],)
                .expect("classification"),
            None,
            audit(),
        ),
        Err(CanonicalServiceError::MissingExtraction { .. })
    ));
}

#[test]
fn active_bucket_views_interleave_recent_and_popular_and_ignore_focus() {
    let database = TemporaryPath::new("canonical-service-candidates");
    let mut service = CanonicalService::initialize(database.path()).expect("canonical database");

    let popular = service
        .archive(
            "热门上下文第一条事实。",
            ClassificationResult::create_new(
                BucketType::Task,
                "热门上下文",
                0.99,
                "popular",
                vec![],
            )
            .expect("classification"),
            Some(extraction("popular 1")),
            audit(),
        )
        .expect("popular create");
    let popular_bucket_id = popular.bucket_id.expect("popular bucket");
    for index in 2..=3 {
        service
            .archive(
                format!("热门上下文第 {index} 条事实。"),
                ClassificationResult::append_existing(
                    popular_bucket_id.clone(),
                    Some(BucketType::Task),
                    0.99,
                    "popular append",
                    vec![popular_bucket_id.clone()],
                )
                .expect("classification"),
                Some(extraction(&format!("popular {index}"))),
                audit(),
            )
            .expect("popular append");
    }
    let recent = service
        .archive(
            "最近上下文的一条事实。",
            ClassificationResult::create_new(
                BucketType::Task,
                "最近上下文",
                0.99,
                "recent",
                vec![],
            )
            .expect("classification"),
            Some(extraction("recent")),
            audit(),
        )
        .expect("recent create");
    let recent_bucket_id = recent.bucket_id.expect("recent bucket");

    let candidates = service
        .active_bucket_views(2, Some(popular_bucket_id.as_str()))
        .expect("candidate views");
    assert_eq!(
        candidates
            .iter()
            .map(doggie_domain::BucketView::id)
            .collect::<Vec<_>>(),
        vec![recent_bucket_id.as_str(), popular_bucket_id.as_str()],
        "manual focus must not replace the automatic recent + popular ordering"
    );
}

#[test]
fn delete_bucket_facade_removes_active_bucket_and_history_entries() {
    let database = TemporaryPath::new("canonical-service-delete");
    let mut service = CanonicalService::initialize(database.path()).expect("canonical database");
    let created = service
        .archive(
            "待删除 Bucket 的事实。",
            ClassificationResult::create_new(BucketType::Task, "待删除", 0.99, "delete", vec![])
                .expect("classification"),
            Some(extraction("delete summary")),
            audit(),
        )
        .expect("archive");
    let bucket_id = created.bucket_id.expect("bucket id");
    let entry_id = created.entry_id.expect("entry id");

    let outcome = service
        .delete_bucket(&bucket_id, "用户删除 Bucket。")
        .expect("delete bucket");
    assert_eq!(outcome.bucket_id, bucket_id);
    assert_eq!(outcome.deleted_entry_ids, [entry_id]);
    assert!(
        service
            .get_bucket(&bucket_id)
            .expect("bucket lookup")
            .is_none()
    );
    assert!(
        service
            .bucket_detail(&bucket_id)
            .expect("detail lookup")
            .is_none()
    );
    assert!(
        service
            .list_active_buckets(10)
            .expect("active buckets")
            .into_iter()
            .all(|bucket| bucket.id != bucket_id)
    );
    assert!(matches!(
        service.delete_bucket(&bucket_id, "重复删除。"),
        Err(CanonicalServiceError::Store(
            doggie_storage_sqlite::StoreError::MissingRecord {
                table: "buckets",
                ..
            }
        ))
    ));
}
