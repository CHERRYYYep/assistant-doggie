use serde::Deserialize;
use serde_json::{Map, Value};
use work_memory_core::BucketType;

use crate::ContractError;
use crate::timestamp::parse_timestamp;
use crate::values::{bucket_status, bucket_type, trim, trim_list, trim_optional};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArguments {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryArguments {
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BucketIdArguments {
    bucket_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextArguments {
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExistingBucketArguments {
    bucket_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NewBucketArguments {
    title: String,
    bucket_type: String,
    text: String,
}

/// Validated arguments for one registered Agent tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentToolArguments {
    ListActiveBuckets,
    SearchMemory {
        query: String,
    },
    GetBucketDetail {
        bucket_id: String,
    },
    ArchiveMemory {
        text: String,
    },
    SaveToExistingBucket {
        bucket_id: String,
        text: String,
    },
    CreateBucketAndSave {
        title: String,
        bucket_type: BucketType,
        text: String,
    },
}

impl AgentToolArguments {
    pub fn from_json(name: &str, json: &str) -> Result<Self, ContractError> {
        Self::from_value(name, serde_json::from_str(json)?)
    }

    pub fn from_value(name: &str, value: Value) -> Result<Self, ContractError> {
        match name {
            "list_active_buckets" => {
                let _: EmptyArguments = serde_json::from_value(value)?;
                Ok(Self::ListActiveBuckets)
            }
            "search_memory" => {
                let input: QueryArguments = serde_json::from_value(value)?;
                Ok(Self::SearchMemory {
                    query: trim(input.query),
                })
            }
            "get_bucket_detail" => {
                let input: BucketIdArguments = serde_json::from_value(value)?;
                Ok(Self::GetBucketDetail {
                    bucket_id: trim(input.bucket_id),
                })
            }
            "archive_memory" => {
                let input: TextArguments = serde_json::from_value(value)?;
                Ok(Self::ArchiveMemory {
                    text: trim(input.text),
                })
            }
            "save_to_existing_bucket" => {
                let input: ExistingBucketArguments = serde_json::from_value(value)?;
                Ok(Self::SaveToExistingBucket {
                    bucket_id: trim(input.bucket_id),
                    text: trim(input.text),
                })
            }
            "create_bucket_and_save" => {
                let input: NewBucketArguments = serde_json::from_value(value)?;
                Ok(Self::CreateBucketAndSave {
                    title: trim(input.title),
                    bucket_type: bucket_type(&input.bucket_type)?,
                    text: trim(input.text),
                })
            }
            name => Err(ContractError::UnknownTool(name.to_owned())),
        }
    }

    pub const fn tool_name(&self) -> &'static str {
        match self {
            Self::ListActiveBuckets => "list_active_buckets",
            Self::SearchMemory { .. } => "search_memory",
            Self::GetBucketDetail { .. } => "get_bucket_detail",
            Self::ArchiveMemory { .. } => "archive_memory",
            Self::SaveToExistingBucket { .. } => "save_to_existing_bucket",
            Self::CreateBucketAndSave { .. } => "create_bucket_and_save",
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::ListActiveBuckets => Value::Object(Map::new()),
            Self::SearchMemory { query } => serde_json::json!({"query": query}),
            Self::GetBucketDetail { bucket_id } => {
                serde_json::json!({"bucket_id": bucket_id})
            }
            Self::ArchiveMemory { text } => serde_json::json!({"text": text}),
            Self::SaveToExistingBucket { bucket_id, text } => {
                serde_json::json!({"bucket_id": bucket_id, "text": text})
            }
            Self::CreateBucketAndSave {
                title,
                bucket_type,
                text,
            } => serde_json::json!({
                "title": title,
                "bucket_type": bucket_type.as_str(),
                "text": text,
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    User,
    Assistant,
    Tool,
}

impl ChatRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

fn chat_role(value: &str) -> Result<ChatRole, ContractError> {
    match value {
        "user" => Ok(ChatRole::User),
        "assistant" => Ok(ChatRole::Assistant),
        "tool" => Ok(ChatRole::Tool),
        value => Err(ContractError::InvalidEnum {
            field: "role",
            value: value.to_owned(),
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatMessageInput {
    id: String,
    role: String,
    content: String,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    details: Option<Value>,
    created_at: String,
}

/// JSON-safe persisted message shown in the single conversation timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessageContract {
    id: String,
    role: ChatRole,
    content: String,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    details: Option<Value>,
    created_at: String,
}

impl ChatMessageContract {
    pub fn from_value(value: Value) -> Result<Self, ContractError> {
        let input: ChatMessageInput = serde_json::from_value(value)?;
        if input.details.as_ref().is_some_and(|details| {
            !details.is_object() && !details.is_array() && !details.is_null()
        }) {
            return Err(ContractError::InvalidDetails);
        }
        let (created_at, _) = parse_timestamp(input.created_at)?;
        Ok(Self {
            id: trim(input.id),
            role: chat_role(&input.role)?,
            content: trim(input.content),
            tool_name: trim_optional(input.tool_name),
            tool_call_id: trim_optional(input.tool_call_id),
            details: input.details.filter(|details| !details.is_null()),
            created_at,
        })
    }

    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "role": self.role.as_str(),
            "content": self.content,
            "tool_name": self.tool_name,
            "tool_call_id": self.tool_call_id,
            "details": self.details,
            "created_at": self.created_at,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentTurnInput {
    assistant_message: Value,
    #[serde(default)]
    tool_messages: Vec<Value>,
}

/// Final assistant answer and bounded tool activity for one turn.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentTurnContract {
    assistant_message: ChatMessageContract,
    tool_messages: Vec<ChatMessageContract>,
}

impl AgentTurnContract {
    pub fn from_value(value: Value) -> Result<Self, ContractError> {
        let input: AgentTurnInput = serde_json::from_value(value)?;
        Ok(Self {
            assistant_message: ChatMessageContract::from_value(input.assistant_message)?,
            tool_messages: input
                .tool_messages
                .into_iter()
                .map(ChatMessageContract::from_value)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "assistant_message": self.assistant_message.to_value(),
            "tool_messages": self
                .tool_messages
                .iter()
                .map(ChatMessageContract::to_value)
                .collect::<Vec<_>>(),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BucketSearchInput {
    bucket_id: String,
    title: String,
    bucket_type: String,
    status: String,
    summary: String,
    #[serde(default)]
    tags: Vec<String>,
    last_active_at: String,
    #[serde(default)]
    matched_entry_count: i64,
    #[serde(default)]
    score: i64,
}

/// Compact search result returned to the Agent and UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BucketSearchResultContract {
    bucket_id: String,
    title: String,
    bucket_type: BucketType,
    status: work_memory_core::BucketStatus,
    summary: String,
    tags: Vec<String>,
    last_active_at: String,
    matched_entry_count: i64,
    score: i64,
}

impl BucketSearchResultContract {
    pub fn from_value(value: Value) -> Result<Self, ContractError> {
        let input: BucketSearchInput = serde_json::from_value(value)?;
        let (last_active_at, _) = parse_timestamp(input.last_active_at)?;
        Ok(Self {
            bucket_id: trim(input.bucket_id),
            title: trim(input.title),
            bucket_type: bucket_type(&input.bucket_type)?,
            status: bucket_status(&input.status)?,
            summary: trim(input.summary),
            tags: trim_list(input.tags),
            last_active_at,
            matched_entry_count: input.matched_entry_count,
            score: input.score,
        })
    }

    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "bucket_id": self.bucket_id,
            "title": self.title,
            "bucket_type": self.bucket_type.as_str(),
            "status": self.status.as_str(),
            "summary": self.summary,
            "tags": self.tags,
            "last_active_at": self.last_active_at,
            "matched_entry_count": self.matched_entry_count,
            "score": self.score,
        })
    }
}
