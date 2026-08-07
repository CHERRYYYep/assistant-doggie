use std::fmt::{self, Display, Formatter};

use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::Row;
use serde_json::Value;
use work_memory_contracts::ChatRole;
use work_memory_core::{BucketStatus, BucketType, ClassificationAction};

use crate::StoreError;

/// A timestamp parsed from SQLite while retaining the exact persisted text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTimestamp {
    raw: String,
    utc_naive: NaiveDateTime,
}

impl StoredTimestamp {
    /// Return the exact text stored by SQLite.
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// Return the timestamp normalized to a timezone-free UTC value.
    ///
    /// SQLAlchemy's SQLite adapter omits the UTC offset. Such values are treated
    /// as UTC because the legacy application writes them with `utc_now()`.
    pub const fn utc_naive(&self) -> &NaiveDateTime {
        &self.utc_naive
    }

    pub(crate) fn parse(
        table: &'static str,
        column: &'static str,
        record_id: &str,
        raw: String,
    ) -> Result<Self, StoreError> {
        let sqlite_value = NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S%.f");
        let utc_naive = match sqlite_value {
            Ok(value) => value,
            Err(_) => DateTime::parse_from_rfc3339(&raw)
                .map(|value| value.with_timezone(&Utc).naive_utc())
                .map_err(|_| StoreError::InvalidTimestamp {
                    table,
                    column,
                    record_id: record_id.to_owned(),
                    value: raw.clone(),
                })?,
        };

        Ok(Self { raw, utc_naive })
    }
}

impl Display for StoredTimestamp {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.raw)
    }
}

/// Todo lifecycle values persisted by the legacy implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TodoStatus {
    Open,
    Done,
    Cancelled,
}

impl TodoStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }
}

impl Display for TodoStatus {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A Bucket row decoded from the current legacy-managed SQLite schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredBucket {
    pub id: String,
    pub title: String,
    pub bucket_type: BucketType,
    pub status: BucketStatus,
    pub summary: String,
    pub tags: Vec<String>,
    pub created_at: StoredTimestamp,
    pub updated_at: StoredTimestamp,
    pub last_active_at: StoredTimestamp,
}

/// An immutable Entry row decoded from the current legacy-managed schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEntry {
    pub id: String,
    pub bucket_id: String,
    pub raw_text: String,
    pub summary: Option<String>,
    pub content_type: String,
    pub classification_confidence: Option<f64>,
    pub classification_reason: Option<String>,
    pub created_at: StoredTimestamp,
    pub moved_from_bucket_id: Option<String>,
}

/// A Todo row decoded from the current legacy-managed schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTodo {
    pub id: String,
    pub bucket_id: String,
    pub entry_id: Option<String>,
    pub text: String,
    pub status: TodoStatus,
    pub due_date: Option<StoredTimestamp>,
    pub created_at: StoredTimestamp,
    pub updated_at: StoredTimestamp,
}

/// An Evidence row decoded from the current legacy-managed schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvidence {
    pub id: String,
    pub bucket_id: String,
    pub entry_id: Option<String>,
    pub text: String,
    pub source: Option<String>,
    pub created_at: StoredTimestamp,
}

/// A TimelineEvent row decoded from the current legacy-managed schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTimelineEvent {
    pub id: String,
    pub bucket_id: String,
    pub entry_id: Option<String>,
    pub event_time: Option<String>,
    pub text: String,
    pub created_at: StoredTimestamp,
}

/// A Decision row decoded from the current legacy-managed schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDecision {
    pub id: String,
    pub bucket_id: String,
    pub entry_id: Option<String>,
    pub text: String,
    pub reason: Option<String>,
    pub created_at: StoredTimestamp,
}

/// A ClassificationRecord row decoded from the current legacy-managed schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredClassificationRecord {
    pub id: String,
    pub raw_text: String,
    pub action: ClassificationAction,
    pub bucket_id: Option<String>,
    pub entry_id: Option<String>,
    pub confidence: f64,
    pub reason: String,
    pub candidate_bucket_ids: Vec<String>,
    pub current_focus_bucket_id: Option<String>,
    pub prompt_version: String,
    pub model_name: String,
    pub corrected: bool,
    pub created_at: StoredTimestamp,
}

/// A Correction audit row decoded from the current legacy-managed schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredCorrection {
    pub id: String,
    pub command_text: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub before_json: Option<Value>,
    pub after_json: Option<Value>,
    pub created_at: StoredTimestamp,
}

/// A ChatMessage row decoded from the current legacy-managed schema.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub details_json: Option<Value>,
    pub created_at: StoredTimestamp,
}

pub(crate) fn decode_bucket(row: &Row<'_>) -> Result<StoredBucket, StoreError> {
    let id: String = row.get(0)?;
    let bucket_type_value: String = row.get(2)?;
    let status_value: String = row.get(3)?;
    let tags_value: String = row.get(5)?;
    let created_at: String = row.get(6)?;
    let updated_at: String = row.get(7)?;
    let last_active_at: String = row.get(8)?;

    Ok(StoredBucket {
        title: row.get(1)?,
        bucket_type: parse_bucket_type(&id, bucket_type_value)?,
        status: parse_bucket_status(&id, status_value)?,
        summary: row.get(4)?,
        tags: parse_json("buckets", "tags", &id, &tags_value)?,
        created_at: StoredTimestamp::parse("buckets", "created_at", &id, created_at)?,
        updated_at: StoredTimestamp::parse("buckets", "updated_at", &id, updated_at)?,
        last_active_at: StoredTimestamp::parse("buckets", "last_active_at", &id, last_active_at)?,
        id,
    })
}

pub(crate) fn decode_entry(row: &Row<'_>) -> Result<StoredEntry, StoreError> {
    let id: String = row.get(0)?;
    let created_at: String = row.get(7)?;

    Ok(StoredEntry {
        bucket_id: row.get(1)?,
        raw_text: row.get(2)?,
        summary: row.get(3)?,
        content_type: row.get(4)?,
        classification_confidence: row.get(5)?,
        classification_reason: row.get(6)?,
        created_at: StoredTimestamp::parse("entries", "created_at", &id, created_at)?,
        moved_from_bucket_id: row.get(8)?,
        id,
    })
}

pub(crate) fn decode_todo(row: &Row<'_>) -> Result<StoredTodo, StoreError> {
    let id: String = row.get(0)?;
    let status: String = row.get(4)?;
    let due_date: Option<String> = row.get(5)?;
    let created_at: String = row.get(6)?;
    let updated_at: String = row.get(7)?;

    Ok(StoredTodo {
        bucket_id: row.get(1)?,
        entry_id: row.get(2)?,
        text: row.get(3)?,
        status: parse_todo_status(&id, status)?,
        due_date: due_date
            .map(|value| StoredTimestamp::parse("todos", "due_date", &id, value))
            .transpose()?,
        created_at: StoredTimestamp::parse("todos", "created_at", &id, created_at)?,
        updated_at: StoredTimestamp::parse("todos", "updated_at", &id, updated_at)?,
        id,
    })
}

pub(crate) fn decode_evidence(row: &Row<'_>) -> Result<StoredEvidence, StoreError> {
    let id: String = row.get(0)?;
    let created_at: String = row.get(5)?;

    Ok(StoredEvidence {
        bucket_id: row.get(1)?,
        entry_id: row.get(2)?,
        text: row.get(3)?,
        source: row.get(4)?,
        created_at: StoredTimestamp::parse("evidences", "created_at", &id, created_at)?,
        id,
    })
}

pub(crate) fn decode_timeline_event(row: &Row<'_>) -> Result<StoredTimelineEvent, StoreError> {
    let id: String = row.get(0)?;
    let created_at: String = row.get(5)?;

    Ok(StoredTimelineEvent {
        bucket_id: row.get(1)?,
        entry_id: row.get(2)?,
        event_time: row.get(3)?,
        text: row.get(4)?,
        created_at: StoredTimestamp::parse("timeline_events", "created_at", &id, created_at)?,
        id,
    })
}

pub(crate) fn decode_decision(row: &Row<'_>) -> Result<StoredDecision, StoreError> {
    let id: String = row.get(0)?;
    let created_at: String = row.get(5)?;

    Ok(StoredDecision {
        bucket_id: row.get(1)?,
        entry_id: row.get(2)?,
        text: row.get(3)?,
        reason: row.get(4)?,
        created_at: StoredTimestamp::parse("decisions", "created_at", &id, created_at)?,
        id,
    })
}

pub(crate) fn decode_classification_record(
    row: &Row<'_>,
) -> Result<StoredClassificationRecord, StoreError> {
    let id: String = row.get(0)?;
    let action: String = row.get(2)?;
    let candidate_bucket_ids: String = row.get(7)?;
    let corrected: i64 = row.get(11)?;
    let created_at: String = row.get(12)?;

    Ok(StoredClassificationRecord {
        raw_text: row.get(1)?,
        action: parse_classification_action(&id, action)?,
        bucket_id: row.get(3)?,
        entry_id: row.get(4)?,
        confidence: row.get(5)?,
        reason: row.get(6)?,
        candidate_bucket_ids: parse_json(
            "classification_records",
            "candidate_bucket_ids",
            &id,
            &candidate_bucket_ids,
        )?,
        current_focus_bucket_id: row.get(8)?,
        prompt_version: row.get(9)?,
        model_name: row.get(10)?,
        corrected: parse_boolean("classification_records", "corrected", &id, corrected)?,
        created_at: StoredTimestamp::parse(
            "classification_records",
            "created_at",
            &id,
            created_at,
        )?,
        id,
    })
}

pub(crate) fn decode_correction(row: &Row<'_>) -> Result<StoredCorrection, StoreError> {
    let id: String = row.get(0)?;
    let before_json: Option<String> = row.get(5)?;
    let after_json: Option<String> = row.get(6)?;
    let created_at: String = row.get(7)?;

    Ok(StoredCorrection {
        command_text: row.get(1)?,
        action: row.get(2)?,
        target_type: row.get(3)?,
        target_id: row.get(4)?,
        before_json: parse_optional_container("corrections", "before_json", &id, before_json)?,
        after_json: parse_optional_container("corrections", "after_json", &id, after_json)?,
        created_at: StoredTimestamp::parse("corrections", "created_at", &id, created_at)?,
        id,
    })
}

pub(crate) fn decode_chat_message(row: &Row<'_>) -> Result<StoredChatMessage, StoreError> {
    let id: String = row.get(0)?;
    let role: String = row.get(1)?;
    let details_json: Option<String> = row.get(5)?;
    let created_at: String = row.get(6)?;

    Ok(StoredChatMessage {
        role: parse_chat_role(&id, role)?,
        content: row.get(2)?,
        tool_name: row.get(3)?,
        tool_call_id: row.get(4)?,
        details_json: parse_optional_container("chat_messages", "details_json", &id, details_json)?,
        created_at: StoredTimestamp::parse("chat_messages", "created_at", &id, created_at)?,
        id,
    })
}

fn parse_bucket_type(bucket_id: &str, value: String) -> Result<BucketType, StoreError> {
    match value.as_str() {
        "idea" => Ok(BucketType::Idea),
        "task" => Ok(BucketType::Task),
        "incident" => Ok(BucketType::Incident),
        "experiment" => Ok(BucketType::Experiment),
        "decision" => Ok(BucketType::Decision),
        "meeting" => Ok(BucketType::Meeting),
        "knowledge" => Ok(BucketType::Knowledge),
        "draft" => Ok(BucketType::Draft),
        _ => Err(StoreError::InvalidBucketType {
            bucket_id: bucket_id.to_owned(),
            value,
        }),
    }
}

fn parse_bucket_status(bucket_id: &str, value: String) -> Result<BucketStatus, StoreError> {
    match value.as_str() {
        "active" => Ok(BucketStatus::Active),
        "paused" => Ok(BucketStatus::Paused),
        "done" => Ok(BucketStatus::Done),
        "archived" => Ok(BucketStatus::Archived),
        _ => Err(StoreError::InvalidBucketStatus {
            bucket_id: bucket_id.to_owned(),
            value,
        }),
    }
}

fn parse_todo_status(todo_id: &str, value: String) -> Result<TodoStatus, StoreError> {
    match value.as_str() {
        "open" => Ok(TodoStatus::Open),
        "done" => Ok(TodoStatus::Done),
        "cancelled" => Ok(TodoStatus::Cancelled),
        _ => Err(StoreError::InvalidTodoStatus {
            todo_id: todo_id.to_owned(),
            value,
        }),
    }
}

fn parse_classification_action(
    record_id: &str,
    value: String,
) -> Result<ClassificationAction, StoreError> {
    match value.as_str() {
        "append_existing" => Ok(ClassificationAction::AppendExisting),
        "create_new" => Ok(ClassificationAction::CreateNew),
        "ask_user" => Ok(ClassificationAction::AskUser),
        _ => Err(StoreError::InvalidClassificationAction {
            classification_record_id: record_id.to_owned(),
            value,
        }),
    }
}

fn parse_chat_role(chat_message_id: &str, value: String) -> Result<ChatRole, StoreError> {
    match value.as_str() {
        "user" => Ok(ChatRole::User),
        "assistant" => Ok(ChatRole::Assistant),
        "tool" => Ok(ChatRole::Tool),
        _ => Err(StoreError::InvalidChatRole {
            chat_message_id: chat_message_id.to_owned(),
            value,
        }),
    }
}

fn parse_json<T: serde::de::DeserializeOwned>(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    raw: &str,
) -> Result<T, StoreError> {
    serde_json::from_str(raw).map_err(|source| StoreError::InvalidJson {
        table,
        column,
        record_id: record_id.to_owned(),
        source,
    })
}

fn parse_optional_container(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    raw: Option<String>,
) -> Result<Option<Value>, StoreError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value: Value = parse_json(table, column, record_id, &raw)?;
    match value {
        Value::Null => Ok(None),
        Value::Object(_) | Value::Array(_) => Ok(Some(value)),
        _ => Err(StoreError::InvalidJsonType {
            table,
            column,
            record_id: record_id.to_owned(),
            expected: "object, array, or null",
            found: json_type(&value),
        }),
    }
}

fn parse_boolean(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    value: i64,
) -> Result<bool, StoreError> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(StoreError::InvalidBoolean {
            table,
            column,
            record_id: record_id.to_owned(),
            value,
        }),
    }
}

const fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
