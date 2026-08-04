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

impl WritableSqliteStore {
    /// Delete one Bucket aggregate through the Python-managed foreign-key rules.
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
