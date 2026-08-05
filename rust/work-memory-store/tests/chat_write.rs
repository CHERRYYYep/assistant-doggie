mod support;

use support::{TemporaryPath as TemporaryDatabase, assert_uuid_v4};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde_json::{Value as JsonValue, json};
use work_memory_store::{
    ChatMessageWriteRequest, ChatRole, SqliteStore, StoreError, WritableSqliteStore,
};

const USER_CONTENT: &str = "R2g parity user message.";
const TOOL_CONTENT: &str = "R2g parity tool result: {\"ok\": true}";
const ASSISTANT_CONTENT: &str = "R2g parity assistant message.";
const TOOL_NAME: &str = " parity_tool ";
const TOOL_CALL_ID: &str = " parity-call-1 ";
const BUSINESS_TABLES: &[&str] = &[
    "buckets",
    "entries",
    "todos",
    "evidences",
    "timeline_events",
    "decisions",
    "classification_records",
    "corrections",
    "chat_messages",
];
#[test]
fn append_chat_message_persists_one_complete_row() {
    let database = create_python_fixture("complete");
    let before_counts = table_row_counts(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request = ChatMessageWriteRequest::new(
        ChatRole::Tool,
        "  {\"ok\": true}  ",
        Some(" search_memory ".to_owned()),
        Some(" call-42 ".to_owned()),
        Some(json!({"ok": true, "matches": ["alpha", "beta"]})),
    )
    .unwrap();

    let message = store.append_chat_message(&request).unwrap();
    assert_uuid_v4(&message.id);
    assert_eq!(message.role, ChatRole::Tool);
    assert_eq!(message.content, "{\"ok\": true}");
    assert_eq!(message.tool_name.as_deref(), Some(" search_memory "));
    assert_eq!(message.tool_call_id.as_deref(), Some(" call-42 "));
    assert_eq!(
        message.details_json,
        Some(json!({"ok": true, "matches": ["alpha", "beta"]}))
    );
    drop(store);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    assert_eq!(reader.get_chat_message(&message.id).unwrap(), Some(message));
    drop(reader);

    let after_counts = table_row_counts(database.path());
    for table in BUSINESS_TABLES {
        let expected_increase = i64::from(*table == "chat_messages");
        assert_eq!(
            after_counts[*table],
            before_counts[*table] + expected_increase,
            "unexpected row-count change in {table}"
        );
    }
}

#[test]
fn append_chat_message_accepts_all_supported_roles() {
    let database = create_python_fixture("roles");
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let requests = [
        ChatMessageWriteRequest::new(ChatRole::User, "question", None, None, None).unwrap(),
        ChatMessageWriteRequest::new(
            ChatRole::Tool,
            "result",
            Some("lookup".to_owned()),
            Some("call-1".to_owned()),
            Some(json!({"ok": true})),
        )
        .unwrap(),
        ChatMessageWriteRequest::new(
            ChatRole::Assistant,
            "answer",
            None,
            None,
            Some(json!(["final"])),
        )
        .unwrap(),
    ];

    let messages = requests
        .iter()
        .map(|request| store.append_chat_message(request).unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        messages
            .iter()
            .map(|message| message.role)
            .collect::<Vec<_>>(),
        [ChatRole::User, ChatRole::Tool, ChatRole::Assistant]
    );
}

#[test]
fn consecutive_appends_have_monotonic_timestamps_and_display_order() {
    let database = create_python_fixture("ordering");
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let first = store
        .append_chat_message(
            &ChatMessageWriteRequest::new(ChatRole::User, "first append", None, None, None)
                .unwrap(),
        )
        .unwrap();
    let second = store
        .append_chat_message(
            &ChatMessageWriteRequest::new(ChatRole::Assistant, "second append", None, None, None)
                .unwrap(),
        )
        .unwrap();
    assert!(second.created_at.utc_naive() > first.created_at.utc_naive());
    drop(store);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    let recent_ids = reader
        .list_chat_messages(2)
        .unwrap()
        .into_iter()
        .map(|message| message.id)
        .collect::<Vec<_>>();
    assert_eq!(recent_ids, [first.id, second.id]);
}

#[test]
fn append_after_rfc3339_timestamp_remains_newest_in_display_order() {
    let database = create_python_fixture("rfc3339-ordering");
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute(
            "UPDATE chat_messages
             SET created_at = '2099-01-01T12:00:00Z'
             WHERE id = '16161616-1616-1616-1616-161616161616'",
            [],
        )
        .unwrap();
    drop(connection);
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();

    let appended = store
        .append_chat_message(
            &ChatMessageWriteRequest::new(ChatRole::User, "after RFC 3339", None, None, None)
                .unwrap(),
        )
        .unwrap();
    assert_eq!(appended.created_at.raw(), "2099-01-01T12:00:01+00:00");
    drop(store);

    let reader = SqliteStore::open_read_only(database.path()).unwrap();
    assert_eq!(reader.list_chat_messages(1).unwrap()[0].id, appended.id);
}

#[test]
fn invalid_chat_requests_are_rejected_before_any_write() {
    let database = create_python_fixture("validation");
    let before = business_snapshot(database.path());

    assert!(matches!(
        ChatMessageWriteRequest::new(ChatRole::User, " \t\n ", None, None, None),
        Err(StoreError::InvalidWriteField {
            field: "content",
            ..
        })
    ));
    assert!(matches!(
        ChatMessageWriteRequest::new(
            ChatRole::Assistant,
            "answer",
            None,
            None,
            Some(json!(false)),
        ),
        Err(StoreError::InvalidWriteField {
            field: "details_json",
            ..
        })
    ));

    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn insertion_failure_rolls_back_without_changing_business_rows() {
    let database = create_python_fixture("rollback");
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_rust_chat_write
             BEFORE INSERT ON chat_messages
             BEGIN
                 SELECT RAISE(ABORT, 'fixture rejects chat insertion');
             END;",
        )
        .unwrap();
    drop(connection);
    let before = business_snapshot(database.path());
    let mut store = WritableSqliteStore::open_existing(database.path()).unwrap();
    let request =
        ChatMessageWriteRequest::new(ChatRole::User, "must roll back", None, None, None).unwrap();

    assert!(matches!(
        store.append_chat_message(&request),
        Err(StoreError::Sqlite(_))
    ));
    drop(store);
    assert_eq!(business_snapshot(database.path()), before);
}

#[test]
fn rust_chat_appends_match_python_final_business_semantics() {
    let python_database = create_python_fixture("python-parity");
    let rust_database = create_python_fixture("rust-parity");
    run_python_chat_fixture(python_database.path());

    let mut store = WritableSqliteStore::open_existing(rust_database.path()).unwrap();
    for request in parity_requests() {
        store.append_chat_message(&request).unwrap();
    }
    drop(store);

    assert_eq!(
        chat_semantic_snapshot(rust_database.path()),
        chat_semantic_snapshot(python_database.path())
    );
}

fn parity_requests() -> [ChatMessageWriteRequest; 3] {
    [
        ChatMessageWriteRequest::new(
            ChatRole::User,
            format!("  {USER_CONTENT}  "),
            None,
            None,
            None,
        )
        .unwrap(),
        ChatMessageWriteRequest::new(
            ChatRole::Tool,
            format!("  {TOOL_CONTENT}  "),
            Some(TOOL_NAME.to_owned()),
            Some(TOOL_CALL_ID.to_owned()),
            Some(json!({"ok": true, "matches": 2})),
        )
        .unwrap(),
        ChatMessageWriteRequest::new(
            ChatRole::Assistant,
            format!("  {ASSISTANT_CONTENT}  "),
            None,
            None,
            Some(json!([{"kind": "summary"}, "complete"])),
        )
        .unwrap(),
    ]
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
    );
    database
}

fn run_python_chat_fixture(database_path: &Path) {
    run_python_script("tests/fixtures/apply_chat_write_fixture.py", database_path);
}

fn run_python_script(relative_script: &str, database_path: &Path) {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let virtualenv_python = repository_root.join(".venv/bin/python");
    let python = if virtualenv_python.is_file() {
        virtualenv_python
    } else {
        PathBuf::from("python3")
    };
    let output = Command::new(python)
        .arg(repository_root.join(relative_script))
        .arg(database_path)
        .env("PYTHONPATH", &repository_root)
        .current_dir(&repository_root)
        .output()
        .expect("Python fixture helper must start");
    assert!(
        output.status.success(),
        "Python fixture helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn table_row_counts(path: &Path) -> BTreeMap<String, i64> {
    let connection = Connection::open(path).unwrap();
    BUSINESS_TABLES
        .iter()
        .map(|table| {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let count = connection.query_row(&sql, [], |row| row.get(0)).unwrap();
            ((*table).to_owned(), count)
        })
        .collect()
}

fn business_snapshot(path: &Path) -> BTreeMap<String, Vec<Vec<SqlValue>>> {
    let connection = Connection::open(path).unwrap();
    BUSINESS_TABLES
        .iter()
        .map(|table| {
            let sql = format!("SELECT * FROM {table} ORDER BY id");
            let mut statement = connection.prepare(&sql).unwrap();
            let column_count = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..column_count)
                        .map(|index| row.get::<_, SqlValue>(index))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            ((*table).to_owned(), rows)
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ChatSemanticRow {
    role: String,
    content: String,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    details_json: Option<String>,
}

fn chat_semantic_snapshot(path: &Path) -> Vec<ChatSemanticRow> {
    let connection = Connection::open(path).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT role, content, tool_name, tool_call_id, details_json
             FROM chat_messages
             WHERE content LIKE 'R2g parity %'",
        )
        .unwrap();
    let mut rows = statement
        .query_map([], |row| {
            let raw_details = row.get::<_, Option<String>>(4)?;
            let details_json = raw_details.and_then(|raw| {
                let value: JsonValue = serde_json::from_str(&raw).unwrap();
                (!value.is_null()).then(|| serde_json::to_string(&value).unwrap())
            });
            Ok(ChatSemanticRow {
                role: row.get(0)?,
                content: row.get(1)?,
                tool_name: row.get(2)?,
                tool_call_id: row.get(3)?,
                details_json,
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows.sort();
    rows
}
