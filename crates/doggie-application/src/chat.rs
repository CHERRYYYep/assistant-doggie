use std::path::Path;

use doggie_storage_sqlite::{
    ChatMessageWriteRequest, ChatRole, StoredChatMessage, StoredTimestamp, WritableSqliteStore,
};
use serde_json::Value;

use crate::ServiceError;

/// Stable product projection for one committed ChatMessage.
///
/// legacy persists optional tool metadata exactly, then its `ChatMessageView`
/// trims string fields. This projection preserves that return-value behavior
/// without changing the exact database values owned by the Store.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessageSaveResult {
    id: String,
    role: ChatRole,
    content: String,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    details: Option<Value>,
    created_at: StoredTimestamp,
}

impl ChatMessageSaveResult {
    fn from_store(message: StoredChatMessage) -> Self {
        Self {
            id: message.id,
            role: message.role,
            content: message.content,
            tool_name: message.tool_name.map(|value| value.trim().to_owned()),
            tool_call_id: message.tool_call_id.map(|value| value.trim().to_owned()),
            details: message.details_json,
            created_at: message.created_at,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
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

    pub const fn details(&self) -> Option<&Value> {
        self.details.as_ref()
    }

    pub const fn created_at(&self) -> &StoredTimestamp {
        &self.created_at
    }
}

/// Product-level persistence for the singleton conversation timeline.
///
/// The service owns a validated writable Store and accepts product message
/// fields directly. It intentionally appends one committed message per call;
/// complete Agent-turn orchestration and multi-message transactions remain
/// outside this boundary.
pub struct ChatMessagePersistenceService {
    store: WritableSqliteStore,
}

impl ChatMessagePersistenceService {
    /// Open an existing legacy-compatible database for isolated Doggie writes.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, ServiceError> {
        Ok(Self {
            store: WritableSqliteStore::open_existing(path)?,
        })
    }

    /// Build the service around an already validated writable store.
    pub const fn new(store: WritableSqliteStore) -> Self {
        Self { store }
    }

    /// Append one user, assistant, or tool message in its own transaction.
    pub fn append_chat_message(
        &mut self,
        role: ChatRole,
        content: impl Into<String>,
        tool_name: Option<String>,
        tool_call_id: Option<String>,
        details_json: Option<Value>,
    ) -> Result<ChatMessageSaveResult, ServiceError> {
        let request =
            ChatMessageWriteRequest::new(role, content, tool_name, tool_call_id, details_json)?;
        let message = self.store.append_chat_message(&request)?;
        Ok(ChatMessageSaveResult::from_store(message))
    }
}
