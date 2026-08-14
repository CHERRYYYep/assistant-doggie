use doggie_domain::{ArchiveStatus, BucketStatus, BucketType, ClassificationAction};

use crate::ContractError;

pub(crate) fn bucket_type(value: &str) -> Result<BucketType, ContractError> {
    match value {
        "idea" => Ok(BucketType::Idea),
        "task" => Ok(BucketType::Task),
        "incident" => Ok(BucketType::Incident),
        "experiment" => Ok(BucketType::Experiment),
        "decision" => Ok(BucketType::Decision),
        "meeting" => Ok(BucketType::Meeting),
        "knowledge" => Ok(BucketType::Knowledge),
        "draft" => Ok(BucketType::Draft),
        value => Err(ContractError::InvalidEnum {
            field: "bucket_type",
            value: value.to_owned(),
        }),
    }
}

pub(crate) fn optional_bucket_type(
    value: Option<String>,
) -> Result<Option<BucketType>, ContractError> {
    value.map(|item| bucket_type(&item)).transpose()
}

pub(crate) fn bucket_status(value: &str) -> Result<BucketStatus, ContractError> {
    match value {
        "active" => Ok(BucketStatus::Active),
        "paused" => Ok(BucketStatus::Paused),
        "done" => Ok(BucketStatus::Done),
        "archived" => Ok(BucketStatus::Archived),
        value => Err(ContractError::InvalidEnum {
            field: "status",
            value: value.to_owned(),
        }),
    }
}

pub(crate) fn classification_action(value: &str) -> Result<ClassificationAction, ContractError> {
    match value {
        "append_existing" => Ok(ClassificationAction::AppendExisting),
        "create_new" => Ok(ClassificationAction::CreateNew),
        "ask_user" => Ok(ClassificationAction::AskUser),
        value => Err(ContractError::InvalidEnum {
            field: "action",
            value: value.to_owned(),
        }),
    }
}

pub(crate) fn archive_status(value: &str) -> Result<ArchiveStatus, ContractError> {
    match value {
        "archived" => Ok(ArchiveStatus::Archived),
        "needs_confirmation" => Ok(ArchiveStatus::NeedsConfirmation),
        value => Err(ContractError::InvalidEnum {
            field: "status",
            value: value.to_owned(),
        }),
    }
}

pub(crate) fn trim(value: String) -> String {
    value.trim().to_owned()
}

pub(crate) fn trim_optional(value: Option<String>) -> Option<String> {
    value.map(trim)
}

pub(crate) fn trim_list(values: Vec<String>) -> Vec<String> {
    values.into_iter().map(trim).collect()
}
