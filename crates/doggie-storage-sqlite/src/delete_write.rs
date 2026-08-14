use rusqlite::{OptionalExtension, Transaction, params};

use crate::archive_write::current_timestamp;
use crate::{StoreError, WritableSqliteStore};

/// A request to delete one exact Bucket identifier and its database-owned aggregate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteBucketRequest {
    bucket_id: String,
}

impl DeleteBucketRequest {
    pub fn new(bucket_id: impl Into<String>) -> Self {
        Self {
            bucket_id: bucket_id.into(),
        }
    }

    pub fn bucket_id(&self) -> &str {
        &self.bucket_id
    }
}

/// Rows affected by one committed Bucket deletion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteBucketOutcome {
    bucket_id: String,
    entry_ids: Vec<String>,
    todo_ids: Vec<String>,
    evidence_ids: Vec<String>,
    timeline_event_ids: Vec<String>,
    decision_ids: Vec<String>,
    cleared_classification_entry_ids: Vec<String>,
}

impl DeleteBucketOutcome {
    pub fn bucket_id(&self) -> &str {
        &self.bucket_id
    }

    pub fn entry_ids(&self) -> &[String] {
        &self.entry_ids
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

    pub fn cleared_classification_entry_ids(&self) -> &[String] {
        &self.cleared_classification_entry_ids
    }
}

/// A request to delete one exact Entry identifier while preserving linked records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteEntryRequest {
    entry_id: String,
}

impl DeleteEntryRequest {
    pub fn new(entry_id: impl Into<String>) -> Self {
        Self {
            entry_id: entry_id.into(),
        }
    }

    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }
}

/// Rows whose Entry links were cleared by one committed Entry deletion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteEntryOutcome {
    entry_id: String,
    bucket_id: String,
    cleared_todo_ids: Vec<String>,
    cleared_evidence_ids: Vec<String>,
    cleared_timeline_event_ids: Vec<String>,
    cleared_decision_ids: Vec<String>,
    cleared_classification_entry_ids: Vec<String>,
}

impl DeleteEntryOutcome {
    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }

    pub fn bucket_id(&self) -> &str {
        &self.bucket_id
    }

    pub fn cleared_todo_ids(&self) -> &[String] {
        &self.cleared_todo_ids
    }

    pub fn cleared_evidence_ids(&self) -> &[String] {
        &self.cleared_evidence_ids
    }

    pub fn cleared_timeline_event_ids(&self) -> &[String] {
        &self.cleared_timeline_event_ids
    }

    pub fn cleared_decision_ids(&self) -> &[String] {
        &self.cleared_decision_ids
    }

    pub fn cleared_classification_entry_ids(&self) -> &[String] {
        &self.cleared_classification_entry_ids
    }
}

impl WritableSqliteStore {
    /// Delete one Bucket aggregate through the legacy-managed foreign-key rules.
    ///
    /// Entries and Bucket-owned extracted rows cascade away, while linked
    /// ClassificationRecord `entry_id` values are set to null. Cross-Bucket
    /// extracted rows survive with null Entry links, and surviving Todos also
    /// receive SQLAlchemy-compatible `updated_at` changes. Audit text and
    /// non-foreign-key Bucket references remain untouched.
    pub fn delete_bucket(
        &mut self,
        request: &DeleteBucketRequest,
    ) -> Result<DeleteBucketOutcome, StoreError> {
        self.run_transaction(|transaction| delete_bucket(transaction, request))
    }

    /// Delete one Entry while retaining every linked structured and audit row.
    ///
    /// Entry foreign keys are cleared on linked records, surviving Todos receive
    /// SQLAlchemy-compatible `updated_at` changes, and the owning Bucket cache is
    /// intentionally left unchanged to match direct SQLAlchemy model deletion.
    pub fn delete_entry(
        &mut self,
        request: &DeleteEntryRequest,
    ) -> Result<DeleteEntryOutcome, StoreError> {
        self.run_transaction(|transaction| delete_entry(transaction, request))
    }
}

fn delete_bucket(
    transaction: &Transaction<'_>,
    request: &DeleteBucketRequest,
) -> Result<DeleteBucketOutcome, StoreError> {
    let bucket_id = transaction
        .query_row(
            "SELECT id FROM buckets WHERE id = ?1",
            [&request.bucket_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::MissingRecord {
            table: "buckets",
            id: request.bucket_id.clone(),
        })?;

    let entry_ids = ids_by_bucket(transaction, "entries", &bucket_id)?;
    let todo_ids = ids_by_bucket(transaction, "todos", &bucket_id)?;
    let evidence_ids = ids_by_bucket(transaction, "evidences", &bucket_id)?;
    let timeline_event_ids = ids_by_bucket(transaction, "timeline_events", &bucket_id)?;
    let decision_ids = ids_by_bucket(transaction, "decisions", &bucket_id)?;
    let cleared_classification_entry_ids = transaction
        .prepare(
            "SELECT classification_records.id
             FROM classification_records
             JOIN entries ON entries.id = classification_records.entry_id
             WHERE entries.bucket_id = ?1
             ORDER BY classification_records.id ASC",
        )?
        .query_map([&bucket_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let timestamp = current_timestamp(transaction)?;
    transaction.execute(
        "UPDATE todos
         SET entry_id = NULL, updated_at = ?1
         WHERE bucket_id <> ?2
           AND entry_id IN (
               SELECT id
               FROM entries
               WHERE bucket_id = ?2
           )",
        params![timestamp, bucket_id],
    )?;

    let deleted = transaction.execute("DELETE FROM buckets WHERE id = ?1", params![bucket_id])?;
    if deleted != 1 {
        return Err(StoreError::MissingRecord {
            table: "buckets",
            id: request.bucket_id.clone(),
        });
    }

    Ok(DeleteBucketOutcome {
        bucket_id,
        entry_ids,
        todo_ids,
        evidence_ids,
        timeline_event_ids,
        decision_ids,
        cleared_classification_entry_ids,
    })
}

fn delete_entry(
    transaction: &Transaction<'_>,
    request: &DeleteEntryRequest,
) -> Result<DeleteEntryOutcome, StoreError> {
    let (entry_id, bucket_id) = transaction
        .query_row(
            "SELECT id, bucket_id FROM entries WHERE id = ?1",
            [&request.entry_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::MissingRecord {
            table: "entries",
            id: request.entry_id.clone(),
        })?;

    let cleared_todo_ids = ids_by_entry(transaction, "todos", &entry_id)?;
    let cleared_evidence_ids = ids_by_entry(transaction, "evidences", &entry_id)?;
    let cleared_timeline_event_ids = ids_by_entry(transaction, "timeline_events", &entry_id)?;
    let cleared_decision_ids = ids_by_entry(transaction, "decisions", &entry_id)?;
    let cleared_classification_entry_ids =
        ids_by_entry(transaction, "classification_records", &entry_id)?;

    let timestamp = current_timestamp(transaction)?;
    transaction.execute(
        "UPDATE todos
         SET entry_id = NULL, updated_at = ?1
         WHERE entry_id = ?2",
        params![timestamp, entry_id],
    )?;
    for table in ["evidences", "timeline_events", "decisions"] {
        let sql = format!("UPDATE {table} SET entry_id = NULL WHERE entry_id = ?1");
        transaction.execute(&sql, [&entry_id])?;
    }

    let deleted = transaction.execute("DELETE FROM entries WHERE id = ?1", [&entry_id])?;
    if deleted != 1 {
        return Err(StoreError::MissingRecord {
            table: "entries",
            id: request.entry_id.clone(),
        });
    }

    Ok(DeleteEntryOutcome {
        entry_id,
        bucket_id,
        cleared_todo_ids,
        cleared_evidence_ids,
        cleared_timeline_event_ids,
        cleared_decision_ids,
        cleared_classification_entry_ids,
    })
}

fn ids_by_entry(
    transaction: &Transaction<'_>,
    table: &'static str,
    entry_id: &str,
) -> Result<Vec<String>, StoreError> {
    let sql = format!("SELECT id FROM {table} WHERE entry_id = ?1 ORDER BY id ASC");
    Ok(transaction
        .prepare(&sql)?
        .query_map([entry_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn ids_by_bucket(
    transaction: &Transaction<'_>,
    table: &'static str,
    bucket_id: &str,
) -> Result<Vec<String>, StoreError> {
    let sql = format!("SELECT id FROM {table} WHERE bucket_id = ?1 ORDER BY id ASC");
    Ok(transaction
        .prepare(&sql)?
        .query_map([bucket_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?)
}
