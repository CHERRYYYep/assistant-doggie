mod support;

use doggie_domain::{
    BucketStatus, BucketType, ClassificationAction, ClassificationResult, ExtractionResult,
    TimelineEventExtract,
};
use doggie_protocol::ChatRole;
use doggie_storage_sqlite::{DoggieArchiveAudit, DoggieStore, MemoryKind, StoreError};
use serde_json::json;
use support::TemporaryPath;

#[test]
fn canonical_archive_preserves_all_memory_kinds_and_supports_search() {
    let database = TemporaryPath::new("canonical-archive");
    let mut store = DoggieStore::initialize(database.path()).expect("canonical schema");
    let classification = ClassificationResult::create_new(
        BucketType::Incident,
        "Payment callback incident",
        0.95,
        "Creates the incident work context.",
        vec![],
    )
    .expect("classification");
    let extraction = ExtractionResult::new(
        "Investigating the callback incident.",
        vec!["Review callback dashboard.".to_owned()],
        vec!["Callback error rate is below 0.1%.".to_owned()],
        vec![
            TimelineEventExtract::new(Some("last Friday".to_owned()), "The proxy was restarted.")
                .expect("timeline"),
        ],
        vec!["Keep traffic on the recovered proxy pool.".to_owned()],
        vec!["The callback path is stable.".to_owned()],
        vec!["Payment API".to_owned()],
        vec!["payments".to_owned(), "callback".to_owned()],
    )
    .expect("extraction");

    let outcome = store
        .archive(
            "Payment callback returned 502.",
            classification,
            Some(extraction),
            DoggieArchiveAudit::new(
                vec!["candidate-a".to_owned()],
                Some("focus-bucket".to_owned()),
                "doggie-classification-v1",
                "fixture-model",
            )
            .expect("audit"),
        )
        .expect("archive");
    let bucket_id = outcome.bucket_id.as_deref().expect("created bucket");
    let entry_id = outcome.entry_id.as_deref().expect("created entry");
    assert_eq!(outcome.archive_state, "archived");
    assert_eq!(outcome.memory_item_ids.len(), 8);

    let detail = store
        .bucket_detail(bucket_id)
        .expect("bucket detail query")
        .expect("bucket detail exists");
    assert_eq!(detail.entries.len(), 1);
    assert_eq!(detail.entries[0].id, entry_id);
    assert_eq!(detail.entries[0].raw_text, "Payment callback returned 502.");
    assert_eq!(detail.memories.len(), 8);
    assert!(
        detail
            .memories
            .iter()
            .any(|item| item.kind == MemoryKind::Todo && item.status.as_deref() == Some("open"))
    );
    assert!(detail.memories.iter().any(|item| {
        item.kind == MemoryKind::Timeline && item.occurred_at.as_deref() == Some("last Friday")
    }));
    assert!(
        detail
            .memories
            .iter()
            .any(|item| item.kind == MemoryKind::Decision)
    );
    assert!(
        detail
            .memories
            .iter()
            .any(|item| item.kind == MemoryKind::Hypothesis)
    );
    assert!(
        detail
            .memories
            .iter()
            .any(|item| item.kind == MemoryKind::Entity)
    );
    assert!(
        detail
            .memories
            .iter()
            .any(|item| item.kind == MemoryKind::Tag)
    );

    let bucket = store
        .get_bucket(bucket_id)
        .expect("bucket query")
        .expect("bucket");
    assert_eq!(bucket.tags, ["payments", "callback"]);
    assert_eq!(bucket.summary, "Investigating the callback incident.");
    assert_eq!(bucket.status, BucketStatus::Active);
    let hits = store.search("callback", 10).expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].bucket.id, bucket_id);
    assert_eq!(hits[0].matched_entry_count, 1);
    assert!(hits[0].score > 0);
    assert!(matches!(
        store.search("  ", 10),
        Err(StoreError::InvalidWriteField { field: "query", .. })
    ));
}

#[test]
fn canonical_archive_supports_append_confirmation_chat_and_move_correction() {
    let database = TemporaryPath::new("canonical-workflow");
    let mut store = DoggieStore::initialize(database.path()).expect("canonical schema");
    let audit = DoggieArchiveAudit::new(vec![], None, "doggie-v1", "test-model").expect("audit");

    let first = store
        .archive(
            "Initial callback note.",
            ClassificationResult::create_new(
                BucketType::Incident,
                "Callback incident",
                0.99,
                "initial",
                vec![],
            )
            .expect("classification"),
            Some(
                ExtractionResult::new(
                    "Initial summary",
                    vec!["Initial follow-up".to_owned()],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                )
                .expect("extraction"),
            ),
            audit.clone(),
        )
        .expect("first archive");
    let original_bucket_id = first.bucket_id.clone().expect("original bucket");
    let original_entry_id = first.entry_id.clone().expect("original entry");

    let appended = store
        .archive(
            "Follow-up callback note.",
            ClassificationResult::append_existing(
                original_bucket_id.clone(),
                Some(BucketType::Incident),
                0.93,
                "continues incident",
                vec![original_bucket_id.clone()],
            )
            .expect("classification"),
            Some(
                ExtractionResult::new(
                    "Follow-up summary",
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec!["follow-up".to_owned()],
                )
                .expect("extraction"),
            ),
            audit.clone(),
        )
        .expect("append archive");
    assert_eq!(
        appended.bucket_id.as_deref(),
        Some(original_bucket_id.as_str())
    );
    assert!(appended.entry_id.is_some());

    let pending = store
        .archive(
            "Put this somewhere else.",
            ClassificationResult::ask_user(
                Some(BucketType::Incident),
                None,
                0.35,
                "ambiguous target",
                "Choose a bucket",
                vec![original_bucket_id.clone()],
            )
            .expect("classification"),
            None,
            audit,
        )
        .expect("pending archive");
    assert_eq!(pending.archive_state, "needs_confirmation");
    assert!(pending.entry_id.is_none());

    let user_message = store
        .append_chat_message(ChatRole::User, "Move the callback note.", None, None, None)
        .expect("user message");
    let assistant_message = store
        .append_chat_message(
            ChatRole::Assistant,
            "I will move it.",
            Some("move_entry".to_owned()),
            Some("call-1".to_owned()),
            Some(json!({"entry_id": original_entry_id})),
        )
        .expect("assistant message");
    assert_eq!(user_message.sequence, 1);
    assert_eq!(assistant_message.sequence, 2);
    let messages = store.list_chat_messages(10).expect("messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, ChatRole::User);
    assert_eq!(
        messages[1].details,
        Some(json!({"entry_id": original_entry_id}))
    );

    let second = store
        .archive(
            "A separate task note.",
            ClassificationResult::create_new(
                BucketType::Task,
                "Separate task",
                0.99,
                "separate",
                vec![],
            )
            .expect("classification"),
            Some(ExtractionResult::minimal("Task summary").expect("extraction")),
            DoggieArchiveAudit::new(vec![], None, "doggie-v1", "test-model").expect("audit"),
        )
        .expect("second archive");
    let second_bucket_id = second.bucket_id.expect("second bucket");

    let correction_count_before_same_bucket_move = store
        .list_corrections(None, None, 10)
        .expect("correction count")
        .len();
    assert!(matches!(
        store.move_entry(
            &original_entry_id,
            &original_bucket_id,
            "Do not move callback note"
        ),
        Err(StoreError::InvalidCorrectionWrite {
            action: "move_entry",
            reason: "source and target buckets must differ",
        })
    ));
    assert_eq!(
        store
            .list_corrections(None, None, 10)
            .expect("corrections after rejected move")
            .len(),
        correction_count_before_same_bucket_move
    );

    let moved = store
        .move_entry(&original_entry_id, &second_bucket_id, "Move callback note")
        .expect("move entry");
    assert_eq!(moved.bucket_id, second_bucket_id);
    assert_eq!(
        moved.moved_from_bucket_id.as_deref(),
        Some(original_bucket_id.as_str())
    );
    assert!(
        store
            .list_memory_items(&second_bucket_id)
            .expect("moved memories")
            .iter()
            .any(|item| item.entry_id.as_deref() == Some(original_entry_id.as_str()))
    );
    assert!(
        store
            .list_memory_items(&original_bucket_id)
            .expect("old memories")
            .iter()
            .all(|item| item.entry_id.as_deref() != Some(original_entry_id.as_str()))
    );
    assert_eq!(
        store
            .get_bucket(&original_bucket_id)
            .expect("old bucket query")
            .expect("old bucket")
            .summary,
        "Follow-up summary"
    );
    assert_eq!(
        store
            .get_bucket(&second_bucket_id)
            .expect("target bucket query")
            .expect("target bucket")
            .summary,
        "Initial summary\nTask summary"
    );
    let corrections = store
        .list_corrections(Some("entry"), Some(&original_entry_id), 10)
        .expect("corrections");
    assert_eq!(corrections.len(), 1);
    assert_eq!(
        corrections[0].before,
        Some(json!({"bucket_id": original_bucket_id}))
    );
    let attempts = store.list_archive_attempts(10).expect("archive attempts");
    assert!(attempts.iter().any(|attempt| attempt.entry_id.as_deref()
        == Some(original_entry_id.as_str())
        && attempt.corrected
        && attempt.archive_state == "corrected"));
}

#[test]
fn moving_only_entry_out_of_auto_created_bucket_removes_empty_source_bucket() {
    let database = TemporaryPath::new("canonical-move-removes-empty-source");
    let mut store = DoggieStore::initialize(database.path()).expect("canonical schema");
    let audit = DoggieArchiveAudit::new(vec![], None, "doggie-v1", "test-model").expect("audit");

    let intended = store
        .archive(
            "Bucket 1 seed note.",
            ClassificationResult::create_new(
                BucketType::Task,
                "bucket1",
                0.99,
                "seed bucket",
                vec![],
            )
            .expect("classification"),
            Some(ExtractionResult::minimal("Bucket 1 summary").expect("extraction")),
            audit.clone(),
        )
        .expect("intended archive");
    let intended_bucket_id = intended.bucket_id.expect("intended bucket");

    let misplaced = store
        .archive(
            "This entry should have gone to bucket1.",
            ClassificationResult::create_new(
                BucketType::Task,
                "bucket2",
                0.99,
                "mistaken new bucket",
                vec![],
            )
            .expect("classification"),
            Some(
                ExtractionResult::new(
                    "Misplaced summary",
                    vec!["Move this follow-up to bucket1.".to_owned()],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec!["bucket1".to_owned()],
                )
                .expect("extraction"),
            ),
            audit,
        )
        .expect("misplaced archive");
    let mistaken_bucket_id = misplaced.bucket_id.expect("mistaken bucket");
    let misplaced_entry_id = misplaced.entry_id.expect("misplaced entry");
    assert!(
        store
            .get_bucket(&mistaken_bucket_id)
            .expect("bucket2 lookup")
            .is_some()
    );

    let moved = store
        .move_entry(
            &misplaced_entry_id,
            &intended_bucket_id,
            "Move entry to bucket1.",
        )
        .expect("move misplaced entry");
    assert_eq!(moved.bucket_id, intended_bucket_id);
    assert_eq!(
        moved.moved_from_bucket_id.as_deref(),
        Some(mistaken_bucket_id.as_str())
    );

    assert!(
        store
            .get_bucket(&mistaken_bucket_id)
            .expect("mistaken bucket lookup")
            .is_none(),
        "the auto-created empty source bucket should be removed after correction"
    );
    let intended_detail = store
        .bucket_detail(&intended_bucket_id)
        .expect("intended detail")
        .expect("intended bucket remains");
    assert_eq!(intended_detail.entries.len(), 2);
    assert!(
        intended_detail
            .entries
            .iter()
            .any(|entry| entry.id == misplaced_entry_id)
    );
    assert!(
        intended_detail
            .memories
            .iter()
            .any(|item| item.entry_id.as_deref() == Some(misplaced_entry_id.as_str()))
    );
    let active_bucket_ids = store
        .list_active_buckets(10)
        .expect("active buckets")
        .into_iter()
        .map(|bucket| bucket.id)
        .collect::<Vec<_>>();
    assert_eq!(active_bucket_ids, vec![intended_bucket_id.clone()]);

    let attempts = store.list_archive_attempts(10).expect("archive attempts");
    let corrected_misplaced_attempt = attempts
        .iter()
        .find(|attempt| {
            attempt.entry_id.as_deref() == Some(misplaced_entry_id.as_str())
                && attempt.action == ClassificationAction::CreateNew
        })
        .expect("misplaced create attempt");
    assert!(corrected_misplaced_attempt.corrected);
    assert_eq!(corrected_misplaced_attempt.archive_state, "corrected");
    assert!(
        corrected_misplaced_attempt.bucket_id.is_none(),
        "deleting the mistaken bucket should clear the attempt's foreign-key bucket link"
    );

    let counts = store.counts().expect("counts");
    assert_eq!(counts.buckets, 1);
    assert_eq!(counts.entries, 2);
}

#[test]
fn delete_bucket_cascades_dependents_and_records_correction() {
    let database = TemporaryPath::new("canonical-delete-bucket");
    let mut store = DoggieStore::initialize(database.path()).expect("canonical schema");
    let audit = DoggieArchiveAudit::new(vec![], None, "doggie-v1", "test-model").expect("audit");

    let created = store
        .archive(
            "接口 A 压测首轮完成，P99 为 120ms。",
            ClassificationResult::create_new(
                BucketType::Experiment,
                "接口 A 压测",
                0.99,
                "new experiment",
                vec![],
            )
            .expect("classification"),
            Some(
                ExtractionResult::new(
                    "首轮压测摘要",
                    vec![],
                    vec!["P99 为 120ms".to_owned()],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec!["压测".to_owned()],
                )
                .expect("extraction"),
            ),
            audit.clone(),
        )
        .expect("create archive");
    let bucket_id = created.bucket_id.clone().expect("bucket id");
    let first_entry_id = created.entry_id.clone().expect("first entry id");

    let appended = store
        .archive(
            "接口 A 压测复测完成，P99 为 110ms。",
            ClassificationResult::append_existing(
                bucket_id.clone(),
                Some(BucketType::Experiment),
                0.98,
                "append experiment",
                vec![bucket_id.clone()],
            )
            .expect("classification"),
            Some(
                ExtractionResult::new(
                    "复测摘要",
                    vec![],
                    vec!["P99 为 110ms".to_owned()],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec!["压测".to_owned()],
                )
                .expect("extraction"),
            ),
            audit.clone(),
        )
        .expect("append archive");
    let second_entry_id = appended.entry_id.clone().expect("second entry id");
    let pending = store
        .archive(
            "还需要确认的压测备注。",
            ClassificationResult::ask_user(
                Some(BucketType::Experiment),
                None,
                0.50,
                "ambiguous",
                "请选择归档目标。",
                vec![bucket_id.clone()],
            )
            .expect("ask classification"),
            None,
            audit,
        )
        .expect("pending archive");
    assert_eq!(store.counts().expect("counts before").entries, 2);

    let outcome = store
        .delete_bucket(&bucket_id, "用户删除压测 Bucket。")
        .expect("delete bucket");
    assert_eq!(outcome.bucket_id, bucket_id);
    assert_eq!(outcome.deleted_entry_ids, [first_entry_id, second_entry_id]);
    assert_eq!(outcome.deleted_memory_item_ids.len(), 4);
    assert_eq!(outcome.updated_archive_attempt_ids.len(), 2);

    assert!(
        store
            .get_bucket(&bucket_id)
            .expect("bucket lookup")
            .is_none()
    );
    assert!(
        store
            .bucket_detail(&bucket_id)
            .expect("detail lookup")
            .is_none()
    );
    assert!(store.list_entries(&bucket_id).expect("entries").is_empty());
    assert!(
        store
            .list_memory_items(&bucket_id)
            .expect("memories")
            .is_empty()
    );
    assert!(
        store
            .list_active_buckets(10)
            .expect("active buckets")
            .into_iter()
            .all(|bucket| bucket.id != bucket_id)
    );

    let attempts = store.list_archive_attempts(10).expect("attempts");
    assert_eq!(attempts.len(), 3);
    for attempt_id in &outcome.updated_archive_attempt_ids {
        let attempt = attempts
            .iter()
            .find(|attempt| &attempt.id == attempt_id)
            .expect("attempt retained");
        assert!(attempt.bucket_id.is_none());
        assert!(attempt.entry_id.is_none());
    }
    let pending_attempt = attempts
        .iter()
        .find(|attempt| attempt.id == pending.attempt_id)
        .expect("pending candidate-only attempt retained");
    assert_eq!(pending_attempt.archive_state, "needs_confirmation");
    assert!(pending_attempt.bucket_id.is_none());
    assert!(pending_attempt.entry_id.is_none());
    assert_eq!(pending_attempt.candidate_bucket_ids.len(), 1);
    assert_eq!(pending_attempt.candidate_bucket_ids[0], bucket_id);

    let corrections = store
        .list_corrections(Some("bucket"), Some(&bucket_id), 10)
        .expect("corrections");
    assert_eq!(corrections.len(), 1);
    assert_eq!(corrections[0].id, outcome.correction_id);
    assert_eq!(corrections[0].action, "delete_bucket");
    assert_eq!(
        corrections[0].before.as_ref().unwrap()["bucket"]["id"],
        bucket_id
    );
    assert_eq!(
        corrections[0].before.as_ref().unwrap()["deleted_entry_ids"],
        json!(outcome.deleted_entry_ids)
    );
    assert_eq!(corrections[0].after, Some(json!({"deleted": true})));

    let counts = store.counts().expect("counts after delete");
    assert_eq!(counts.buckets, 0);
    assert_eq!(counts.entries, 0);
    assert_eq!(counts.memory_items, 0);
    assert_eq!(counts.archive_attempts, 3);
    assert_eq!(counts.corrections, 1);

    assert!(matches!(
        store.delete_bucket(&bucket_id, "重复删除。"),
        Err(StoreError::MissingRecord {
            table: "buckets",
            ..
        })
    ));
}

#[test]
fn popular_active_buckets_rank_by_entry_and_memory_volume() {
    let database = TemporaryPath::new("canonical-popular-buckets");
    let mut store = DoggieStore::initialize(database.path()).expect("canonical schema");
    let audit = DoggieArchiveAudit::new(vec![], None, "doggie-v1", "test-model").expect("audit");

    let popular = store
        .archive(
            "热门 Bucket 第一次记录。",
            ClassificationResult::create_new(
                BucketType::Task,
                "热门 Bucket",
                0.99,
                "popular",
                vec![],
            )
            .expect("classification"),
            Some(ExtractionResult::minimal("热门 1").expect("extraction")),
            audit.clone(),
        )
        .expect("popular create");
    let popular_bucket_id = popular.bucket_id.expect("popular bucket");
    for index in 2..=3 {
        store
            .archive(
                format!("热门 Bucket 第 {index} 次记录。"),
                ClassificationResult::append_existing(
                    popular_bucket_id.clone(),
                    Some(BucketType::Task),
                    0.99,
                    "popular append",
                    vec![popular_bucket_id.clone()],
                )
                .expect("classification"),
                Some(ExtractionResult::minimal(format!("热门 {index}")).expect("extraction")),
                audit.clone(),
            )
            .expect("popular append");
    }
    let recent = store
        .archive(
            "最近但低频 Bucket。",
            ClassificationResult::create_new(
                BucketType::Task,
                "最近 Bucket",
                0.99,
                "recent",
                vec![],
            )
            .expect("classification"),
            Some(ExtractionResult::minimal("最近").expect("extraction")),
            audit,
        )
        .expect("recent create");
    let recent_bucket_id = recent.bucket_id.expect("recent bucket");

    let popular_ids = store
        .list_popular_active_buckets(10)
        .expect("popular buckets")
        .into_iter()
        .map(|bucket| bucket.id)
        .collect::<Vec<_>>();
    assert_eq!(popular_ids[0], popular_bucket_id);
    assert!(popular_ids.contains(&recent_bucket_id));

    store
        .set_bucket_status(&popular_bucket_id, BucketStatus::Paused)
        .expect("pause popular");
    let active_popular_ids = store
        .list_popular_active_buckets(10)
        .expect("popular after pause")
        .into_iter()
        .map(|bucket| bucket.id)
        .collect::<Vec<_>>();
    assert!(!active_popular_ids.contains(&popular_bucket_id));
    assert!(active_popular_ids.contains(&recent_bucket_id));
}
