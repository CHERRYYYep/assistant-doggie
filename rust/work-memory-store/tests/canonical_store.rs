mod support;

use serde_json::json;
use support::TemporaryPath;
use work_memory_contracts::ChatRole;
use work_memory_core::{
    BucketStatus, BucketType, ClassificationResult, ExtractionResult, TimelineEventExtract,
};
use work_memory_store::{MemoryKind, RustArchiveAudit, RustStore, StoreError};

#[test]
fn canonical_archive_preserves_all_memory_kinds_and_supports_search() {
    let database = TemporaryPath::new("canonical-archive");
    let mut store = RustStore::initialize(database.path()).expect("canonical schema");
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
            RustArchiveAudit::new(
                vec!["candidate-a".to_owned()],
                Some("focus-bucket".to_owned()),
                "rust-classification-v1",
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
    let mut store = RustStore::initialize(database.path()).expect("canonical schema");
    let audit = RustArchiveAudit::new(vec![], None, "rust-v1", "test-model").expect("audit");

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
            RustArchiveAudit::new(vec![], None, "rust-v1", "test-model").expect("audit"),
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
