use std::error::Error;
use std::fmt::{self, Display, Formatter};

use work_memory_core::CoreError;

/// Errors raised while parsing or normalizing a boundary contract.
#[derive(Debug)]
pub enum ContractError {
    Json(serde_json::Error),
    Core(CoreError),
    InvalidEnum { field: &'static str, value: String },
    InvalidTimestamp(String),
    InvalidDetails,
    UnknownTool(String),
}

impl Display for ContractError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => Display::fmt(error, formatter),
            Self::Core(error) => Display::fmt(error, formatter),
            Self::InvalidEnum { field, value } => {
                write!(formatter, "invalid {field}: {value}")
            }
            Self::InvalidTimestamp(value) => write!(formatter, "invalid datetime: {value}"),
            Self::InvalidDetails => {
                formatter.write_str("details must be an object, array, or null")
            }
            Self::UnknownTool(name) => write!(formatter, "unknown tool: {name}"),
        }
    }
}

impl Error for ContractError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::Core(error) => Some(error),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for ContractError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<CoreError> for ContractError {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}
