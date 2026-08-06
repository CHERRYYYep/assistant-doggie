use thiserror::Error;

use work_memory_core::CoreError;

/// Errors raised while parsing or normalizing a boundary contract.
#[derive(Debug, Error)]
pub enum ContractError {
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Core(#[from] CoreError),
    #[error("invalid {field}: {value}")]
    InvalidEnum { field: &'static str, value: String },
    #[error("invalid datetime: {0}")]
    InvalidTimestamp(String),
    #[error("details must be an object, array, or null")]
    InvalidDetails,
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    #[error("invalid argument for {tool}.{field}: {reason}")]
    InvalidToolArgument {
        tool: &'static str,
        field: &'static str,
        reason: &'static str,
    },
}
