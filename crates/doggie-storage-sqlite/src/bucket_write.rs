use doggie_domain::BucketType;
use rusqlite::{Transaction, params};

use crate::archive_write::{current_timestamp, new_uuid_v4, required_text, serialize_json};
use crate::records::decode_bucket;
use crate::{StoreError, StoredBucket, WritableSqliteStore};

/// A validated request for the standalone legacy-compatible Bucket create path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateBucketRequest {
    title: String,
    bucket_type: BucketType,
    summary: String,
    tags: Vec<String>,
}

impl CreateBucketRequest {
    pub fn new(
        title: impl Into<String>,
        bucket_type: BucketType,
        summary: impl Into<String>,
        tags: Vec<String>,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            title: required_text(title.into(), "title")?,
            bucket_type,
            summary: summary.into().trim().to_owned(),
            tags: normalize_tags(tags),
        })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub const fn bucket_type(&self) -> BucketType {
        self.bucket_type
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }

    pub fn tags(&self) -> &[String] {
        &self.tags
    }
}

impl WritableSqliteStore {
    /// Create one active Bucket without adding Entries or audit rows.
    ///
    /// Text and tag normalization matches legacy `create_bucket`, while ID and
    /// timestamps are generated inside the existing isolated write transaction.
    pub fn create_bucket(
        &mut self,
        request: &CreateBucketRequest,
    ) -> Result<StoredBucket, StoreError> {
        self.run_transaction(|transaction| create_bucket(transaction, request))
    }
}

fn create_bucket(
    transaction: &Transaction<'_>,
    request: &CreateBucketRequest,
) -> Result<StoredBucket, StoreError> {
    let bucket_id = new_uuid_v4();
    let timestamp = current_timestamp(transaction)?;
    let tags_json = serialize_json(&request.tags, "buckets.tags")?;

    transaction.execute(
        "INSERT INTO buckets (
            id, title, type, status, summary, tags,
            created_at, updated_at, last_active_at
         ) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?6, ?6)",
        params![
            bucket_id,
            request.title,
            request.bucket_type.as_str(),
            request.summary,
            tags_json,
            timestamp,
        ],
    )?;

    let mut statement = transaction.prepare(
        "SELECT id, title, type, status, summary, tags,
                created_at, updated_at, last_active_at
         FROM buckets
         WHERE id = ?1",
    )?;
    let mut rows = statement.query([&bucket_id])?;
    rows.next()?
        .map(decode_bucket)
        .transpose()?
        .ok_or(StoreError::MissingRecord {
            table: "buckets",
            id: bucket_id,
        })
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    tags.into_iter()
        .filter_map(|tag| {
            let cleaned = tag.trim();
            (!cleaned.is_empty()).then(|| cleaned.to_owned())
        })
        .collect()
}
