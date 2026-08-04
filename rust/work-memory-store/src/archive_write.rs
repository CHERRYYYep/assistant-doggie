use std::collections::HashSet;
use std::fmt::Write as _;

use rusqlite::{Transaction, params};
use unicode_casefold::UnicodeCaseFold;
use work_memory_core::{
    ArchiveStatus, BucketType, ClassificationAction, ClassificationResult, ExtractionResult,
};

use crate::records::decode_bucket;
use crate::{StoreError, StoredBucket, WritableSqliteStore};

pub(crate) const DEFAULT_BUCKET_SUMMARY_LIMIT: usize = 1_200;
const DEFAULT_CONTENT_TYPE: &str = "note";
const EXTRACTED_EVIDENCE_SOURCE: &str = "llm-extracted";

/// Server-owned metadata attached to one persisted classification attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassificationAuditContext {
    candidate_bucket_ids: Vec<String>,
    current_focus_bucket_id: Option<String>,
    prompt_version: String,
    model_name: String,
}

impl ClassificationAuditContext {
    pub fn new(
        candidate_bucket_ids: Vec<String>,
        current_focus_bucket_id: Option<String>,
        prompt_version: impl Into<String>,
        model_name: impl Into<String>,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            candidate_bucket_ids: normalize_string_list(candidate_bucket_ids),
            current_focus_bucket_id: normalize_optional_text(current_focus_bucket_id),
            prompt_version: required_text(prompt_version.into(), "prompt_version")?,
            model_name: required_text(model_name.into(), "model_name")?,
        })
    }

    pub fn candidate_bucket_ids(&self) -> &[String] {
        &self.candidate_bucket_ids
    }

    pub fn current_focus_bucket_id(&self) -> Option<&str> {
        self.current_focus_bucket_id.as_deref()
    }

    pub fn prompt_version(&self) -> &str {
        &self.prompt_version
    }

    pub fn model_name(&self) -> &str {
        &self.model_name
    }
}

/// A validated classification attempt ready for one atomic SQLite write.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchiveWriteRequest {
    raw_text: String,
    classification: ClassificationResult,
    extraction: Option<ExtractionResult>,
    audit: ClassificationAuditContext,
}

impl ArchiveWriteRequest {
    /// Build an append/create request that must persist an Entry and extraction.
    pub fn archive(
        raw_text: impl Into<String>,
        classification: ClassificationResult,
        extraction: ExtractionResult,
        audit: ClassificationAuditContext,
    ) -> Result<Self, StoreError> {
        if classification.action() == ClassificationAction::AskUser {
            return Err(StoreError::InvalidArchiveWrite {
                action: classification.action().as_str(),
                reason: "ask_user must use the classification-only constructor",
            });
        }
        Ok(Self {
            raw_text: required_text(raw_text.into(), "raw_text")?,
            classification,
            extraction: Some(extraction),
            audit,
        })
    }

    /// Build an `ask_user` request that writes only classification audit data.
    pub fn needs_confirmation(
        raw_text: impl Into<String>,
        classification: ClassificationResult,
        audit: ClassificationAuditContext,
    ) -> Result<Self, StoreError> {
        if classification.action() != ClassificationAction::AskUser {
            return Err(StoreError::InvalidArchiveWrite {
                action: classification.action().as_str(),
                reason: "automatic actions require an extraction",
            });
        }
        Ok(Self {
            raw_text: required_text(raw_text.into(), "raw_text")?,
            classification,
            extraction: None,
            audit,
        })
    }

    pub fn raw_text(&self) -> &str {
        &self.raw_text
    }

    pub const fn classification(&self) -> &ClassificationResult {
        &self.classification
    }

    pub const fn extraction(&self) -> Option<&ExtractionResult> {
        self.extraction.as_ref()
    }

    pub const fn audit(&self) -> &ClassificationAuditContext {
        &self.audit
    }
}

/// IDs and status produced by one committed archive attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveWriteOutcome {
    status: ArchiveStatus,
    action: ClassificationAction,
    classification_record_id: String,
    bucket_id: Option<String>,
    entry_id: Option<String>,
    created_bucket: bool,
    todo_ids: Vec<String>,
    evidence_ids: Vec<String>,
    timeline_event_ids: Vec<String>,
    decision_ids: Vec<String>,
}

impl ArchiveWriteOutcome {
    pub const fn status(&self) -> ArchiveStatus {
        self.status
    }

    pub const fn action(&self) -> ClassificationAction {
        self.action
    }

    pub fn classification_record_id(&self) -> &str {
        &self.classification_record_id
    }

    pub fn bucket_id(&self) -> Option<&str> {
        self.bucket_id.as_deref()
    }

    pub fn entry_id(&self) -> Option<&str> {
        self.entry_id.as_deref()
    }

    pub const fn created_bucket(&self) -> bool {
        self.created_bucket
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
}

impl WritableSqliteStore {
    /// Persist one validated classification attempt as a single transaction.
    ///
    /// `ask_user` writes only `classification_records`. Append/create actions
    /// atomically write the audit row, Bucket/Entry state, extracted child rows,
    /// merged tags, and rolling summary.
    pub fn persist_archive_attempt(
        &mut self,
        request: &ArchiveWriteRequest,
    ) -> Result<ArchiveWriteOutcome, StoreError> {
        self.run_transaction(|transaction| persist_archive_attempt(transaction, request))
    }
}

fn persist_archive_attempt(
    transaction: &Transaction<'_>,
    request: &ArchiveWriteRequest,
) -> Result<ArchiveWriteOutcome, StoreError> {
    let action = request.classification.action();
    let timestamp = current_timestamp(transaction)?;
    let classification_record_id = new_uuid_v4(transaction)?;
    let candidate_bucket_ids = merged_candidate_bucket_ids(request);

    if action == ClassificationAction::AskUser {
        insert_classification_record(
            transaction,
            &classification_record_id,
            request,
            &candidate_bucket_ids,
            None,
            None,
            &timestamp,
        )?;
        return Ok(ArchiveWriteOutcome {
            status: ArchiveStatus::NeedsConfirmation,
            action,
            classification_record_id,
            bucket_id: None,
            entry_id: None,
            created_bucket: false,
            todo_ids: Vec::new(),
            evidence_ids: Vec::new(),
            timeline_event_ids: Vec::new(),
            decision_ids: Vec::new(),
        });
    }

    let extraction = request
        .extraction
        .as_ref()
        .ok_or(StoreError::InvalidArchiveWrite {
            action: action.as_str(),
            reason: "automatic action is missing an extraction",
        })?;
    let (bucket, created_bucket) = match action {
        ClassificationAction::AppendExisting => {
            let bucket_id =
                request
                    .classification
                    .bucket_id()
                    .ok_or(StoreError::InvalidArchiveWrite {
                        action: action.as_str(),
                        reason: "append_existing is missing bucket_id",
                    })?;
            let bucket =
                get_bucket(transaction, bucket_id)?.ok_or_else(|| StoreError::MissingRecord {
                    table: "buckets",
                    id: bucket_id.to_owned(),
                })?;
            (bucket, false)
        }
        ClassificationAction::CreateNew => {
            let bucket = insert_bucket(transaction, request, extraction, &timestamp)?;
            (bucket, true)
        }
        ClassificationAction::AskUser => unreachable!("handled before extraction lookup"),
    };

    let entry_id = insert_entry(transaction, &bucket.id, request, extraction, &timestamp)?;
    let children =
        insert_extracted_children(transaction, &bucket.id, &entry_id, extraction, &timestamp)?;
    update_bucket_cache(
        transaction,
        &bucket,
        extraction,
        &timestamp,
        DEFAULT_BUCKET_SUMMARY_LIMIT,
    )?;
    insert_classification_record(
        transaction,
        &classification_record_id,
        request,
        &candidate_bucket_ids,
        Some(&bucket.id),
        Some(&entry_id),
        &timestamp,
    )?;

    Ok(ArchiveWriteOutcome {
        status: ArchiveStatus::Archived,
        action,
        classification_record_id,
        bucket_id: Some(bucket.id),
        entry_id: Some(entry_id),
        created_bucket,
        todo_ids: children.todo_ids,
        evidence_ids: children.evidence_ids,
        timeline_event_ids: children.timeline_event_ids,
        decision_ids: children.decision_ids,
    })
}

fn insert_bucket(
    transaction: &Transaction<'_>,
    request: &ArchiveWriteRequest,
    extraction: &ExtractionResult,
    timestamp: &str,
) -> Result<StoredBucket, StoreError> {
    let id = new_uuid_v4(transaction)?;
    let title = request
        .classification
        .title()
        .unwrap_or_else(|| extraction.summary());
    let bucket_type = request
        .classification
        .bucket_type()
        .unwrap_or(BucketType::Knowledge);
    let tags_json = serialize_json(extraction.tags(), "buckets.tags")?;

    transaction.execute(
        "INSERT INTO buckets (
            id, title, type, status, summary, tags,
            created_at, updated_at, last_active_at
         ) VALUES (?1, ?2, ?3, 'active', '', ?4, ?5, ?5, ?5)",
        params![id, title, bucket_type.as_str(), tags_json, timestamp],
    )?;

    get_bucket(transaction, &id)?.ok_or_else(|| StoreError::MissingRecord {
        table: "buckets",
        id,
    })
}

fn insert_entry(
    transaction: &Transaction<'_>,
    bucket_id: &str,
    request: &ArchiveWriteRequest,
    extraction: &ExtractionResult,
    timestamp: &str,
) -> Result<String, StoreError> {
    let entry_id = new_uuid_v4(transaction)?;
    transaction.execute(
        "INSERT INTO entries (
            id, bucket_id, raw_text, summary, content_type,
            classification_confidence, classification_reason,
            created_at, moved_from_bucket_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
        params![
            entry_id,
            bucket_id,
            request.raw_text,
            extraction.summary(),
            DEFAULT_CONTENT_TYPE,
            request.classification.confidence(),
            request.classification.reason(),
            timestamp,
        ],
    )?;
    transaction.execute(
        "UPDATE buckets
         SET updated_at = ?2, last_active_at = ?2
         WHERE id = ?1",
        params![bucket_id, timestamp],
    )?;
    Ok(entry_id)
}

#[derive(Debug)]
struct InsertedChildren {
    todo_ids: Vec<String>,
    evidence_ids: Vec<String>,
    timeline_event_ids: Vec<String>,
    decision_ids: Vec<String>,
}

fn insert_extracted_children(
    transaction: &Transaction<'_>,
    bucket_id: &str,
    entry_id: &str,
    extraction: &ExtractionResult,
    timestamp: &str,
) -> Result<InsertedChildren, StoreError> {
    let existing_todos = existing_text_keys(transaction, "todos", bucket_id)?;
    let existing_evidences = existing_text_keys(transaction, "evidences", bucket_id)?;
    let existing_decisions = existing_text_keys(transaction, "decisions", bucket_id)?;
    let existing_timeline = existing_timeline_keys(transaction, bucket_id)?;

    let mut todo_ids = Vec::new();
    for text in extraction.todos() {
        if existing_todos.contains(&normalized_key(text)) {
            continue;
        }
        let id = new_uuid_v4(transaction)?;
        transaction.execute(
            "INSERT INTO todos (
                id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'open', NULL, ?5, ?5)",
            params![id, bucket_id, entry_id, text, timestamp],
        )?;
        todo_ids.push(id);
    }

    let mut evidence_ids = Vec::new();
    for text in extraction.evidences() {
        if existing_evidences.contains(&normalized_key(text)) {
            continue;
        }
        let id = new_uuid_v4(transaction)?;
        transaction.execute(
            "INSERT INTO evidences (id, bucket_id, entry_id, text, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                bucket_id,
                entry_id,
                text,
                EXTRACTED_EVIDENCE_SOURCE,
                timestamp
            ],
        )?;
        evidence_ids.push(id);
    }

    let mut timeline_event_ids = Vec::new();
    for event in extraction.timeline_events() {
        let key = (
            event.event_time().map(str::to_owned),
            normalized_key(event.text()),
        );
        if existing_timeline.contains(&key) {
            continue;
        }
        let id = new_uuid_v4(transaction)?;
        transaction.execute(
            "INSERT INTO timeline_events (
                id, bucket_id, entry_id, event_time, text, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                bucket_id,
                entry_id,
                event.event_time(),
                event.text(),
                timestamp
            ],
        )?;
        timeline_event_ids.push(id);
    }

    let mut decision_ids = Vec::new();
    for text in extraction.decisions() {
        if existing_decisions.contains(&normalized_key(text)) {
            continue;
        }
        let id = new_uuid_v4(transaction)?;
        transaction.execute(
            "INSERT INTO decisions (id, bucket_id, entry_id, text, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            params![id, bucket_id, entry_id, text, timestamp],
        )?;
        decision_ids.push(id);
    }

    Ok(InsertedChildren {
        todo_ids,
        evidence_ids,
        timeline_event_ids,
        decision_ids,
    })
}

fn update_bucket_cache(
    transaction: &Transaction<'_>,
    bucket: &StoredBucket,
    extraction: &ExtractionResult,
    timestamp: &str,
    max_chars: usize,
) -> Result<(), StoreError> {
    let summary = merge_bucket_summary(&bucket.summary, extraction.summary(), max_chars);
    let tags = merge_tags(&bucket.tags, extraction.tags());
    let tags_json = serialize_json(&tags, "buckets.tags")?;
    transaction.execute(
        "UPDATE buckets
         SET summary = ?2, tags = ?3, updated_at = ?4
         WHERE id = ?1",
        params![bucket.id, summary, tags_json, timestamp],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_classification_record(
    transaction: &Transaction<'_>,
    id: &str,
    request: &ArchiveWriteRequest,
    candidate_bucket_ids: &[String],
    bucket_id: Option<&str>,
    entry_id: Option<&str>,
    timestamp: &str,
) -> Result<(), StoreError> {
    let candidates_json = serialize_json(
        candidate_bucket_ids,
        "classification_records.candidate_bucket_ids",
    )?;
    transaction.execute(
        "INSERT INTO classification_records (
            id, raw_text, action, bucket_id, entry_id, confidence, reason,
            candidate_bucket_ids, current_focus_bucket_id, prompt_version,
            model_name, corrected, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)",
        params![
            id,
            request.raw_text,
            request.classification.action().as_str(),
            bucket_id,
            entry_id,
            request.classification.confidence(),
            request.classification.reason(),
            candidates_json,
            request.audit.current_focus_bucket_id(),
            request.audit.prompt_version(),
            request.audit.model_name(),
            timestamp,
        ],
    )?;
    Ok(())
}

fn get_bucket(
    transaction: &Transaction<'_>,
    bucket_id: &str,
) -> Result<Option<StoredBucket>, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT id, title, type, status, summary, tags, created_at, updated_at, last_active_at
         FROM buckets
         WHERE id = ?1",
    )?;
    let mut rows = statement.query([bucket_id])?;
    rows.next()?.map(decode_bucket).transpose()
}

fn existing_text_keys(
    transaction: &Transaction<'_>,
    table: &'static str,
    bucket_id: &str,
) -> Result<HashSet<String>, StoreError> {
    let sql = format!("SELECT text FROM {table} WHERE bucket_id = ?1");
    let mut statement = transaction.prepare(&sql)?;
    let rows = statement.query_map([bucket_id], |row| row.get::<_, String>(0))?;
    let mut keys = HashSet::new();
    for row in rows {
        keys.insert(normalized_key(&row?));
    }
    Ok(keys)
}

fn existing_timeline_keys(
    transaction: &Transaction<'_>,
    bucket_id: &str,
) -> Result<HashSet<(Option<String>, String)>, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT event_time, text
         FROM timeline_events
         WHERE bucket_id = ?1",
    )?;
    let rows = statement.query_map([bucket_id], |row| {
        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut keys = HashSet::new();
    for row in rows {
        let (event_time, text) = row?;
        keys.insert((event_time, normalized_key(&text)));
    }
    Ok(keys)
}

fn merged_candidate_bucket_ids(request: &ArchiveWriteRequest) -> Vec<String> {
    let mut seen = HashSet::new();
    request
        .audit
        .candidate_bucket_ids
        .iter()
        .chain(request.classification.candidate_bucket_ids())
        .filter_map(|value| {
            let cleaned = value.trim();
            (!cleaned.is_empty() && seen.insert(cleaned.to_owned())).then(|| cleaned.to_owned())
        })
        .collect()
}

fn merge_tags(existing: &[String], incoming: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    existing
        .iter()
        .chain(incoming)
        .filter_map(|tag| {
            let cleaned = tag.trim();
            let key = case_fold(cleaned);
            (!cleaned.is_empty() && seen.insert(key)).then(|| cleaned.to_owned())
        })
        .collect()
}

pub(crate) fn merge_bucket_summary(existing: &str, fragment: &str, max_chars: usize) -> String {
    let mut parts = existing
        .split('\n')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let existing_keys = parts
        .iter()
        .map(|part| normalized_key(part))
        .collect::<HashSet<_>>();
    if !existing_keys.contains(&normalized_key(fragment)) {
        parts.push(fragment.trim().to_owned());
    }

    while parts.join("\n").chars().count() > max_chars && parts.len() > 2 {
        parts.remove(1);
    }
    let summary = parts.join("\n");
    if summary.chars().count() <= max_chars {
        return summary;
    }

    let mut truncated = summary.chars().take(max_chars - 1).collect::<String>();
    truncated = truncated.trim_end().to_owned();
    truncated.push('…');
    truncated
}

fn normalized_key(value: &str) -> String {
    value
        .split_whitespace()
        .map(case_fold)
        .collect::<Vec<_>>()
        .join(" ")
}

fn case_fold(value: &str) -> String {
    value.case_fold().collect()
}

fn normalize_string_list(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| {
            let cleaned = value.trim();
            (!cleaned.is_empty() && seen.insert(cleaned.to_owned())).then(|| cleaned.to_owned())
        })
        .collect()
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let cleaned = item.trim();
        (!cleaned.is_empty()).then(|| cleaned.to_owned())
    })
}

pub(crate) fn required_text(value: String, field: &'static str) -> Result<String, StoreError> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        Err(StoreError::InvalidWriteField {
            field,
            reason: "must not be empty",
        })
    } else {
        Ok(cleaned.to_owned())
    }
}

pub(crate) fn serialize_json<T: serde::Serialize + ?Sized>(
    value: &T,
    context: &'static str,
) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|source| StoreError::JsonSerialization { context, source })
}

pub(crate) fn current_timestamp(transaction: &Transaction<'_>) -> Result<String, StoreError> {
    Ok(transaction.query_row(
        "SELECT strftime('%Y-%m-%d %H:%M:%f000', 'now')",
        [],
        |row| row.get(0),
    )?)
}

pub(crate) fn new_uuid_v4(transaction: &Transaction<'_>) -> Result<String, StoreError> {
    let mut bytes: Vec<u8> =
        transaction.query_row("SELECT randomblob(16)", [], |row| row.get(0))?;
    if bytes.len() != 16 {
        return Err(StoreError::InvalidGeneratedIdLength(bytes.len()));
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let mut id = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            id.push('-');
        }
        write!(&mut id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use work_memory_core::{BucketType, ClassificationResult, ExtractionResult};

    use super::{
        ArchiveWriteRequest, ClassificationAuditContext, case_fold, merge_bucket_summary,
        merge_tags, normalized_key,
    };
    use crate::StoreError;

    #[test]
    fn normalization_matches_python_casefold_and_whitespace_rules() {
        assert_eq!(normalized_key("  Straße\tSTATUS  "), "strasse status");
        assert_eq!(normalized_key("ΟΣ  ος"), "οσ οσ");
        assert_eq!(
            merge_tags(
                &["Payments".to_owned()],
                &["payments".to_owned(), "Rust".to_owned()]
            ),
            ["Payments", "Rust"]
        );
        assert_eq!(case_fold("ẞ"), "ss");
    }

    #[test]
    fn request_constructors_reject_action_and_extraction_mismatches() {
        let audit = ClassificationAuditContext::new(
            vec![" bucket-1 ".to_owned(), "bucket-1".to_owned()],
            Some(" bucket-1 ".to_owned()),
            " classification-v2 ",
            " fixture-model ",
        )
        .unwrap();
        assert_eq!(audit.candidate_bucket_ids(), ["bucket-1"]);
        assert_eq!(audit.current_focus_bucket_id(), Some("bucket-1"));
        assert_eq!(audit.prompt_version(), "classification-v2");
        assert_eq!(audit.model_name(), "fixture-model");

        let ask_user = ClassificationResult::ask_user(
            Some(BucketType::Incident),
            None,
            0.4,
            "The target is ambiguous.",
            "Which Bucket?",
            vec![],
        )
        .unwrap();
        assert!(matches!(
            ArchiveWriteRequest::archive(
                "Archive this.",
                ask_user,
                ExtractionResult::minimal("Summary.").unwrap(),
                audit.clone(),
            ),
            Err(StoreError::InvalidArchiveWrite {
                action: "ask_user",
                ..
            })
        ));

        let append = ClassificationResult::append_existing(
            "bucket-1",
            Some(BucketType::Incident),
            0.9,
            "The target is explicit.",
            vec![],
        )
        .unwrap();
        assert!(matches!(
            ArchiveWriteRequest::needs_confirmation("Archive this.", append, audit),
            Err(StoreError::InvalidArchiveWrite {
                action: "append_existing",
                ..
            })
        ));
    }

    #[test]
    fn rolling_summary_preserves_first_and_newest_fragments_with_a_bound() {
        let existing = format!("first\n{}\n{}", "a".repeat(60), "b".repeat(60));
        let merged = merge_bucket_summary(&existing, &"c".repeat(60), 130);
        assert!(merged.starts_with("first\n"));
        assert!(!merged.contains(&"a".repeat(60)));
        assert!(merged.contains(&"b".repeat(60)));
        assert!(merged.contains(&"c".repeat(60)));
        assert!(merged.chars().count() <= 130);
    }
}
