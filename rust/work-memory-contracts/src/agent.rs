use serde::Deserialize;
use serde_json::{Map, Value};
use work_memory_core::BucketType;

use crate::ContractError;
use crate::timestamp::parse_timestamp;
use crate::values::{bucket_status, bucket_type, trim, trim_list, trim_optional};

/// Stable names of the allow-listed memory tools.
pub const LIST_ACTIVE_BUCKETS_TOOL: &str = "list_active_buckets";
pub const SEARCH_MEMORY_TOOL: &str = "search_memory";
pub const GET_BUCKET_DETAIL_TOOL: &str = "get_bucket_detail";
pub const ARCHIVE_MEMORY_TOOL: &str = "archive_memory";
pub const SAVE_TO_EXISTING_BUCKET_TOOL: &str = "save_to_existing_bucket";
pub const CREATE_BUCKET_AND_SAVE_TOOL: &str = "create_bucket_and_save";

/// Input bounds applied before a model-generated tool call reaches a service.
/// The service layer still validates its own domain limits; these bounds keep
/// malformed model output from consuming unbounded memory or SQLite work.
pub const MAX_AGENT_QUERY_CHARS: usize = 500;
pub const MAX_AGENT_BUCKET_ID_CHARS: usize = 200;
pub const MAX_AGENT_TEXT_CHARS: usize = 16_000;
pub const MAX_AGENT_TITLE_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentToolParameterKind {
    String,
    BucketType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentToolParameter {
    pub name: &'static str,
    pub description: Option<&'static str>,
    pub kind: AgentToolParameterKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub properties: &'static [AgentToolParameter],
    pub required: &'static [&'static str],
}

impl AgentToolDefinition {
    pub fn parameters_schema(self) -> Value {
        let properties: Map<String, Value> = self
            .properties
            .iter()
            .map(|property| {
                let mut schema = Map::new();
                schema.insert("type".to_owned(), Value::String("string".to_owned()));
                if let Some(description) = property.description {
                    schema.insert(
                        "description".to_owned(),
                        Value::String(description.to_owned()),
                    );
                }
                if property.kind == AgentToolParameterKind::BucketType {
                    schema.insert(
                        "enum".to_owned(),
                        Value::Array(
                            BucketType::ALL
                                .iter()
                                .map(|bucket_type| Value::String(bucket_type.as_str().to_owned()))
                                .collect(),
                        ),
                    );
                }
                (property.name.to_owned(), Value::Object(schema))
            })
            .collect();

        serde_json::json!({
            "type": "object",
            "properties": properties,
            "required": self.required,
            "additionalProperties": false,
        })
    }
}

const SEARCH_MEMORY_PROPERTIES: &[AgentToolParameter] = &[AgentToolParameter {
    name: "query",
    description: Some("简短、明确的搜索关键词"),
    kind: AgentToolParameterKind::String,
}];
const GET_BUCKET_DETAIL_PROPERTIES: &[AgentToolParameter] = &[AgentToolParameter {
    name: "bucket_id",
    description: Some("真实 Bucket ID"),
    kind: AgentToolParameterKind::String,
}];
const ARCHIVE_MEMORY_PROPERTIES: &[AgentToolParameter] = &[AgentToolParameter {
    name: "text",
    description: Some("要保存的完整事实或工作记录"),
    kind: AgentToolParameterKind::String,
}];
const SAVE_TO_EXISTING_BUCKET_PROPERTIES: &[AgentToolParameter] = &[
    AgentToolParameter {
        name: "bucket_id",
        description: None,
        kind: AgentToolParameterKind::String,
    },
    AgentToolParameter {
        name: "text",
        description: None,
        kind: AgentToolParameterKind::String,
    },
];
const CREATE_BUCKET_AND_SAVE_PROPERTIES: &[AgentToolParameter] = &[
    AgentToolParameter {
        name: "title",
        description: None,
        kind: AgentToolParameterKind::String,
    },
    AgentToolParameter {
        name: "bucket_type",
        description: None,
        kind: AgentToolParameterKind::BucketType,
    },
    AgentToolParameter {
        name: "text",
        description: None,
        kind: AgentToolParameterKind::String,
    },
];

/// The single source of truth for tool names, descriptions, and strict argument schemas.
pub const AGENT_TOOL_DEFINITIONS: &[AgentToolDefinition] = &[
    AgentToolDefinition {
        name: LIST_ACTIVE_BUCKETS_TOOL,
        description: "列出最近活跃的 Bucket。用户提到历史工作但未给出关键词时使用。",
        properties: &[],
        required: &[],
    },
    AgentToolDefinition {
        name: SEARCH_MEMORY_TOOL,
        description: "按关键词搜索 Bucket 标题、摘要、标签和原始记录，用于查找长期记忆。",
        properties: SEARCH_MEMORY_PROPERTIES,
        required: &["query"],
    },
    AgentToolDefinition {
        name: GET_BUCKET_DETAIL_TOOL,
        description: "读取一个 Bucket 的摘要、Todo、证据、决策、时间线和原始记录。",
        properties: GET_BUCKET_DETAIL_PROPERTIES,
        required: &["bucket_id"],
    },
    AgentToolDefinition {
        name: ARCHIVE_MEMORY_TOOL,
        description: "让现有分类与风险门控流程保存值得长期跟踪的工作事实、目标、进展、证据、结论或 Todo；无需等待用户明确说记住。",
        properties: ARCHIVE_MEMORY_PROPERTIES,
        required: &["text"],
    },
    AgentToolDefinition {
        name: SAVE_TO_EXISTING_BUCKET_TOOL,
        description: "用户已经明确确认目标 Bucket 后，把内容直接保存到该 Bucket。",
        properties: SAVE_TO_EXISTING_BUCKET_PROPERTIES,
        required: &["bucket_id", "text"],
    },
    AgentToolDefinition {
        name: CREATE_BUCKET_AND_SAVE_TOOL,
        description: "用户已经明确同意新建时，创建 Bucket 并保存内容。",
        properties: CREATE_BUCKET_AND_SAVE_PROPERTIES,
        required: &["title", "bucket_type", "text"],
    },
];

pub fn agent_tool_definition(name: &str) -> Option<&'static AgentToolDefinition> {
    AGENT_TOOL_DEFINITIONS
        .iter()
        .find(|definition| definition.name == name)
}

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
            LIST_ACTIVE_BUCKETS_TOOL => {
                let _: EmptyArguments = serde_json::from_value(value)?;
                Ok(Self::ListActiveBuckets)
            }
            SEARCH_MEMORY_TOOL => {
                let input: QueryArguments = serde_json::from_value(value)?;
                Ok(Self::SearchMemory {
                    query: required_tool_text(
                        SEARCH_MEMORY_TOOL,
                        "query",
                        input.query,
                        MAX_AGENT_QUERY_CHARS,
                    )?,
                })
            }
            GET_BUCKET_DETAIL_TOOL => {
                let input: BucketIdArguments = serde_json::from_value(value)?;
                Ok(Self::GetBucketDetail {
                    bucket_id: required_tool_text(
                        GET_BUCKET_DETAIL_TOOL,
                        "bucket_id",
                        input.bucket_id,
                        MAX_AGENT_BUCKET_ID_CHARS,
                    )?,
                })
            }
            ARCHIVE_MEMORY_TOOL => {
                let input: TextArguments = serde_json::from_value(value)?;
                Ok(Self::ArchiveMemory {
                    text: required_tool_text(
                        ARCHIVE_MEMORY_TOOL,
                        "text",
                        input.text,
                        MAX_AGENT_TEXT_CHARS,
                    )?,
                })
            }
            SAVE_TO_EXISTING_BUCKET_TOOL => {
                let input: ExistingBucketArguments = serde_json::from_value(value)?;
                Ok(Self::SaveToExistingBucket {
                    bucket_id: required_tool_text(
                        SAVE_TO_EXISTING_BUCKET_TOOL,
                        "bucket_id",
                        input.bucket_id,
                        MAX_AGENT_BUCKET_ID_CHARS,
                    )?,
                    text: required_tool_text(
                        SAVE_TO_EXISTING_BUCKET_TOOL,
                        "text",
                        input.text,
                        MAX_AGENT_TEXT_CHARS,
                    )?,
                })
            }
            CREATE_BUCKET_AND_SAVE_TOOL => {
                let input: NewBucketArguments = serde_json::from_value(value)?;
                Ok(Self::CreateBucketAndSave {
                    title: required_tool_text(
                        CREATE_BUCKET_AND_SAVE_TOOL,
                        "title",
                        input.title,
                        MAX_AGENT_TITLE_CHARS,
                    )?,
                    bucket_type: bucket_type(&input.bucket_type)?,
                    text: required_tool_text(
                        CREATE_BUCKET_AND_SAVE_TOOL,
                        "text",
                        input.text,
                        MAX_AGENT_TEXT_CHARS,
                    )?,
                })
            }
            name => Err(ContractError::UnknownTool(name.to_owned())),
        }
    }

    pub const fn tool_name(&self) -> &'static str {
        match self {
            Self::ListActiveBuckets => LIST_ACTIVE_BUCKETS_TOOL,
            Self::SearchMemory { .. } => SEARCH_MEMORY_TOOL,
            Self::GetBucketDetail { .. } => GET_BUCKET_DETAIL_TOOL,
            Self::ArchiveMemory { .. } => ARCHIVE_MEMORY_TOOL,
            Self::SaveToExistingBucket { .. } => SAVE_TO_EXISTING_BUCKET_TOOL,
            Self::CreateBucketAndSave { .. } => CREATE_BUCKET_AND_SAVE_TOOL,
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

fn required_tool_text(
    tool: &'static str,
    field: &'static str,
    value: String,
    max_chars: usize,
) -> Result<String, ContractError> {
    let value = trim(value);
    if value.is_empty() {
        return Err(ContractError::InvalidToolArgument {
            tool,
            field,
            reason: "must not be empty after trimming",
        });
    }
    if value.chars().count() > max_chars {
        return Err(ContractError::InvalidToolArgument {
            tool,
            field,
            reason: "exceeds the maximum length",
        });
    }
    Ok(value)
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
