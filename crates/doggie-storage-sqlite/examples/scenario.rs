//! Differential-testing scenario: run a fixed sequence of writes against a
//! fresh database at argv[1]. The resulting state is compared against the
//! TypeScript store by `tests/storage-parity.test.ts`, which normalises both
//! sides before diffing. Temporary migration tool; delete with the workspace.
use doggie_domain::{BucketType, ClassificationResult, ExtractionResult, TimelineEventExtract};
use doggie_storage_sqlite::{DoggieArchiveAudit, DoggieStore};

fn main() {
    let path = std::env::args().nth(1).expect("database path");
    let mut store = DoggieStore::initialize(&path).expect("schema");
    let audit = DoggieArchiveAudit::new(vec![], None, "doggie-v1", "test-model").expect("audit");

    let first = store
        .archive(
            "接口 A 压测 p99 620ms",
            ClassificationResult::create_new(
                BucketType::Experiment,
                "接口 A 压测",
                0.99,
                "新实验。",
                vec![],
            )
            .expect("classification"),
            Some(
                ExtractionResult::new(
                    "p99 从 320ms 升到 620ms",
                    vec!["定位回归 commit".to_owned()],
                    vec!["压测报告 #12".to_owned()],
                    vec![
                        TimelineEventExtract::new(Some("2026-08-20".to_owned()), "回归出现")
                            .expect("timeline"),
                    ],
                    vec!["先回滚".to_owned()],
                    vec!["连接池退化".to_owned()],
                    vec!["接口 A".to_owned()],
                    vec!["Payments".to_owned()],
                )
                .expect("extraction"),
            ),
            audit.clone(),
        )
        .expect("first archive");
    let bucket_one = first.bucket_id.clone().expect("bucket");

    store
        .archive(
            "复测后 p99 回到 340ms",
            ClassificationResult::append_existing(
                bucket_one.clone(),
                Some(BucketType::Experiment),
                0.95,
                "同一实验。",
                vec![],
            )
            .expect("classification"),
            Some(
                ExtractionResult::new(
                    "p99 回到 340ms",
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    vec!["Rust".to_owned()],
                )
                .expect("extraction"),
            ),
            audit.clone(),
        )
        .expect("second archive");

    store
        .archive(
            "它现在正常了",
            ClassificationResult::ask_user(
                None,
                None,
                0.4,
                "信息不足。",
                "请选择归档目标。",
                vec![],
            )
            .expect("classification"),
            None,
            audit.clone(),
        )
        .expect("ask_user archive");

    let misfiled = store
        .archive(
            "这条应该进接口 A 压测",
            ClassificationResult::create_new(BucketType::Task, "误建事务", 0.99, "误判。", vec![])
                .expect("classification"),
            Some(ExtractionResult::minimal("误建摘要").expect("extraction")),
            audit,
        )
        .expect("misfiled archive");
    store
        .move_entry(
            &misfiled.entry_id.expect("entry"),
            &bucket_one,
            "移到接口 A 压测。",
        )
        .expect("move");
}
