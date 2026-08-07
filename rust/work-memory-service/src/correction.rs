use std::path::Path;

use work_memory_store::{
    MoveEntryOutcome, MoveEntryRequest, MoveLatestEntryRequest, WritableSqliteStore,
};

use crate::ServiceError;

pub const MOVE_ENTRY_ACTION: &str = "move_entry";
pub const ENTRY_TARGET_TYPE: &str = "entry";

/// Product-facing projection of one committed Entry correction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionResult {
    correction_id: String,
    command_text: String,
    action: &'static str,
    target_type: &'static str,
    entry_id: String,
    source_bucket_id: String,
    target_bucket_id: String,
    todo_ids: Vec<String>,
    evidence_ids: Vec<String>,
    timeline_event_ids: Vec<String>,
    decision_ids: Vec<String>,
    corrected_classification_record_ids: Vec<String>,
}

impl CorrectionResult {
    pub fn correction_id(&self) -> &str {
        &self.correction_id
    }

    pub fn command_text(&self) -> &str {
        &self.command_text
    }

    pub const fn action(&self) -> &'static str {
        self.action
    }

    pub const fn target_type(&self) -> &'static str {
        self.target_type
    }

    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }

    pub fn source_bucket_id(&self) -> &str {
        &self.source_bucket_id
    }

    pub fn target_bucket_id(&self) -> &str {
        &self.target_bucket_id
    }

    pub fn todo_ids(&self) -> &[String] {
        &self.todo_ids
    }

    pub fn evidence_ids(&self) -> &[String] {
        &self.evidence_ids
    }

    pub fn timeline_event_ids(&self) -> &[String] {
        &self.timeline_event_ids
    }

    pub fn decision_ids(&self) -> &[String] {
        &self.decision_ids
    }

    pub fn corrected_classification_record_ids(&self) -> &[String] {
        &self.corrected_classification_record_ids
    }
}

/// Product-level correction orchestration backed by a validated writable store.
pub struct CorrectionService {
    store: WritableSqliteStore,
}

impl CorrectionService {
    /// Open an existing legacy-compatible database for isolated Rust writes.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, ServiceError> {
        Ok(Self {
            store: WritableSqliteStore::open_existing(path)?,
        })
    }

    /// Build the service around an already validated writable store.
    pub const fn new(store: WritableSqliteStore) -> Self {
        Self { store }
    }

    /// Move one explicit Entry aggregate to one explicit Bucket.
    pub fn move_entry(
        &mut self,
        entry_id: impl Into<String>,
        target_bucket_id: impl Into<String>,
        command_text: impl Into<String>,
    ) -> Result<CorrectionResult, ServiceError> {
        let command_text = cleaned_command(command_text.into())?;
        let request = MoveEntryRequest::new(entry_id, target_bucket_id, command_text.clone())?;
        let outcome = self.store.move_entry(&request)?;
        Ok(project_result(command_text, outcome))
    }

    /// Move the latest Entry, resolving the destination from an explicit ID or command text.
    ///
    /// When no target ID is supplied, this preserves the legacy MVP's supported
    /// Chinese command form and uses the final `移到`/`放到` destination. Latest
    /// Entry selection, title resolution, and the aggregate write remain in one
    /// store transaction.
    pub fn move_latest_entry(
        &mut self,
        command_text: impl Into<String>,
        target_bucket_id: Option<&str>,
    ) -> Result<CorrectionResult, ServiceError> {
        let command_text = cleaned_command(command_text.into())?;
        let request = if let Some(target_bucket_id) = target_bucket_id {
            MoveLatestEntryRequest::for_bucket_id(target_bucket_id, command_text.clone())?
        } else {
            let target_title = target_title_from_command(&command_text)
                .ok_or(ServiceError::UnrecognizedCorrectionTarget)?;
            MoveLatestEntryRequest::for_bucket_title_contains(target_title, command_text.clone())?
        };
        let outcome = self.store.move_latest_entry(&request)?;
        Ok(project_result(command_text, outcome))
    }
}

fn project_result(command_text: String, outcome: MoveEntryOutcome) -> CorrectionResult {
    CorrectionResult {
        correction_id: outcome.correction_id().to_owned(),
        command_text,
        action: MOVE_ENTRY_ACTION,
        target_type: ENTRY_TARGET_TYPE,
        entry_id: outcome.entry_id().to_owned(),
        source_bucket_id: outcome.source_bucket_id().to_owned(),
        target_bucket_id: outcome.target_bucket_id().to_owned(),
        todo_ids: outcome.todo_ids().to_vec(),
        evidence_ids: outcome.evidence_ids().to_vec(),
        timeline_event_ids: outcome.timeline_event_ids().to_vec(),
        decision_ids: outcome.decision_ids().to_vec(),
        corrected_classification_record_ids: outcome.corrected_classification_record_ids().to_vec(),
    }
}

fn cleaned_command(command_text: String) -> Result<String, ServiceError> {
    let cleaned = command_text.trim();
    if cleaned.is_empty() {
        return Err(ServiceError::EmptyCorrectionCommand);
    }
    Ok(cleaned.to_owned())
}

fn target_title_from_command(command_text: &str) -> Option<String> {
    let mut markers = ["移到", "放到"]
        .into_iter()
        .flat_map(|marker| {
            command_text
                .match_indices(marker)
                .map(move |(start, _)| (start, marker))
        })
        .collect::<Vec<_>>();
    markers.sort_by_key(|(start, _)| *start);

    let mut last_match = None;
    for (start, marker) in markers {
        let remainder = &command_text[start + marker.len()..];
        let end = ["里", "中", "，", ",", "。"]
            .into_iter()
            .filter_map(|delimiter| remainder.find(delimiter))
            .min()
            .unwrap_or(remainder.len());
        let captured = &remainder[..end];
        if !captured.is_empty() {
            last_match = Some(
                captured
                    .trim_matches(|character| matches!(character, ' ' | '，' | ',' | '：' | ':'))
                    .to_owned(),
            );
        }
    }

    last_match.filter(|title| !title.is_empty())
}

#[cfg(test)]
mod tests {
    use super::target_title_from_command;

    #[test]
    fn command_parser_uses_the_final_destination() {
        assert_eq!(
            target_title_from_command("刚才那条不要放到支付问题，放到接口稳定性问题里。"),
            Some("接口稳定性问题".to_owned())
        );
        assert_eq!(
            target_title_from_command("请移到 API rollout 中"),
            Some("API rollout".to_owned())
        );
    }

    #[test]
    fn command_parser_rejects_missing_or_empty_destinations() {
        assert_eq!(target_title_from_command("移动最近一条"), None);
        assert_eq!(target_title_from_command("放到   里"), None);
        assert_eq!(target_title_from_command("放到"), None);
    }
}
