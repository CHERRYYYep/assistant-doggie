mod support;

use support::{TemporaryPath as TemporaryDatabase, is_uuid_v4};

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use work_memory_service::{ChatMessagePersistenceService, ChatMessageSaveResult, ServiceError};
use work_memory_store::{ChatRole, SqliteStore, StoreError};

const APPEND_SEQUENCE: &str = "append_sequence";
const NULL_DETAILS: &str = "null_details";
const INSTALL_FAILURE_TRIGGER: &str = "install_failure_trigger";
const USER_CONTENT: &str = "R3i parity user message.";
const TOOL_CONTENT: &str = "R3i parity tool result: {\"ok\": true}";
const ASSISTANT_CONTENT: &str = "R3i parity assistant message.";
const NULL_CONTENT: &str = "R3i parity null details message.";
const TOOL_NAME: &str = " parity_tool ";
const TOOL_CALL_ID: &str = " parity-call-1 ";

#[test]
fn appended_sequence_matches_python_results_and_database_semantics() {
    let python_database = create_python_fixture("sequence-python");
    let rust_database = create_python_fixture("sequence-rust");
    let before = export_database(rust_database.path());
    let python_result = run_python_json(
        "tests/fixtures/apply_chat_message_service_fixture.py",
        python_database.path(),
        &[APPEND_SEQUENCE],
    );

    let mut service = ChatMessagePersistenceService::open_existing(rust_database.path()).unwrap();
    let first = service
        .append_chat_message(
            ChatRole::User,
            format!("  {USER_CONTENT}  "),
            None,
            None,
            None,
        )
        .unwrap();
    let duplicate = service
        .append_chat_message(
            ChatRole::User,
            format!("  {USER_CONTENT}  "),
            None,
            None,
            None,
        )
        .unwrap();
    let tool = service
        .append_chat_message(
            ChatRole::Tool,
            format!("  {TOOL_CONTENT}  "),
            Some(TOOL_NAME.to_owned()),
            Some(TOOL_CALL_ID.to_owned()),
            Some(json!({"ok": true, "matches": 2})),
        )
        .unwrap();
    let assistant = service
        .append_chat_message(
            ChatRole::Assistant,
            format!("  {ASSISTANT_CONTENT}  "),
            None,
            None,
            Some(json!([{"kind": "summary"}, "complete"])),
        )
        .unwrap();

    assert_eq!(
        json!({
            "messages": [
                result_payload(&first),
                result_payload(&duplicate),
                result_payload(&tool),
                result_payload(&assistant),
            ],
            "duplicate_ids_are_distinct": first.id() != duplicate.id(),
        }),
        python_result
    );

    let messages = [&first, &duplicate, &tool, &assistant];
    let ids = messages
        .iter()
        .map(|message| message.id())
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), messages.len());
    assert!(
        messages
            .windows(2)
            .all(|pair| { pair[1].created_at().utc_naive() > pair[0].created_at().utc_naive() })
    );
    assert_eq!(first.content(), USER_CONTENT);
    assert_eq!(duplicate.content(), USER_CONTENT);
    assert_eq!(tool.content(), TOOL_CONTENT);
    assert_eq!(tool.tool_name(), Some(TOOL_NAME.trim()));
    assert_eq!(tool.tool_call_id(), Some(TOOL_CALL_ID.trim()));
    assert_eq!(tool.details(), Some(&json!({"ok": true, "matches": 2})));
    assert_eq!(assistant.content(), ASSISTANT_CONTENT);
    assert_eq!(
        assistant.details(),
        Some(&json!([{"kind": "summary"}, "complete"]))
    );
    drop(service);

    let reader = SqliteStore::open_read_only(rust_database.path()).unwrap();
    assert_eq!(
        reader
            .get_chat_message(tool.id())
            .unwrap()
            .unwrap()
            .tool_name
            .as_deref(),
        Some(TOOL_NAME)
    );
    assert_eq!(
        reader
            .list_chat_messages(messages.len())
            .unwrap()
            .into_iter()
            .map(|message| message.id)
            .collect::<Vec<_>>(),
        messages
            .iter()
            .map(|message| message.id().to_owned())
            .collect::<Vec<_>>()
    );
    drop(reader);

    let after = export_database(rust_database.path());
    assert_only_chat_messages_changed(&before, &after);
    assert_database_parity(&rust_database, &python_database);
}

#[test]
fn null_details_normalization_and_invalid_inputs_preserve_service_boundaries() {
    let python_database = create_python_fixture("null-python");
    let rust_database = create_python_fixture("null-rust");
    let before = export_database(rust_database.path());
    let python_result = run_python_json(
        "tests/fixtures/apply_chat_message_service_fixture.py",
        python_database.path(),
        &[NULL_DETAILS],
    );

    let mut service = ChatMessagePersistenceService::open_existing(rust_database.path()).unwrap();
    let message = service
        .append_chat_message(
            ChatRole::Assistant,
            format!("  {NULL_CONTENT}  "),
            None,
            None,
            Some(Value::Null),
        )
        .unwrap();
    assert_eq!(result_payload(&message), python_result);
    assert_eq!(message.content(), NULL_CONTENT);
    assert_eq!(message.details(), None);

    let after_null = export_database(rust_database.path());
    assert_only_chat_messages_changed(&before, &after_null);
    assert_database_parity(&rust_database, &python_database);

    assert!(matches!(
        service.append_chat_message(ChatRole::User, " \t\n ", None, None, None),
        Err(ServiceError::Store(StoreError::InvalidWriteField {
            field: "content",
            ..
        }))
    ));
    assert!(matches!(
        service.append_chat_message(
            ChatRole::Assistant,
            "answer",
            None,
            None,
            Some(json!(false)),
        ),
        Err(ServiceError::Store(StoreError::InvalidWriteField {
            field: "details_json",
            ..
        }))
    ));
    drop(service);

    assert_eq!(export_database(rust_database.path()), after_null);
}

#[test]
fn chat_message_insert_failure_leaves_the_database_unchanged() {
    let database = create_python_fixture("failure");
    run_python_json(
        "tests/fixtures/apply_chat_message_service_fixture.py",
        database.path(),
        &[INSTALL_FAILURE_TRIGGER],
    );
    let before = export_database(database.path());
    let mut service = ChatMessagePersistenceService::open_existing(database.path()).unwrap();

    assert!(matches!(
        service.append_chat_message(ChatRole::User, "must roll back", None, None, None),
        Err(ServiceError::Store(StoreError::Sqlite(_)))
    ));
    drop(service);

    assert_eq!(export_database(database.path()), before);
}

fn result_payload(message: &ChatMessageSaveResult) -> Value {
    json!({
        "id_is_uuid_v4": is_uuid_v4(message.id()),
        "role": message.role().as_str(),
        "content": message.content(),
        "tool_name": message.tool_name(),
        "tool_call_id": message.tool_call_id(),
        "details": message.details(),
    })
}

fn assert_only_chat_messages_changed(before: &Value, after: &Value) {
    let before_rows = before["rows"].as_object().unwrap();
    let after_rows = after["rows"].as_object().unwrap();
    for (table, rows) in before_rows {
        if table != "chat_messages" {
            assert_eq!(after_rows.get(table), Some(rows), "table changed: {table}");
        }
    }
    assert_ne!(
        before_rows.get("chat_messages"),
        after_rows.get("chat_messages")
    );
}

fn assert_database_parity(rust_database: &TemporaryDatabase, python_database: &TemporaryDatabase) {
    assert_eq!(
        export_database(rust_database.path()),
        export_database(python_database.path())
    );
}

fn export_database(database_path: &Path) -> Value {
    run_python_json(
        "tests/fixtures/export_chat_message_service_fixture.py",
        database_path,
        &[],
    )
}

fn create_python_fixture(label: &str) -> TemporaryDatabase {
    let database = TemporaryDatabase::new(label);
    run_python_script(
        "tests/fixtures/create_sqlite_compat_fixture.py",
        database.path(),
        &[],
    );
    database
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn python_command(relative_script: &str, database_path: &Path, args: &[&str]) -> Command {
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
        .args(args)
        .env("PYTHONPATH", &repository_root)
        .current_dir(repository_root);
    command
}

fn run_python_script(relative_script: &str, database_path: &Path, args: &[&str]) {
    let output = python_command(relative_script, database_path, args)
        .output()
        .expect("Python fixture helper must start");
    assert!(
        output.status.success(),
        "Python fixture helper failed for {relative_script}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_python_json(relative_script: &str, database_path: &Path, args: &[&str]) -> Value {
    let output = python_command(relative_script, database_path, args)
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
