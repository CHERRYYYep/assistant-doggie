mod support;

use support::TemporaryPath as TemporaryDatabase;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use work_memory_service::{BucketQueryService, BucketSearchResult, ServiceError};
use work_memory_store::StoreError;

const EXACT_PAYMENT_ID: &str = "01010101-0101-0101-0101-010101010101";
const CONTAINS_PAYMENT_ID: &str = "02020202-0202-0202-0202-020202020202";
const UNICODE_CASEFOLD_ID: &str = "03030303-0303-0303-0303-030303030303";
const LITERAL_WILDCARD_ID: &str = "04040404-0404-0404-0404-040404040404";
const TAG_ID: &str = "06060606-0606-0606-0606-060606060606";
const TIE_FIRST_ID: &str = "08080808-0808-0808-0808-080808080808";
const TIE_SECOND_ID: &str = "09090909-0909-0909-0909-090909090909";
#[test]
fn bucket_search_validates_inputs_and_treats_like_wildcards_as_literals() {
    let database = create_python_fixture("validation");
    let service = BucketQueryService::open_read_only(database.path()).unwrap();

    assert!(matches!(
        service.search_buckets(" \t\n ", 20),
        Err(ServiceError::EmptySearchQuery)
    ));
    assert!(matches!(
        service.search_buckets("payment", 0),
        Err(ServiceError::Store(StoreError::InvalidLimit(0)))
    ));

    let literal = service.search_buckets("50%_literal/path", 20).unwrap();
    assert_eq!(literal.len(), 1);
    assert_eq!(literal[0].bucket_id, LITERAL_WILDCARD_ID);
    assert_eq!(literal[0].status.as_str(), "paused");
    assert_eq!(literal[0].score, 100);
}

#[test]
fn bucket_search_preserves_python_scoring_counts_casefold_and_stable_order() {
    let database = create_python_fixture("scoring");
    let service = BucketQueryService::open_read_only(database.path()).unwrap();

    let payment = service.search_buckets("  PAYMENT  ", 3).unwrap();
    assert_eq!(
        payment
            .iter()
            .map(|result| result.bucket_id.as_str())
            .collect::<Vec<_>>(),
        [EXACT_PAYMENT_ID, CONTAINS_PAYMENT_ID, TAG_ID]
    );
    assert_eq!(payment[0].matched_entry_count, 2);
    assert_eq!(payment[0].score, 160);
    assert_eq!(payment[1].matched_entry_count, 1);
    assert_eq!(payment[1].score, 105);
    assert_eq!(payment[2].score, 30);

    let unicode = service.search_buckets("STRASSE", 20).unwrap();
    assert_eq!(unicode.len(), 1);
    assert_eq!(unicode[0].bucket_id, UNICODE_CASEFOLD_ID);
    assert_eq!(unicode[0].matched_entry_count, 1);
    assert_eq!(unicode[0].score, 105);

    let tied = service.search_buckets("same activity", 20).unwrap();
    assert_eq!(
        tied.iter()
            .map(|result| result.bucket_id.as_str())
            .collect::<Vec<_>>(),
        [TIE_FIRST_ID, TIE_SECOND_ID]
    );
    assert!(service.search_buckets("支付", 20).unwrap().is_empty());
    assert_eq!(service.search_buckets("payment", 1).unwrap().len(), 1);
}

#[test]
fn rust_bucket_search_matches_python_service_semantics() {
    let database = create_python_fixture("parity");
    let service = BucketQueryService::open_read_only(database.path()).unwrap();

    let rust_payload = json!({
        "payment_trimmed": search_payload(&service, "  PAYMENT  ", 3),
        "payment_limited": search_payload(&service, "payment", 1),
        "unicode_casefold": search_payload(&service, "STRASSE", 20),
        "literal_wildcards": search_payload(&service, "50%_literal/path", 20),
        "summary": search_payload(&service, "card layout", 20),
        "tag": search_payload(&service, "payment-tag", 20),
        "entry": search_payload(&service, "502", 20),
        "stable_tie": search_payload(&service, "same activity", 20),
        "unicode_json_tag": search_payload(&service, "支付", 20),
        "missing": search_payload(&service, "does-not-exist", 20),
    });
    let python_payload = run_python_json(
        "tests/fixtures/export_bucket_search_fixture.py",
        database.path(),
    );

    assert_eq!(rust_payload, python_payload);
}

fn search_payload(service: &BucketQueryService, query: &str, limit: usize) -> Vec<Value> {
    service
        .search_buckets(query, limit)
        .unwrap()
        .iter()
        .map(result_payload)
        .collect()
}

fn result_payload(result: &BucketSearchResult) -> Value {
    json!({
        "bucket_id": result.bucket_id,
        "title": result.title,
        "bucket_type": result.bucket_type.as_str(),
        "status": result.status.as_str(),
        "summary": result.summary,
        "tags": result.tags,
        "last_active_at": result.last_active_at.raw(),
        "matched_entry_count": result.matched_entry_count,
        "score": result.score,
    })
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_bucket_search_fixture.py",
        database.path(),
    );
    database
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn python_command(relative_script: &str, database_path: &Path) -> Command {
    let repository_root = repository_root();
    let virtualenv_python = repository_root.join(".venv/bin/python");
    let python = if virtualenv_python.is_file() {
        virtualenv_python
    } else {
        PathBuf::from("python3")
    };
    let mut command = Command::new(python);
    command
        .arg(repository_root.join(relative_script))
        .arg(database_path)
        .env("PYTHONPATH", &repository_root)
        .current_dir(repository_root);
    command
}

fn run_python_script(relative_script: &str, database_path: &Path) {
    let output = python_command(relative_script, database_path)
        .output()
        .expect("Python fixture helper must start");
    assert!(
        output.status.success(),
        "Python fixture helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_python_json(relative_script: &str, database_path: &Path) -> Value {
    let output = python_command(relative_script, database_path)
        .output()
        .expect("Python parity helper must start");
    assert!(
        output.status.success(),
        "Python parity helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("Python helper must emit JSON")
}
