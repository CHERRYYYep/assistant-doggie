mod support;

use support::TemporaryPath as TemporaryDatabase;

use doggie_storage_sqlite::{SqliteStore, StoreError};
use rusqlite::{Connection, params};

#[test]
fn rejects_a_missing_required_table() {
    let database = TemporaryDatabase::new("missing-table");
    let connection = Connection::open(database.path()).expect("test database must open");
    create_buckets_table(&connection);
    drop(connection);

    assert!(matches!(
        SqliteStore::open_read_only(database.path()),
        Err(StoreError::MissingTable("entries"))
    ));
}

#[test]
fn rejects_a_missing_remaining_business_table() {
    let database = TemporaryDatabase::new("missing-corrections-table");
    let connection = Connection::open(database.path()).expect("test database must open");
    create_current_tables(&connection);
    connection
        .execute_batch("DROP TABLE corrections;")
        .expect("corrections table must be removed");
    drop(connection);

    assert!(matches!(
        SqliteStore::open_read_only(database.path()),
        Err(StoreError::MissingTable("corrections"))
    ));
}

#[test]
fn rejects_a_missing_required_column() {
    let database = TemporaryDatabase::new("missing-column");
    let connection = Connection::open(database.path()).expect("test database must open");
    create_buckets_table(&connection);
    connection
        .execute_batch(
            "CREATE TABLE entries (
                id TEXT PRIMARY KEY,
                bucket_id TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                summary TEXT,
                content_type TEXT NOT NULL,
                classification_confidence REAL,
                classification_reason TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .expect("partial entries table must be created");
    drop(connection);

    assert!(matches!(
        SqliteStore::open_read_only(database.path()),
        Err(StoreError::MissingColumn {
            table: "entries",
            column: "moved_from_bucket_id"
        })
    ));
}

#[test]
fn distinguishes_invalid_persisted_values() {
    let database = TemporaryDatabase::new("invalid-values");
    let connection = Connection::open(database.path()).expect("test database must open");
    create_current_tables(&connection);
    insert_bucket(
        &connection,
        "invalid-type",
        "unsupported",
        "active",
        "[]",
        valid_time(),
    );
    insert_bucket(
        &connection,
        "invalid-status",
        "task",
        "unknown",
        "[]",
        valid_time(),
    );
    insert_bucket(
        &connection,
        "invalid-tags",
        "task",
        "active",
        "not-json",
        valid_time(),
    );
    insert_bucket(
        &connection,
        "invalid-time",
        "task",
        "active",
        "[]",
        "yesterday",
    );
    connection
        .execute(
            "INSERT INTO todos (
                id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
             ) VALUES (?1, 'bucket', NULL, 'Fixture', ?2, ?3, ?4, ?4)",
            params![
                "invalid-todo-status",
                "blocked",
                Option::<String>::None,
                valid_time()
            ],
        )
        .expect("invalid todo status fixture must be inserted");
    connection
        .execute(
            "INSERT INTO todos (
                id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
             ) VALUES (?1, 'bucket', NULL, 'Fixture', 'open', ?2, ?3, ?3)",
            params!["invalid-todo-time", "tomorrow", valid_time()],
        )
        .expect("invalid todo time fixture must be inserted");
    insert_classification(
        &connection,
        "invalid-classification-action",
        "append",
        "[]",
        0,
    );
    insert_classification(
        &connection,
        "invalid-candidates",
        "ask_user",
        r#"{"bucket_id":"not-a-list"}"#,
        0,
    );
    insert_classification(&connection, "invalid-corrected", "ask_user", "[]", 2);
    connection
        .execute(
            "INSERT INTO corrections (
                id, command_text, action, target_type, target_id,
                before_json, after_json, created_at
             ) VALUES (?1, 'Fixture', 'move_entry', 'entry', 'target', ?2, NULL, ?3)",
            params!["invalid-correction-json-type", "42", valid_time()],
        )
        .expect("invalid correction JSON type fixture must be inserted");
    insert_chat_message(
        &connection,
        "invalid-chat-role",
        "system",
        Option::<&str>::None,
        valid_time(),
    );
    insert_chat_message(
        &connection,
        "invalid-chat-details",
        "assistant",
        Some("true"),
        valid_time(),
    );
    insert_chat_message(
        &connection,
        "invalid-chat-time",
        "user",
        Option::<&str>::None,
        "later",
    );
    drop(connection);

    let store = SqliteStore::open_read_only(database.path()).expect("schema must be valid");
    assert!(matches!(
        store.get_bucket("invalid-type"),
        Err(StoreError::InvalidBucketType { bucket_id, value })
            if bucket_id == "invalid-type" && value == "unsupported"
    ));
    assert!(matches!(
        store.get_bucket("invalid-status"),
        Err(StoreError::InvalidBucketStatus { bucket_id, value })
            if bucket_id == "invalid-status" && value == "unknown"
    ));
    assert!(matches!(
        store.get_bucket("invalid-tags"),
        Err(StoreError::InvalidJson {
            table: "buckets",
            column: "tags",
            record_id,
            ..
        }) if record_id == "invalid-tags"
    ));
    assert!(matches!(
        store.get_bucket("invalid-time"),
        Err(StoreError::InvalidTimestamp {
            table: "buckets",
            column: "created_at",
            record_id,
            value
        }) if record_id == "invalid-time" && value == "yesterday"
    ));
    assert!(matches!(
        store.get_todo("invalid-todo-status"),
        Err(StoreError::InvalidTodoStatus { todo_id, value })
            if todo_id == "invalid-todo-status" && value == "blocked"
    ));
    assert!(matches!(
        store.get_todo("invalid-todo-time"),
        Err(StoreError::InvalidTimestamp {
            table: "todos",
            column: "due_date",
            record_id,
            value
        }) if record_id == "invalid-todo-time" && value == "tomorrow"
    ));
    assert!(matches!(
        store.get_classification_record("invalid-classification-action"),
        Err(StoreError::InvalidClassificationAction {
            classification_record_id,
            value
        }) if classification_record_id == "invalid-classification-action" && value == "append"
    ));
    assert!(matches!(
        store.get_classification_record("invalid-candidates"),
        Err(StoreError::InvalidJson {
            table: "classification_records",
            column: "candidate_bucket_ids",
            record_id,
            ..
        }) if record_id == "invalid-candidates"
    ));
    assert!(matches!(
        store.get_classification_record("invalid-corrected"),
        Err(StoreError::InvalidBoolean {
            table: "classification_records",
            column: "corrected",
            record_id,
            value: 2
        }) if record_id == "invalid-corrected"
    ));
    assert!(matches!(
        store.get_correction("invalid-correction-json-type"),
        Err(StoreError::InvalidJsonType {
            table: "corrections",
            column: "before_json",
            record_id,
            expected: "object, array, or null",
            found: "number"
        }) if record_id == "invalid-correction-json-type"
    ));
    assert!(matches!(
        store.get_chat_message("invalid-chat-role"),
        Err(StoreError::InvalidChatRole {
            chat_message_id,
            value
        }) if chat_message_id == "invalid-chat-role" && value == "system"
    ));
    assert!(matches!(
        store.get_chat_message("invalid-chat-details"),
        Err(StoreError::InvalidJsonType {
            table: "chat_messages",
            column: "details_json",
            record_id,
            expected: "object, array, or null",
            found: "boolean"
        }) if record_id == "invalid-chat-details"
    ));
    assert!(matches!(
        store.get_chat_message("invalid-chat-time"),
        Err(StoreError::InvalidTimestamp {
            table: "chat_messages",
            column: "created_at",
            record_id,
            value
        }) if record_id == "invalid-chat-time" && value == "later"
    ));
}

fn create_current_tables(connection: &Connection) {
    create_buckets_table(connection);
    connection
        .execute_batch(
            "CREATE TABLE entries (
                id TEXT PRIMARY KEY,
                bucket_id TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                summary TEXT,
                content_type TEXT NOT NULL,
                classification_confidence REAL,
                classification_reason TEXT,
                created_at TEXT NOT NULL,
                moved_from_bucket_id TEXT
            );
            CREATE TABLE todos (
                id TEXT PRIMARY KEY,
                bucket_id TEXT NOT NULL,
                entry_id TEXT,
                text TEXT NOT NULL,
                status TEXT NOT NULL,
                due_date TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE evidences (
                id TEXT PRIMARY KEY,
                bucket_id TEXT NOT NULL,
                entry_id TEXT,
                text TEXT NOT NULL,
                source TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE timeline_events (
                id TEXT PRIMARY KEY,
                bucket_id TEXT NOT NULL,
                entry_id TEXT,
                event_time TEXT,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE decisions (
                id TEXT PRIMARY KEY,
                bucket_id TEXT NOT NULL,
                entry_id TEXT,
                text TEXT NOT NULL,
                reason TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE classification_records (
                id TEXT PRIMARY KEY,
                raw_text TEXT NOT NULL,
                action TEXT NOT NULL,
                bucket_id TEXT,
                entry_id TEXT,
                confidence REAL NOT NULL,
                reason TEXT NOT NULL,
                candidate_bucket_ids TEXT NOT NULL,
                current_focus_bucket_id TEXT,
                prompt_version TEXT NOT NULL,
                model_name TEXT NOT NULL,
                corrected INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE corrections (
                id TEXT PRIMARY KEY,
                command_text TEXT NOT NULL,
                action TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE chat_messages (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                tool_name TEXT,
                tool_call_id TEXT,
                details_json TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .expect("business tables must be created");
}

fn create_buckets_table(connection: &Connection) {
    connection
        .execute_batch(
            "CREATE TABLE buckets (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                type TEXT NOT NULL,
                status TEXT NOT NULL,
                summary TEXT NOT NULL,
                tags TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL
            );",
        )
        .expect("buckets table must be created");
}

fn insert_bucket(
    connection: &Connection,
    id: &str,
    bucket_type: &str,
    status: &str,
    tags: &str,
    created_at: &str,
) {
    connection
        .execute(
            "INSERT INTO buckets (
                id, title, type, status, summary, tags,
                created_at, updated_at, last_active_at
             ) VALUES (?1, 'Fixture', ?2, ?3, '', ?4, ?5, ?6, ?6)",
            params![id, bucket_type, status, tags, created_at, valid_time()],
        )
        .expect("fixture bucket must be inserted");
}

fn insert_classification(
    connection: &Connection,
    id: &str,
    action: &str,
    candidates: &str,
    corrected: i64,
) {
    connection
        .execute(
            "INSERT INTO classification_records (
                id, raw_text, action, bucket_id, entry_id, confidence, reason,
                candidate_bucket_ids, current_focus_bucket_id, prompt_version,
                model_name, corrected, created_at
             ) VALUES (?1, 'Fixture', ?2, NULL, NULL, 0.5, 'Fixture', ?3,
                       NULL, 'fixture-v1', 'fixture-model', ?4, ?5)",
            params![id, action, candidates, corrected, valid_time()],
        )
        .expect("invalid classification fixture must be inserted");
}

fn insert_chat_message(
    connection: &Connection,
    id: &str,
    role: &str,
    details_json: Option<&str>,
    created_at: &str,
) {
    connection
        .execute(
            "INSERT INTO chat_messages (
                id, role, content, tool_name, tool_call_id, details_json, created_at
             ) VALUES (?1, ?2, 'Fixture', NULL, NULL, ?3, ?4)",
            params![id, role, details_json, created_at],
        )
        .expect("invalid chat fixture must be inserted");
}

const fn valid_time() -> &'static str {
    "2026-08-04 10:20:00.000000"
}
