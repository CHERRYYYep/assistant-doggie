use chrono::{DateTime, TimeDelta, Timelike, Utc};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

use crate::archive_write::{current_timestamp, new_uuid_v4, required_text, serialize_json};
use crate::records::decode_chat_message;
use crate::{ChatRole, StoreError, StoredChatMessage, StoredTimestamp, WritableSqliteStore};

/// A validated message ready to append to the singleton conversation timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessageWriteRequest {
    role: ChatRole,
    content: String,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    details_json: Option<Value>,
}

impl ChatMessageWriteRequest {
    pub fn new(
        role: ChatRole,
        content: impl Into<String>,
        tool_name: Option<String>,
        tool_call_id: Option<String>,
        details_json: Option<Value>,
    ) -> Result<Self, StoreError> {
        let details_json = match details_json {
            None | Some(Value::Null) => None,
            Some(value @ (Value::Object(_) | Value::Array(_))) => Some(value),
            Some(_) => {
                return Err(StoreError::InvalidWriteField {
                    field: "details_json",
                    reason: "must be an object, array, or null",
                });
            }
        };
        Ok(Self {
            role,
            content: required_text(content.into(), "content")?,
            tool_name,
            tool_call_id,
            details_json,
        })
    }

    pub const fn role(&self) -> ChatRole {
        self.role
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn tool_name(&self) -> Option<&str> {
        self.tool_name.as_deref()
    }

    pub fn tool_call_id(&self) -> Option<&str> {
        self.tool_call_id.as_deref()
    }

    pub const fn details_json(&self) -> Option<&Value> {
        self.details_json.as_ref()
    }
}

impl WritableSqliteStore {
    /// Append one validated ChatMessage in its own immediate transaction.
    ///
    /// The timestamp is guaranteed to sort after the current newest persisted
    /// message, preserving append order even when SQLite's wall-clock precision
    /// is coarser than consecutive writes.
    pub fn append_chat_message(
        &mut self,
        request: &ChatMessageWriteRequest,
    ) -> Result<StoredChatMessage, StoreError> {
        self.run_transaction(|transaction| append_chat_message(transaction, request))
    }
}

fn append_chat_message(
    transaction: &Transaction<'_>,
    request: &ChatMessageWriteRequest,
) -> Result<StoredChatMessage, StoreError> {
    let id = new_uuid_v4(transaction)?;
    let created_at = next_chat_timestamp(transaction)?;
    let details_json = request
        .details_json
        .as_ref()
        .map(|details| serialize_json(details, "chat_messages.details_json"))
        .transpose()?;
    transaction.execute(
        "INSERT INTO chat_messages (
            id, role, content, tool_name, tool_call_id, details_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            request.role.as_str(),
            request.content,
            request.tool_name,
            request.tool_call_id,
            details_json,
            created_at,
        ],
    )?;

    let mut statement = transaction.prepare(
        "SELECT id, role, content, tool_name, tool_call_id, details_json, created_at
         FROM chat_messages
         WHERE id = ?1",
    )?;
    let mut rows = statement.query([&id])?;
    rows.next()?
        .map(decode_chat_message)
        .transpose()?
        .ok_or(StoreError::MissingRecord {
            table: "chat_messages",
            id,
        })
}

fn next_chat_timestamp(transaction: &Transaction<'_>) -> Result<String, StoreError> {
    let candidate = current_timestamp(transaction)?;
    let candidate_timestamp = StoredTimestamp::parse(
        "chat_messages",
        "created_at",
        "new-message",
        candidate.clone(),
    )?;
    let newest = transaction
        .query_row(
            "SELECT id, created_at
             FROM chat_messages
             ORDER BY created_at DESC, id DESC
             LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((newest_id, newest_raw)) = newest else {
        return Ok(candidate);
    };
    let newest_timestamp = StoredTimestamp::parse(
        "chat_messages",
        "created_at",
        &newest_id,
        newest_raw.clone(),
    )?;
    if candidate_timestamp.utc_naive() > newest_timestamp.utc_naive()
        && candidate.as_str() > newest_raw.as_str()
    {
        return Ok(candidate);
    }

    if let Ok(newest_rfc3339) = DateTime::parse_from_rfc3339(&newest_raw) {
        let candidate_utc = DateTime::<Utc>::from_naive_utc_and_offset(
            candidate_timestamp.utc_naive().to_owned(),
            Utc,
        );
        let candidate_with_offset = candidate_utc.with_timezone(newest_rfc3339.offset());
        let base = candidate_with_offset.max(newest_rfc3339);
        let next = base
            .with_nanosecond(0)
            .and_then(|timestamp| timestamp.checked_add_signed(TimeDelta::seconds(1)))
            .ok_or(StoreError::InvalidWriteField {
                field: "created_at",
                reason: "newest chat timestamp cannot be incremented",
            })?;
        return Ok(next.format("%Y-%m-%dT%H:%M:%S%:z").to_string());
    }

    let next = newest_timestamp
        .utc_naive()
        .checked_add_signed(TimeDelta::microseconds(1))
        .ok_or(StoreError::InvalidWriteField {
            field: "created_at",
            reason: "newest chat timestamp cannot be incremented",
        })?;
    Ok(next.format("%Y-%m-%d %H:%M:%S%.6f").to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::ChatMessageWriteRequest;
    use crate::{ChatRole, StoreError};

    #[test]
    fn request_normalizes_content_and_json_null() {
        let request = ChatMessageWriteRequest::new(
            ChatRole::Tool,
            "  {\"ok\": true}  ",
            Some(" search_memory ".to_owned()),
            Some(" call-1 ".to_owned()),
            Some(Value::Null),
        )
        .unwrap();

        assert_eq!(request.role(), ChatRole::Tool);
        assert_eq!(request.content(), "{\"ok\": true}");
        assert_eq!(request.tool_name(), Some(" search_memory "));
        assert_eq!(request.tool_call_id(), Some(" call-1 "));
        assert_eq!(request.details_json(), None);
    }

    #[test]
    fn request_rejects_empty_content_and_scalar_details() {
        assert!(matches!(
            ChatMessageWriteRequest::new(ChatRole::User, " \t\n ", None, None, None),
            Err(StoreError::InvalidWriteField {
                field: "content",
                ..
            })
        ));
        assert!(matches!(
            ChatMessageWriteRequest::new(ChatRole::Assistant, "answer", None, None, Some(json!(3)),),
            Err(StoreError::InvalidWriteField {
                field: "details_json",
                ..
            })
        ));
    }
}
