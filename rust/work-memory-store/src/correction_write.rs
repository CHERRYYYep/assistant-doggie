use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::archive_write::{current_timestamp, new_uuid_v4, required_text, serialize_json};
use crate::bucket_summary_write::{DEFAULT_REBUILD_ENTRY_LIMIT, rebuild_bucket_summary};
use crate::read::escape_like_contains;
use crate::{StoreError, WritableSqliteStore};

const MOVE_ENTRY_ACTION: &str = "move_entry";
const SUMMARY_CHARACTER_LIMIT: i64 = 1_200;

/// A validated request to move one Entry and its derived records to another Bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveEntryRequest {
    entry_id: String,
    target_bucket_id: String,
    command_text: String,
}

impl MoveEntryRequest {
    pub fn new(
        entry_id: impl Into<String>,
        target_bucket_id: impl Into<String>,
        command_text: impl Into<String>,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            entry_id: entry_id.into(),
            target_bucket_id: target_bucket_id.into(),
            command_text: required_text(command_text.into(), "command_text")?,
        })
    }

    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }

    pub fn target_bucket_id(&self) -> &str {
        &self.target_bucket_id
    }

    pub fn command_text(&self) -> &str {
        &self.command_text
    }
}

/// A validated request to atomically select and move the latest Entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveLatestEntryRequest {
    command_text: String,
    target: LatestEntryTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LatestEntryTarget {
    BucketId(String),
    BucketTitleContains(String),
}

impl MoveLatestEntryRequest {
    /// Select the latest Entry and move it to one explicit Bucket ID.
    pub fn for_bucket_id(
        target_bucket_id: impl Into<String>,
        command_text: impl Into<String>,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            command_text: required_text(command_text.into(), "command_text")?,
            target: LatestEntryTarget::BucketId(target_bucket_id.into()),
        })
    }

    /// Select the latest Entry and resolve its target by a title fragment.
    ///
    /// Resolution preserves legacy's literal `contains(..., autoescape=True)`
    /// query followed by exact-title preference and unique fuzzy fallback.
    pub fn for_bucket_title_contains(
        target_title: impl Into<String>,
        command_text: impl Into<String>,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            command_text: required_text(command_text.into(), "command_text")?,
            target: LatestEntryTarget::BucketTitleContains(required_text(
                target_title.into(),
                "target_title",
            )?),
        })
    }

    pub fn command_text(&self) -> &str {
        &self.command_text
    }

    pub fn target_bucket_id(&self) -> Option<&str> {
        match &self.target {
            LatestEntryTarget::BucketId(bucket_id) => Some(bucket_id),
            LatestEntryTarget::BucketTitleContains(_) => None,
        }
    }

    pub fn target_title(&self) -> Option<&str> {
        match &self.target {
            LatestEntryTarget::BucketId(_) => None,
            LatestEntryTarget::BucketTitleContains(title) => Some(title),
        }
    }
}

/// IDs and aggregate effects produced by one committed Entry move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveEntryOutcome {
    correction_id: String,
    entry_id: String,
    source_bucket_id: String,
    target_bucket_id: String,
    todo_ids: Vec<String>,
    evidence_ids: Vec<String>,
    timeline_event_ids: Vec<String>,
    decision_ids: Vec<String>,
    corrected_classification_record_ids: Vec<String>,
}

impl MoveEntryOutcome {
    pub fn correction_id(&self) -> &str {
        &self.correction_id
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

impl WritableSqliteStore {
    /// Move one Entry aggregate and record the correction in one transaction.
    ///
    /// The Entry, all linked extracted rows, Bucket activity/cache fields,
    /// linked classification audits, and the Correction row either commit
    /// together or all roll back.
    pub fn move_entry(
        &mut self,
        request: &MoveEntryRequest,
    ) -> Result<MoveEntryOutcome, StoreError> {
        self.run_transaction(|transaction| move_entry(transaction, request))
    }

    /// Select and move the latest Entry in one immediate transaction.
    ///
    /// Keeping selection, optional title resolution, aggregate mutation, and
    /// correction audit creation in one transaction prevents the meaning of
    /// "latest" from changing between a read and the committed move.
    pub fn move_latest_entry(
        &mut self,
        request: &MoveLatestEntryRequest,
    ) -> Result<MoveEntryOutcome, StoreError> {
        self.run_transaction(|transaction| move_latest_entry(transaction, request))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct EntrySnapshot {
    entry_id: String,
    bucket_id: String,
    todo_ids: Vec<String>,
    evidence_ids: Vec<String>,
    timeline_event_ids: Vec<String>,
    decision_ids: Vec<String>,
}

fn move_latest_entry(
    transaction: &Transaction<'_>,
    request: &MoveLatestEntryRequest,
) -> Result<MoveEntryOutcome, StoreError> {
    let entry_id = transaction
        .query_row(
            "SELECT id FROM entries ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or(StoreError::NoEntryAvailableToCorrect)?;
    let target_bucket_id = match &request.target {
        LatestEntryTarget::BucketId(bucket_id) => bucket_id.clone(),
        LatestEntryTarget::BucketTitleContains(title) => {
            resolve_target_bucket_id(transaction, title)?
        }
    };
    let move_request = MoveEntryRequest {
        entry_id,
        target_bucket_id,
        command_text: request.command_text.clone(),
    };
    move_entry(transaction, &move_request)
}

fn resolve_target_bucket_id(
    transaction: &Transaction<'_>,
    target_title: &str,
) -> Result<String, StoreError> {
    let escaped_title = escape_like_contains(target_title);
    let mut statement = transaction.prepare(
        "SELECT id, title
         FROM buckets
         WHERE title LIKE '%' || ?1 || '%' ESCAPE '/'",
    )?;
    let matches = statement
        .query_map([escaped_title], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let exact_matches = matches
        .iter()
        .filter(|(_, title)| title == target_title)
        .collect::<Vec<_>>();
    if exact_matches.len() == 1 {
        return Ok(exact_matches[0].0.clone());
    }
    match matches.as_slice() {
        [(bucket_id, _)] => Ok(bucket_id.clone()),
        [] => Err(StoreError::NoMatchingCorrectionBucket {
            title: target_title.to_owned(),
        }),
        _ => Err(StoreError::AmbiguousCorrectionBucket {
            title: target_title.to_owned(),
        }),
    }
}

fn move_entry(
    transaction: &Transaction<'_>,
    request: &MoveEntryRequest,
) -> Result<MoveEntryOutcome, StoreError> {
    let source_bucket_id = transaction
        .query_row(
            "SELECT bucket_id FROM entries WHERE id = ?1",
            [&request.entry_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::MissingRecord {
            table: "entries",
            id: request.entry_id.clone(),
        })?;

    if !record_exists(transaction, "buckets", &request.target_bucket_id)? {
        return Err(StoreError::MissingRecord {
            table: "buckets",
            id: request.target_bucket_id.clone(),
        });
    }
    if source_bucket_id == request.target_bucket_id {
        return Err(StoreError::InvalidCorrectionWrite {
            action: MOVE_ENTRY_ACTION,
            reason: "entry already belongs to the target bucket",
        });
    }

    let before = load_entry_snapshot(transaction, &request.entry_id, &source_bucket_id)?;
    let activity_timestamp = current_timestamp(transaction)?;

    transaction.execute(
        "UPDATE entries
         SET bucket_id = ?2, moved_from_bucket_id = ?3
         WHERE id = ?1",
        params![request.entry_id, request.target_bucket_id, source_bucket_id],
    )?;
    for table in ["todos", "evidences", "timeline_events", "decisions"] {
        update_child_bucket(
            transaction,
            table,
            &request.entry_id,
            &request.target_bucket_id,
        )?;
    }
    transaction.execute(
        "UPDATE buckets
         SET updated_at = ?3, last_active_at = ?3
         WHERE id = ?1 OR id = ?2",
        params![
            source_bucket_id,
            request.target_bucket_id,
            activity_timestamp
        ],
    )?;

    let after = EntrySnapshot {
        bucket_id: request.target_bucket_id.clone(),
        ..before.clone()
    };
    let before_json = serialize_json(&before, "corrections.before_json")?;
    let after_json = serialize_json(&after, "corrections.after_json")?;
    let correction_id = new_uuid_v4();
    let correction_timestamp = current_timestamp(transaction)?;
    transaction.execute(
        "INSERT INTO corrections (
            id, command_text, action, target_type, target_id,
            before_json, after_json, created_at
         ) VALUES (?1, ?2, 'move_entry', 'entry', ?3, ?4, ?5, ?6)",
        params![
            correction_id,
            request.command_text,
            request.entry_id,
            before_json,
            after_json,
            correction_timestamp,
        ],
    )?;

    let corrected_classification_record_ids =
        linked_classification_record_ids(transaction, &request.entry_id)?;
    transaction.execute(
        "UPDATE classification_records SET corrected = 1 WHERE entry_id = ?1",
        [&request.entry_id],
    )?;

    rebuild_bucket_summary(
        transaction,
        &source_bucket_id,
        DEFAULT_REBUILD_ENTRY_LIMIT,
        SUMMARY_CHARACTER_LIMIT,
    )?;
    rebuild_bucket_summary(
        transaction,
        &request.target_bucket_id,
        DEFAULT_REBUILD_ENTRY_LIMIT,
        SUMMARY_CHARACTER_LIMIT,
    )?;

    Ok(MoveEntryOutcome {
        correction_id,
        entry_id: request.entry_id.clone(),
        source_bucket_id,
        target_bucket_id: request.target_bucket_id.clone(),
        todo_ids: before.todo_ids,
        evidence_ids: before.evidence_ids,
        timeline_event_ids: before.timeline_event_ids,
        decision_ids: before.decision_ids,
        corrected_classification_record_ids,
    })
}

fn record_exists(
    transaction: &Transaction<'_>,
    table: &'static str,
    id: &str,
) -> Result<bool, StoreError> {
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?1");
    Ok(transaction
        .query_row(&sql, [id], |_| Ok(()))
        .optional()?
        .is_some())
}

fn load_entry_snapshot(
    transaction: &Transaction<'_>,
    entry_id: &str,
    bucket_id: &str,
) -> Result<EntrySnapshot, StoreError> {
    Ok(EntrySnapshot {
        entry_id: entry_id.to_owned(),
        bucket_id: bucket_id.to_owned(),
        todo_ids: linked_record_ids(transaction, "todos", entry_id)?,
        evidence_ids: linked_record_ids(transaction, "evidences", entry_id)?,
        timeline_event_ids: linked_record_ids(transaction, "timeline_events", entry_id)?,
        decision_ids: linked_record_ids(transaction, "decisions", entry_id)?,
    })
}

fn linked_record_ids(
    transaction: &Transaction<'_>,
    table: &'static str,
    entry_id: &str,
) -> Result<Vec<String>, StoreError> {
    let sql = format!("SELECT id FROM {table} WHERE entry_id = ?1 ORDER BY created_at ASC, id ASC");
    let mut statement = transaction.prepare(&sql)?;
    let rows = statement.query_map([entry_id], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::from)
}

fn linked_classification_record_ids(
    transaction: &Transaction<'_>,
    entry_id: &str,
) -> Result<Vec<String>, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT id FROM classification_records
         WHERE entry_id = ?1
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = statement.query_map([entry_id], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::from)
}

fn update_child_bucket(
    transaction: &Transaction<'_>,
    table: &'static str,
    entry_id: &str,
    target_bucket_id: &str,
) -> Result<(), StoreError> {
    let sql = format!("UPDATE {table} SET bucket_id = ?2 WHERE entry_id = ?1");
    transaction.execute(&sql, params![entry_id, target_bucket_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MoveEntryRequest, MoveLatestEntryRequest};
    use crate::StoreError;
    use crate::bucket_summary_write::truncate_summary;

    #[test]
    fn request_trims_command_and_rejects_empty_commands() {
        let request = MoveEntryRequest::new("entry", "target", "  move it  ").unwrap();
        assert_eq!(request.entry_id(), "entry");
        assert_eq!(request.target_bucket_id(), "target");
        assert_eq!(request.command_text(), "move it");

        assert!(matches!(
            MoveEntryRequest::new("entry", "target", " \t\n "),
            Err(StoreError::InvalidWriteField {
                field: "command_text",
                ..
            })
        ));
    }

    #[test]
    fn latest_request_preserves_explicit_ids_and_normalizes_title_targets() {
        let explicit =
            MoveLatestEntryRequest::for_bucket_id(" bucket ", "  move latest  ").unwrap();
        assert_eq!(explicit.command_text(), "move latest");
        assert_eq!(explicit.target_bucket_id(), Some(" bucket "));
        assert_eq!(explicit.target_title(), None);

        let by_title = MoveLatestEntryRequest::for_bucket_title_contains(
            "  Review Bucket  ",
            "  move latest  ",
        )
        .unwrap();
        assert_eq!(by_title.command_text(), "move latest");
        assert_eq!(by_title.target_bucket_id(), None);
        assert_eq!(by_title.target_title(), Some("Review Bucket"));

        assert!(matches!(
            MoveLatestEntryRequest::for_bucket_title_contains(" \n\t ", "move latest"),
            Err(StoreError::InvalidWriteField {
                field: "target_title",
                ..
            })
        ));
    }

    #[test]
    fn summary_truncation_counts_unicode_characters() {
        let summary = format!("{}   trailing", "界".repeat(1_195));
        let truncated = truncate_summary(summary, 1_200);
        assert_eq!(truncated.chars().count(), 1_200);
        assert!(truncated.ends_with('…'));
    }
}
