use std::path::Path;

use rusqlite::{Connection, DatabaseName, OpenFlags, Row, Rows, params};

use crate::records::{
    decode_bucket, decode_chat_message, decode_classification_record, decode_correction,
    decode_decision, decode_entry, decode_evidence, decode_timeline_event, decode_todo,
};
use crate::{
    StoreError, StoredBucket, StoredChatMessage, StoredClassificationRecord, StoredCorrection,
    StoredDecision, StoredEntry, StoredEvidence, StoredTimelineEvent, StoredTodo, migration,
    schema,
};

/// Read-only SQLite repository for the Python-managed business schema.
pub struct SqliteStore {
    connection: Connection,
}

impl SqliteStore {
    /// Open an existing database without create or write permissions.
    ///
    /// The constructor validates all nine business tables and every column used
    /// by the strongly typed read API before returning a usable store.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.execute_batch("PRAGMA query_only = ON;")?;

        schema::validate_repository_schema(&connection)?;
        migration::ensure_supported_history_if_present(&connection)?;

        Ok(Self { connection })
    }

    /// Report whether the connection has SQLite query-only protection enabled.
    pub fn is_read_only(&self) -> Result<bool, StoreError> {
        let opened_read_only = self.connection.is_readonly(DatabaseName::Main)?;
        let query_only = self
            .connection
            .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))?;
        Ok(opened_read_only && query_only == 1)
    }

    /// Return active Buckets using the same ordering and limit rules as Python.
    pub fn list_active_buckets(&self, limit: usize) -> Result<Vec<StoredBucket>, StoreError> {
        let sql_limit = checked_limit(limit)?;
        let mut statement = self.connection.prepare(
            "SELECT id, title, type, status, summary, tags, created_at, updated_at, last_active_at
             FROM buckets
             WHERE status = 'active'
             ORDER BY last_active_at DESC, updated_at DESC
             LIMIT ?1",
        )?;
        let mut rows = statement.query([sql_limit])?;
        collect_rows(&mut rows, decode_bucket)
    }

    /// Return the bounded Bucket candidate set used by Python keyword search.
    ///
    /// The caller owns query trimming and final relevance ranking. This method
    /// preserves SQLAlchemy's literal `contains(..., autoescape=True)` behavior
    /// across Bucket title, summary, serialized JSON tags, and Entry raw text.
    pub fn search_bucket_candidates(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<StoredBucket>, StoreError> {
        let sql_limit = checked_limit(limit)?;
        let escaped_query = escape_like_contains(query);
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT
                    buckets.id, buckets.title, buckets.type, buckets.status,
                    buckets.summary, buckets.tags, buckets.created_at,
                    buckets.updated_at, buckets.last_active_at
             FROM buckets
             LEFT OUTER JOIN entries ON entries.bucket_id = buckets.id
             WHERE buckets.title LIKE '%' || ?1 || '%' ESCAPE '/'
                OR buckets.summary LIKE '%' || ?1 || '%' ESCAPE '/'
                OR CAST(buckets.tags AS TEXT) LIKE '%' || ?1 || '%' ESCAPE '/'
                OR entries.raw_text LIKE '%' || ?1 || '%' ESCAPE '/'
             LIMIT ?2 OFFSET 0",
        )?;
        let mut rows = statement.query(params![escaped_query, sql_limit])?;
        collect_rows(&mut rows, decode_bucket)
    }

    /// Return one Bucket by primary key, or `None` when it does not exist.
    pub fn get_bucket(&self, bucket_id: &str) -> Result<Option<StoredBucket>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, type, status, summary, tags, created_at, updated_at, last_active_at
             FROM buckets
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([bucket_id])?;
        decode_optional(&mut rows, decode_bucket)
    }

    /// Return a Bucket's immutable Entries in the Python relationship order.
    pub fn list_bucket_entries(&self, bucket_id: &str) -> Result<Vec<StoredEntry>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, raw_text, summary, content_type,
                    classification_confidence, classification_reason, created_at,
                    moved_from_bucket_id
             FROM entries
             WHERE bucket_id = ?1
             ORDER BY created_at ASC",
        )?;
        let mut rows = statement.query([bucket_id])?;
        collect_rows(&mut rows, decode_entry)
    }

    /// Return one Todo by primary key.
    pub fn get_todo(&self, todo_id: &str) -> Result<Option<StoredTodo>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
             FROM todos
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([todo_id])?;
        decode_optional(&mut rows, decode_todo)
    }

    /// Return a Bucket's Todos in the Python relationship order.
    pub fn list_bucket_todos(&self, bucket_id: &str) -> Result<Vec<StoredTodo>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
             FROM todos
             WHERE bucket_id = ?1
             ORDER BY created_at ASC",
        )?;
        let mut rows = statement.query([bucket_id])?;
        collect_rows(&mut rows, decode_todo)
    }

    /// Return one Evidence row by primary key.
    pub fn get_evidence(&self, evidence_id: &str) -> Result<Option<StoredEvidence>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, text, source, created_at
             FROM evidences
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([evidence_id])?;
        decode_optional(&mut rows, decode_evidence)
    }

    /// Return a Bucket's Evidence rows in the Python relationship order.
    pub fn list_bucket_evidences(
        &self,
        bucket_id: &str,
    ) -> Result<Vec<StoredEvidence>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, text, source, created_at
             FROM evidences
             WHERE bucket_id = ?1
             ORDER BY created_at ASC",
        )?;
        let mut rows = statement.query([bucket_id])?;
        collect_rows(&mut rows, decode_evidence)
    }

    /// Return one TimelineEvent row by primary key.
    pub fn get_timeline_event(
        &self,
        event_id: &str,
    ) -> Result<Option<StoredTimelineEvent>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, event_time, text, created_at
             FROM timeline_events
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([event_id])?;
        decode_optional(&mut rows, decode_timeline_event)
    }

    /// Return a Bucket's TimelineEvent rows in the Python relationship order.
    pub fn list_bucket_timeline_events(
        &self,
        bucket_id: &str,
    ) -> Result<Vec<StoredTimelineEvent>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, event_time, text, created_at
             FROM timeline_events
             WHERE bucket_id = ?1
             ORDER BY created_at ASC",
        )?;
        let mut rows = statement.query([bucket_id])?;
        collect_rows(&mut rows, decode_timeline_event)
    }

    /// Return one Decision row by primary key.
    pub fn get_decision(&self, decision_id: &str) -> Result<Option<StoredDecision>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, text, reason, created_at
             FROM decisions
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([decision_id])?;
        decode_optional(&mut rows, decode_decision)
    }

    /// Return a Bucket's Decision rows in the Python relationship order.
    pub fn list_bucket_decisions(
        &self,
        bucket_id: &str,
    ) -> Result<Vec<StoredDecision>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, text, reason, created_at
             FROM decisions
             WHERE bucket_id = ?1
             ORDER BY created_at ASC",
        )?;
        let mut rows = statement.query([bucket_id])?;
        collect_rows(&mut rows, decode_decision)
    }

    /// Return one ClassificationRecord audit row by primary key.
    pub fn get_classification_record(
        &self,
        record_id: &str,
    ) -> Result<Option<StoredClassificationRecord>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, raw_text, action, bucket_id, entry_id, confidence, reason,
                    candidate_bucket_ids, current_focus_bucket_id, prompt_version,
                    model_name, corrected, created_at
             FROM classification_records
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([record_id])?;
        decode_optional(&mut rows, decode_classification_record)
    }

    /// Return all classification audits associated with an Entry in audit order.
    pub fn list_entry_classification_records(
        &self,
        entry_id: &str,
    ) -> Result<Vec<StoredClassificationRecord>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, raw_text, action, bucket_id, entry_id, confidence, reason,
                    candidate_bucket_ids, current_focus_bucket_id, prompt_version,
                    model_name, corrected, created_at
             FROM classification_records
             WHERE entry_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let mut rows = statement.query([entry_id])?;
        collect_rows(&mut rows, decode_classification_record)
    }

    /// Return one Correction audit row by primary key.
    pub fn get_correction(
        &self,
        correction_id: &str,
    ) -> Result<Option<StoredCorrection>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, command_text, action, target_type, target_id,
                    before_json, after_json, created_at
             FROM corrections
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([correction_id])?;
        decode_optional(&mut rows, decode_correction)
    }

    /// Return Correction audit rows for one typed target in chronological order.
    pub fn list_target_corrections(
        &self,
        target_type: &str,
        target_id: &str,
    ) -> Result<Vec<StoredCorrection>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, command_text, action, target_type, target_id,
                    before_json, after_json, created_at
             FROM corrections
             WHERE target_type = ?1 AND target_id = ?2
             ORDER BY created_at ASC, id ASC",
        )?;
        let mut rows = statement.query([target_type, target_id])?;
        collect_rows(&mut rows, decode_correction)
    }

    /// Return one ChatMessage row by primary key.
    pub fn get_chat_message(
        &self,
        message_id: &str,
    ) -> Result<Option<StoredChatMessage>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, role, content, tool_name, tool_call_id, details_json, created_at
             FROM chat_messages
             WHERE id = ?1",
        )?;
        let mut rows = statement.query([message_id])?;
        decode_optional(&mut rows, decode_chat_message)
    }

    /// Return the newest bounded chat window in chronological display order.
    ///
    /// This is equivalent to Python's descending query followed by reversing the
    /// bounded result, including its `created_at DESC, id DESC` tie-break rule.
    pub fn list_chat_messages(&self, limit: usize) -> Result<Vec<StoredChatMessage>, StoreError> {
        let sql_limit = checked_limit(limit)?;
        let mut statement = self.connection.prepare(
            "SELECT id, role, content, tool_name, tool_call_id, details_json, created_at
             FROM (
                 SELECT id, role, content, tool_name, tool_call_id, details_json, created_at
                 FROM chat_messages
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?1
             ) AS recent_messages
             ORDER BY created_at ASC, id ASC",
        )?;
        let mut rows = statement.query([sql_limit])?;
        collect_rows(&mut rows, decode_chat_message)
    }
}

fn escape_like_contains(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '/' | '%' | '_') {
            escaped.push('/');
        }
        escaped.push(character);
    }
    escaped
}

fn checked_limit(limit: usize) -> Result<i64, StoreError> {
    if limit < 1 {
        return Err(StoreError::InvalidLimit(limit));
    }
    i64::try_from(limit).map_err(|_| StoreError::InvalidLimit(limit))
}

fn collect_rows<T>(
    rows: &mut Rows<'_>,
    decode: fn(&Row<'_>) -> Result<T, StoreError>,
) -> Result<Vec<T>, StoreError> {
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        records.push(decode(row)?);
    }
    Ok(records)
}

fn decode_optional<T>(
    rows: &mut Rows<'_>,
    decode: fn(&Row<'_>) -> Result<T, StoreError>,
) -> Result<Option<T>, StoreError> {
    rows.next()?.map(decode).transpose()
}
