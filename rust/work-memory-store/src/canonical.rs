use std::collections::HashSet;
use std::path::Path;

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior, params,
};
use serde_json::{Value, json};
use uuid::Uuid;
use work_memory_contracts::ChatRole;
use work_memory_core::{
    BucketStatus, BucketType, ClassificationAction, ClassificationResult, ExtractionResult,
};

use crate::archive_write::DEFAULT_BUCKET_SUMMARY_LIMIT;
use crate::bucket_summary_write::{DEFAULT_REBUILD_ENTRY_LIMIT, rebuild_bucket_summary};
use crate::canonical_schema;
use crate::{StoreError, StoredTimestamp};

/// The Rust-owned persistence layer. It deliberately does not expose the
/// legacy SQLAlchemy schema as a writable compatibility target.
#[derive(Debug)]
pub struct RustStore {
    connection: Connection,
}

/// Canonical structured-memory kinds. One table replaces legacy's four child
/// tables and also stores the additional extraction facts Rust supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MemoryKind {
    Todo,
    Evidence,
    Timeline,
    Decision,
    Hypothesis,
    Entity,
    Tag,
}

impl MemoryKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Evidence => "evidence",
            Self::Timeline => "timeline",
            Self::Decision => "decision",
            Self::Hypothesis => "hypothesis",
            Self::Entity => "entity",
            Self::Tag => "tag",
        }
    }

    fn parse(value: String) -> Result<Self, StoreError> {
        match value.as_str() {
            "todo" => Ok(Self::Todo),
            "evidence" => Ok(Self::Evidence),
            "timeline" => Ok(Self::Timeline),
            "decision" => Ok(Self::Decision),
            "hypothesis" => Ok(Self::Hypothesis),
            "entity" => Ok(Self::Entity),
            "tag" => Ok(Self::Tag),
            _ => Err(StoreError::InvalidCanonicalMemoryKind { value }),
        }
    }
}

/// A Bucket in the Rust-owned schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustBucket {
    pub id: String,
    pub title: String,
    pub bucket_type: BucketType,
    pub status: BucketStatus,
    pub summary: String,
    pub tags: Vec<String>,
    pub created_at: StoredTimestamp,
    pub updated_at: StoredTimestamp,
    pub last_active_at: StoredTimestamp,
    pub archived_at: Option<StoredTimestamp>,
}

/// An immutable original user Entry in the Rust-owned schema.
#[derive(Debug, Clone, PartialEq)]
pub struct RustEntry {
    pub id: String,
    pub bucket_id: String,
    pub raw_text: String,
    pub summary: Option<String>,
    pub content_type: String,
    pub classification_confidence: Option<f64>,
    pub classification_reason: Option<String>,
    pub created_at: StoredTimestamp,
    pub moved_from_bucket_id: Option<String>,
    pub archive_state: String,
    pub archived_at: StoredTimestamp,
}

/// One structured memory item. `occurred_at` is intentionally text so vague
/// or user-authored temporal expressions survive import without lossy parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustMemoryItem {
    pub id: String,
    pub bucket_id: String,
    pub entry_id: Option<String>,
    pub kind: MemoryKind,
    pub text: String,
    pub status: Option<String>,
    pub due_at: Option<StoredTimestamp>,
    pub occurred_at: Option<String>,
    pub source: Option<String>,
    pub reason: Option<String>,
    pub created_at: StoredTimestamp,
    pub updated_at: StoredTimestamp,
    pub metadata: Value,
}

/// A persisted classification/archive attempt, including requests that were
/// held for confirmation rather than written as an Entry.
#[derive(Debug, Clone, PartialEq)]
pub struct RustArchiveAttempt {
    pub id: String,
    pub raw_text: String,
    pub action: ClassificationAction,
    pub archive_state: String,
    pub bucket_id: Option<String>,
    pub entry_id: Option<String>,
    pub confidence: f64,
    pub reason: String,
    pub question: Option<String>,
    pub candidate_bucket_ids: Vec<String>,
    pub focus_bucket_id: Option<String>,
    pub prompt_version: String,
    pub model_name: String,
    pub corrected: bool,
    pub created_at: StoredTimestamp,
    pub resolved_at: Option<StoredTimestamp>,
}

/// One persisted chat message in the singleton conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustChatMessage {
    pub id: String,
    pub sequence: i64,
    pub role: ChatRole,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub details: Option<Value>,
    pub created_at: StoredTimestamp,
}

/// One correction audit record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustCorrection {
    pub id: String,
    pub command_text: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub created_at: StoredTimestamp,
}

/// Detail projection used by the final MVP UI/API.
#[derive(Debug, Clone, PartialEq)]
pub struct RustBucketDetail {
    pub bucket: RustBucket,
    pub entries: Vec<RustEntry>,
    pub memories: Vec<RustMemoryItem>,
}

/// Search projection. Rust owns the score and does not promise legacy's exact
/// ranking or string-boundary behavior.
#[derive(Debug, Clone, PartialEq)]
pub struct RustSearchHit {
    pub bucket: RustBucket,
    pub matched_entry_count: usize,
    pub score: usize,
}

/// Counts proving what a semantic import copied into the Rust schema.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ImportReport {
    pub buckets: usize,
    pub entries: usize,
    pub memory_items: usize,
    pub archive_attempts: usize,
    pub corrections: usize,
    pub chat_messages: usize,
}

/// Row counts for a Rust-owned database inspection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RustStoreCounts {
    pub buckets: usize,
    pub entries: usize,
    pub memory_items: usize,
    pub archive_attempts: usize,
    pub corrections: usize,
    pub chat_messages: usize,
}

/// Audit metadata supplied by the classifier/agent boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustArchiveAudit {
    pub candidate_bucket_ids: Vec<String>,
    pub focus_bucket_id: Option<String>,
    pub prompt_version: String,
    pub model_name: String,
    pub confirmation_attempt_id: Option<String>,
}

impl RustArchiveAudit {
    pub fn new(
        candidate_bucket_ids: Vec<String>,
        focus_bucket_id: Option<String>,
        prompt_version: impl Into<String>,
        model_name: impl Into<String>,
    ) -> Result<Self, StoreError> {
        let prompt_version = non_empty(prompt_version.into(), "prompt_version")?;
        let model_name = non_empty(model_name.into(), "model_name")?;
        Ok(Self {
            candidate_bucket_ids: dedupe(candidate_bucket_ids),
            focus_bucket_id: clean_optional(focus_bucket_id),
            prompt_version,
            model_name,
            confirmation_attempt_id: None,
        })
    }

    /// Bind this archive write to one pending chat confirmation attempt.
    ///
    /// The binding is consumed by the same SQLite transaction as the confirmed
    /// archive write, so a repeated request cannot create a second Entry.
    pub fn with_confirmation_attempt(
        mut self,
        attempt_id: impl Into<String>,
    ) -> Result<Self, StoreError> {
        self.confirmation_attempt_id =
            Some(non_empty(attempt_id.into(), "confirmation_attempt_id")?);
        Ok(self)
    }

    pub fn with_optional_confirmation_attempt(
        self,
        attempt_id: Option<String>,
    ) -> Result<Self, StoreError> {
        match attempt_id {
            Some(attempt_id) => self.with_confirmation_attempt(attempt_id),
            None => Ok(self),
        }
    }
}

/// Result of one canonical archive operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RustArchiveOutcome {
    pub attempt_id: String,
    pub archive_state: String,
    pub bucket_id: Option<String>,
    pub entry_id: Option<String>,
    pub memory_item_ids: Vec<String>,
}

impl RustStore {
    /// Create a fresh Rust-owned database. An existing legacy database is
    /// rejected instead of being altered in place.
    pub fn initialize(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        canonical_schema::enable_foreign_keys(&connection)?;
        if canonical_schema::is_canonical(&connection)? {
            canonical_schema::validate(&connection)?;
            return Ok(Self { connection });
        }
        canonical_schema::initialize(&connection)?;
        canonical_schema::validate(&connection)?;
        Ok(Self { connection })
    }

    /// Open an existing Rust-owned database without silently creating one.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        canonical_schema::enable_foreign_keys(&connection)?;
        canonical_schema::validate(&connection)?;
        Ok(Self { connection })
    }

    /// Open a canonical database read-only for queries and UI rendering.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.execute_batch("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;")?;
        canonical_schema::validate(&connection)?;
        Ok(Self { connection })
    }

    pub fn is_read_only(&self) -> Result<bool, StoreError> {
        let query_only: i64 = self
            .connection
            .query_row("PRAGMA query_only", [], |row| row.get(0))?;
        Ok(query_only == 1)
    }

    /// Report whether this connection has SQLite foreign-key enforcement on.
    pub fn foreign_keys_enabled(&self) -> Result<bool, StoreError> {
        let foreign_keys: i64 = self
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
        Ok(foreign_keys == 1)
    }

    /// Return row counts without exposing the underlying SQLite connection.
    pub fn counts(&self) -> Result<RustStoreCounts, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                 (SELECT COUNT(*) FROM buckets),
                 (SELECT COUNT(*) FROM entries),
                 (SELECT COUNT(*) FROM memory_items),
                 (SELECT COUNT(*) FROM archive_attempts),
                 (SELECT COUNT(*) FROM corrections),
                 (SELECT COUNT(*) FROM conversation_messages)",
        )?;
        let counts = statement.query_row([], |row| {
            Ok([
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ])
        })?;
        let mut values = counts.into_iter();
        let to_usize = |value: i64| {
            usize::try_from(value).map_err(|_| StoreError::InvalidWriteField {
                field: "row_count",
                reason: "SQLite count is outside usize range",
            })
        };
        Ok(RustStoreCounts {
            buckets: to_usize(values.next().expect("six count values"))?,
            entries: to_usize(values.next().expect("six count values"))?,
            memory_items: to_usize(values.next().expect("six count values"))?,
            archive_attempts: to_usize(values.next().expect("six count values"))?,
            corrections: to_usize(values.next().expect("six count values"))?,
            chat_messages: to_usize(values.next().expect("six count values"))?,
        })
    }

    /// Import the old legacy database into a newly initialized Rust database.
    /// The source is read-only and the target is the only file modified.
    pub fn import_legacy_database(
        source_path: impl AsRef<Path>,
        target_path: impl AsRef<Path>,
    ) -> Result<ImportReport, StoreError> {
        crate::legacy_import::import_legacy_database(source_path.as_ref(), target_path.as_ref())
    }

    /// Return every Bucket, including paused, done, and archived Buckets.
    ///
    /// Natural-language queries need to apply lifecycle filters after parsing
    /// the user's request, so this intentionally does not silently restrict the
    /// result set to active Buckets.
    pub fn list_buckets(&self) -> Result<Vec<RustBucket>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, kind, lifecycle, summary, created_at, updated_at,
                    last_active_at, archived_at
             FROM buckets
             ORDER BY last_active_at DESC, updated_at DESC, id ASC",
        )?;
        let rows = statement
            .query_map([], decode_bucket_base)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|bucket| self.attach_tags(bucket))
            .collect()
    }

    pub fn list_active_buckets(&self, limit: usize) -> Result<Vec<RustBucket>, StoreError> {
        let limit = checked_limit(limit)?;
        let mut statement = self.connection.prepare(
            "SELECT id, title, kind, lifecycle, summary, created_at, updated_at,
                    last_active_at, archived_at
             FROM buckets
             WHERE lifecycle = 'active'
             ORDER BY last_active_at DESC, updated_at DESC, id ASC
             LIMIT ?1",
        )?;
        let rows = statement
            .query_map([limit], decode_bucket_base)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|bucket| self.attach_tags(bucket))
            .collect()
    }

    pub fn get_bucket(&self, bucket_id: &str) -> Result<Option<RustBucket>, StoreError> {
        let bucket = self
            .connection
            .query_row(
                "SELECT id, title, kind, lifecycle, summary, created_at, updated_at,
                        last_active_at, archived_at
                 FROM buckets WHERE id = ?1",
                [bucket_id],
                decode_bucket_base,
            )
            .optional()?;
        bucket.map(|value| self.attach_tags(value)).transpose()
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<RustSearchHit>, StoreError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(StoreError::InvalidWriteField {
                field: "query",
                reason: "must not be empty",
            });
        }
        let limit = checked_limit(limit)? as usize;
        let needle = query.to_lowercase();
        let mut statement = self.connection.prepare(
            "SELECT id, title, kind, lifecycle, summary, created_at, updated_at,
                    last_active_at, archived_at
             FROM buckets
             ORDER BY last_active_at DESC, updated_at DESC, id ASC",
        )?;
        let buckets = statement
            .query_map([], decode_bucket_base)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut hits = Vec::new();
        for bucket in buckets {
            let bucket = self.attach_tags(bucket)?;
            let entries = self.list_entries(&bucket.id)?;
            let haystack = format!(
                "{} {} {}",
                bucket.title,
                bucket.summary,
                bucket.tags.join(" ")
            )
            .to_lowercase();
            let mut score = token_score(&needle, &haystack);
            let mut matched_entry_count = 0;
            for entry in &entries {
                let entry_text = format!(
                    "{} {}",
                    entry.raw_text,
                    entry.summary.as_deref().unwrap_or_default()
                )
                .to_lowercase();
                let entry_score = token_score(&needle, &entry_text);
                if entry_score > 0 {
                    matched_entry_count += 1;
                    score += entry_score + 1;
                }
            }
            if score > 0 {
                hits.push(RustSearchHit {
                    bucket,
                    matched_entry_count,
                    score,
                });
            }
        }
        hits.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| {
                    right
                        .bucket
                        .last_active_at
                        .raw()
                        .cmp(left.bucket.last_active_at.raw())
                })
                .then_with(|| left.bucket.id.cmp(&right.bucket.id))
        });
        hits.truncate(limit);
        Ok(hits)
    }

    pub fn bucket_detail(&self, bucket_id: &str) -> Result<Option<RustBucketDetail>, StoreError> {
        let Some(bucket) = self.get_bucket(bucket_id)? else {
            return Ok(None);
        };
        Ok(Some(RustBucketDetail {
            entries: self.list_entries(bucket_id)?,
            memories: self.list_memory_items(bucket_id)?,
            bucket,
        }))
    }

    pub fn list_entries(&self, bucket_id: &str) -> Result<Vec<RustEntry>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, raw_text, summary, content_type,
                    classification_confidence, classification_reason, created_at,
                    moved_from_bucket_id, archive_state, archived_at
             FROM entries WHERE bucket_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        statement
            .query_map([bucket_id], decode_entry)
            .map_err(StoreError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_memory_items(&self, bucket_id: &str) -> Result<Vec<RustMemoryItem>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, bucket_id, entry_id, kind, text, status, due_at, occurred_at,
                    source, reason, created_at, updated_at, metadata_json
             FROM memory_items WHERE bucket_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        statement
            .query_map([bucket_id], decode_memory_item)
            .map_err(StoreError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_archive_attempts(
        &self,
        limit: usize,
    ) -> Result<Vec<RustArchiveAttempt>, StoreError> {
        let limit = checked_limit(limit)?;
        let mut statement = self.connection.prepare(
            "SELECT id, raw_text, action, archive_state, bucket_id, entry_id,
                    confidence, reason, question, candidate_bucket_ids_json,
                    focus_bucket_id, prompt_version, model_name, corrected,
                    created_at, resolved_at
             FROM archive_attempts
             ORDER BY created_at DESC, id DESC LIMIT ?1",
        )?;
        statement
            .query_map([limit], decode_archive_attempt)
            .map_err(StoreError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_archive_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<RustArchiveAttempt>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, raw_text, action, archive_state, bucket_id, entry_id,
                    confidence, reason, question, candidate_bucket_ids_json,
                    focus_bucket_id, prompt_version, model_name, corrected,
                    created_at, resolved_at
             FROM archive_attempts WHERE id = ?1 LIMIT 1",
        )?;
        statement
            .query_row([attempt_id], decode_archive_attempt)
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_chat_messages(&self, limit: usize) -> Result<Vec<RustChatMessage>, StoreError> {
        let limit = checked_limit(limit)?;
        let mut statement = self.connection.prepare(
            "SELECT id, sequence, role, content, tool_name, tool_call_id,
                    details_json, created_at
             FROM (
                 SELECT id, sequence, role, content, tool_name, tool_call_id,
                        details_json, created_at
                 FROM conversation_messages
                 ORDER BY sequence DESC LIMIT ?1
             ) recent
             ORDER BY sequence ASC",
        )?;
        statement
            .query_map([limit], decode_chat_message)
            .map_err(StoreError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_corrections(
        &self,
        target_type: Option<&str>,
        target_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RustCorrection>, StoreError> {
        let limit = checked_limit(limit)?;
        let mut statement = self.connection.prepare(
            "SELECT id, command_text, action, target_type, target_id,
                    before_json, after_json, created_at
             FROM corrections
             WHERE (?1 IS NULL OR target_type = ?1)
               AND (?2 IS NULL OR target_id = ?2)
             ORDER BY created_at DESC, id DESC LIMIT ?3",
        )?;
        statement
            .query_map(params![target_type, target_id, limit], decode_correction)
            .map_err(StoreError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// Persist an automatic archive or a confirmation-required attempt in one
    /// transaction. This is the canonical Rust behavior; it intentionally does
    /// not mimic legacy's table-by-table write sequence.
    pub fn archive(
        &mut self,
        raw_text: impl Into<String>,
        classification: ClassificationResult,
        extraction: Option<ExtractionResult>,
        audit: RustArchiveAudit,
    ) -> Result<RustArchiveOutcome, StoreError> {
        let raw_text = non_empty(raw_text.into(), "raw_text")?;
        validate_archive_inputs(&classification, extraction.as_ref())?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let outcome = persist_archive(
            &transaction,
            &raw_text,
            &classification,
            extraction.as_ref(),
            &audit,
        )?;
        transaction.commit()?;
        Ok(outcome)
    }

    /// Discard a pending confirmation attempt without creating an Entry.
    pub fn discard_archive_attempt(
        &mut self,
        attempt_id: &str,
        raw_text: &str,
    ) -> Result<(), StoreError> {
        let attempt_id = non_empty(attempt_id.to_owned(), "attempt_id")?;
        let raw_text = non_empty(raw_text.to_owned(), "raw_text")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored_raw_text = transaction
            .query_row(
                "SELECT raw_text FROM archive_attempts WHERE id = ?1",
                [&attempt_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::ArchiveAttemptNotFound(attempt_id.clone()))?;
        if stored_raw_text != raw_text {
            return Err(StoreError::ArchiveAttemptTextMismatch(attempt_id));
        }
        let timestamp = current_timestamp(&transaction)?;
        let updated = transaction.execute(
            "UPDATE archive_attempts
             SET archive_state = 'discarded', resolved_at = ?1
             WHERE id = ?2 AND archive_state = 'needs_confirmation'
               AND resolved_at IS NULL AND corrected = 0",
            params![timestamp, attempt_id],
        )?;
        if updated != 1 {
            return Err(StoreError::ArchiveAttemptNotPending(attempt_id));
        }
        transaction.commit()?;
        Ok(())
    }

    /// Append one message to the persistent conversation timeline.
    pub fn append_chat_message(
        &mut self,
        role: ChatRole,
        content: impl Into<String>,
        tool_name: Option<String>,
        tool_call_id: Option<String>,
        details: Option<Value>,
    ) -> Result<RustChatMessage, StoreError> {
        let content = non_empty(content.into(), "content")?;
        let details = normalize_details(details)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM conversation_messages",
            [],
            |row| row.get(0),
        )?;
        let created_at = current_timestamp(&transaction)?;
        let id = new_id();
        transaction.execute(
            "INSERT INTO conversation_messages
                (id, sequence, role, content, tool_name, tool_call_id, details_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                sequence,
                role.as_str(),
                content,
                tool_name,
                tool_call_id,
                details.as_ref().map(Value::to_string),
                &created_at,
            ],
        )?;
        transaction.commit()?;
        let connection = &self.connection;
        connection
            .query_row(
                "SELECT id, sequence, role, content, tool_name, tool_call_id,
                        details_json, created_at
                 FROM conversation_messages WHERE sequence = ?1",
                [sequence],
                decode_chat_message,
            )
            .map_err(StoreError::from)
    }

    /// Move an Entry and write a durable correction snapshot. The correction
    /// command is free-form because Rust owns the new command grammar.
    pub fn move_entry(
        &mut self,
        entry_id: &str,
        target_bucket_id: &str,
        command_text: impl Into<String>,
    ) -> Result<RustEntry, StoreError> {
        let command_text = non_empty(command_text.into(), "command_text")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old_bucket_id: String = transaction
            .query_row(
                "SELECT bucket_id FROM entries WHERE id = ?1",
                [entry_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::MissingRecord {
                table: "entries",
                id: entry_id.to_owned(),
            })?;
        if !transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM buckets WHERE id = ?1)",
            [target_bucket_id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(StoreError::MissingRecord {
                table: "buckets",
                id: target_bucket_id.to_owned(),
            });
        }
        if old_bucket_id == target_bucket_id {
            return Err(StoreError::InvalidCorrectionWrite {
                action: "move_entry",
                reason: "source and target buckets must differ",
            });
        }
        let timestamp = current_timestamp(&transaction)?;
        transaction.execute(
            "UPDATE entries SET bucket_id = ?1, moved_from_bucket_id = ?2
             WHERE id = ?3",
            params![target_bucket_id, old_bucket_id, entry_id],
        )?;
        transaction.execute(
            "UPDATE memory_items SET bucket_id = ?1 WHERE entry_id = ?2",
            params![target_bucket_id, entry_id],
        )?;
        transaction.execute(
            "UPDATE buckets SET updated_at = ?1, last_active_at = ?1
             WHERE id = ?2",
            params![timestamp, target_bucket_id],
        )?;
        if source_bucket_should_be_removed_after_move(&transaction, &old_bucket_id, entry_id)? {
            delete_empty_source_bucket(&transaction, &old_bucket_id)?;
        } else {
            transaction.execute(
                "UPDATE buckets SET updated_at = ?1, last_active_at = ?1
                 WHERE id = ?2",
                params![timestamp, old_bucket_id],
            )?;
            rebuild_bucket_summary(
                &transaction,
                &old_bucket_id,
                DEFAULT_REBUILD_ENTRY_LIMIT,
                DEFAULT_BUCKET_SUMMARY_LIMIT as i64,
            )?;
        }
        rebuild_bucket_summary(
            &transaction,
            target_bucket_id,
            DEFAULT_REBUILD_ENTRY_LIMIT,
            DEFAULT_BUCKET_SUMMARY_LIMIT as i64,
        )?;
        let correction_id = new_id();
        transaction.execute(
            "INSERT INTO corrections
                (id, command_text, action, target_type, target_id, before_json, after_json, created_at)
             VALUES (?1, ?2, 'move_entry', 'entry', ?3, ?4, ?5, ?6)",
            params![
                correction_id,
                command_text,
                entry_id,
                json!({"bucket_id": old_bucket_id}).to_string(),
                json!({"bucket_id": target_bucket_id, "reason": "user_correction"}).to_string(),
                timestamp,
            ],
        )?;
        transaction.execute(
            "UPDATE archive_attempts
             SET corrected = 1, archive_state = 'corrected', resolved_at = ?1
             WHERE entry_id = ?2 AND corrected = 0",
            params![timestamp, entry_id],
        )?;
        transaction.commit()?;
        self.connection
            .query_row(
                "SELECT id, bucket_id, raw_text, summary, content_type,
                        classification_confidence, classification_reason, created_at,
                        moved_from_bucket_id, archive_state, archived_at
                 FROM entries WHERE id = ?1",
                [entry_id],
                decode_entry,
            )
            .map_err(StoreError::from)
    }

    /// Change Bucket lifecycle without exposing SQL. This is the MVP's explicit
    /// archive-state operation.
    pub fn set_bucket_status(
        &mut self,
        bucket_id: &str,
        status: BucketStatus,
    ) -> Result<RustBucket, StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = current_timestamp(&transaction)?;
        let archived_at = if status == BucketStatus::Archived {
            Some(timestamp.clone())
        } else {
            None
        };
        let changed = transaction.execute(
            "UPDATE buckets SET lifecycle = ?1, updated_at = ?2, archived_at = ?3
             WHERE id = ?4",
            params![status.as_str(), timestamp, archived_at, bucket_id],
        )?;
        if changed != 1 {
            return Err(StoreError::MissingRecord {
                table: "buckets",
                id: bucket_id.to_owned(),
            });
        }
        transaction.commit()?;
        self.get_bucket(bucket_id)?
            .ok_or_else(|| StoreError::MissingRecord {
                table: "buckets",
                id: bucket_id.to_owned(),
            })
    }

    fn attach_tags(&self, mut bucket: RustBucket) -> Result<RustBucket, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT tag FROM bucket_tags WHERE bucket_id = ?1 ORDER BY position ASC")?;
        bucket.tags = statement
            .query_map([&bucket.id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(bucket)
    }
}

fn persist_archive(
    transaction: &Transaction<'_>,
    raw_text: &str,
    classification: &ClassificationResult,
    extraction: Option<&ExtractionResult>,
    audit: &RustArchiveAudit,
) -> Result<RustArchiveOutcome, StoreError> {
    if let Some(confirmation_attempt_id) = audit.confirmation_attempt_id.as_deref() {
        let pending = transaction
            .query_row(
                "SELECT raw_text, archive_state, resolved_at, corrected
                 FROM archive_attempts WHERE id = ?1",
                [confirmation_attempt_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                StoreError::ArchiveAttemptNotFound(confirmation_attempt_id.to_owned())
            })?;
        if pending.0 != raw_text {
            return Err(StoreError::ArchiveAttemptTextMismatch(
                confirmation_attempt_id.to_owned(),
            ));
        }
        if pending.1 != "needs_confirmation" || pending.2.is_some() || pending.3 != 0 {
            return Err(StoreError::ArchiveAttemptNotPending(
                confirmation_attempt_id.to_owned(),
            ));
        }
    }
    let attempt_id = new_id();
    let created_at = current_timestamp(transaction)?;
    let candidate_ids = merged_candidates(&audit.candidate_bucket_ids, classification);
    let action = classification.action().as_str();
    let archive_state = if classification.action() == ClassificationAction::AskUser {
        "needs_confirmation"
    } else {
        "archived"
    };
    let mut bucket_id = classification.bucket_id().map(str::to_owned);
    let mut entry_id = None;
    let mut memory_item_ids = Vec::new();

    let extraction_summary = extraction.map(ExtractionResult::summary);
    if classification.action() != ClassificationAction::AskUser {
        let target_bucket_id = match classification.action() {
            ClassificationAction::AppendExisting => {
                let bucket_id =
                    classification
                        .bucket_id()
                        .ok_or(StoreError::InvalidArchiveWrite {
                            action,
                            reason: "append_existing requires bucket_id",
                        })?;
                ensure_bucket(transaction, bucket_id)?;
                bucket_id.to_owned()
            }
            ClassificationAction::CreateNew => {
                let title = classification
                    .title()
                    .ok_or(StoreError::InvalidArchiveWrite {
                        action,
                        reason: "create_new requires title",
                    })?;
                let bucket_type =
                    classification
                        .bucket_type()
                        .ok_or(StoreError::InvalidArchiveWrite {
                            action,
                            reason: "create_new requires bucket_type",
                        })?;
                let bucket_id = new_id();
                transaction.execute(
                    "INSERT INTO buckets
                        (id, title, kind, lifecycle, summary, created_at, updated_at,
                         last_active_at, archived_at, metadata_json)
                     VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?5, ?5, NULL, '{}')",
                    params![bucket_id, title, bucket_type.as_str(), "", &created_at,],
                )?;
                bucket_id
            }
            ClassificationAction::AskUser => unreachable!(),
        };
        bucket_id = Some(target_bucket_id.clone());
        let entry_id_value = new_id();
        let summary = extraction_summary.map(str::to_owned);
        transaction.execute(
            "INSERT INTO entries
                (id, bucket_id, raw_text, summary, content_type,
                 classification_confidence, classification_reason, created_at,
                 moved_from_bucket_id, archive_state, archived_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, 'note', ?5, ?6, ?7, NULL, 'archived', ?7, '{}')",
            params![
                entry_id_value,
                target_bucket_id,
                raw_text,
                summary,
                classification.confidence(),
                classification.reason(),
                &created_at,
            ],
        )?;
        entry_id = Some(entry_id_value.clone());
        if let Some(extraction) = extraction {
            memory_item_ids = insert_extraction(
                transaction,
                &target_bucket_id,
                &entry_id_value,
                extraction,
                &created_at,
            )?;
            update_bucket_after_extraction(
                transaction,
                &target_bucket_id,
                extraction,
                &created_at,
            )?;
        }
    }

    transaction.execute(
        "INSERT INTO archive_attempts
            (id, raw_text, action, archive_state, bucket_id, entry_id, confidence,
             reason, question, candidate_bucket_ids_json, focus_bucket_id,
             prompt_version, model_name, corrected, created_at, resolved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15)",
        params![
            attempt_id,
            raw_text,
            action,
            archive_state,
            bucket_id,
            entry_id,
            classification.confidence(),
            classification.reason(),
            classification.question(),
            serde_json::to_string(&candidate_ids).map_err(|source| {
                StoreError::JsonSerialization {
                    context: "archive candidate bucket IDs",
                    source,
                }
            })?,
            audit.focus_bucket_id,
            audit.prompt_version,
            audit.model_name,
            &created_at,
            if entry_id.is_some() {
                Some(created_at.clone())
            } else {
                None::<String>
            },
        ],
    )?;
    if let Some(confirmation_attempt_id) = audit.confirmation_attempt_id.as_deref() {
        let updated = transaction.execute(
            "UPDATE archive_attempts
             SET archive_state = ?1, bucket_id = ?2, entry_id = ?3, resolved_at = ?4
             WHERE id = ?5 AND archive_state = 'needs_confirmation'
               AND resolved_at IS NULL AND corrected = 0",
            params![
                archive_state,
                bucket_id,
                entry_id,
                &created_at,
                confirmation_attempt_id,
            ],
        )?;
        if updated != 1 {
            return Err(StoreError::ArchiveAttemptNotPending(
                confirmation_attempt_id.to_owned(),
            ));
        }
    }
    Ok(RustArchiveOutcome {
        attempt_id,
        archive_state: archive_state.to_owned(),
        bucket_id,
        entry_id,
        memory_item_ids,
    })
}

fn insert_extraction(
    transaction: &Transaction<'_>,
    bucket_id: &str,
    entry_id: &str,
    extraction: &ExtractionResult,
    timestamp: &str,
) -> Result<Vec<String>, StoreError> {
    let mut ids = Vec::new();
    for (kind, text, status, due_at, occurred_at, source, reason) in extraction_rows(extraction) {
        let id = new_id();
        transaction.execute(
            "INSERT INTO memory_items
                (id, bucket_id, entry_id, kind, text, status, due_at, occurred_at,
                 source, reason, created_at, updated_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, '{}')",
            params![
                id,
                bucket_id,
                entry_id,
                kind.as_str(),
                text,
                status,
                due_at,
                occurred_at,
                source,
                reason,
                timestamp,
            ],
        )?;
        ids.push(id);
    }
    Ok(ids)
}

type ExtractionRow = (
    MemoryKind,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn extraction_rows(extraction: &ExtractionResult) -> Vec<ExtractionRow> {
    let mut rows = Vec::new();
    rows.extend(extraction.todos().iter().cloned().map(|text| {
        (
            MemoryKind::Todo,
            text,
            Some("open".to_owned()),
            None,
            None,
            None,
            None,
        )
    }));
    rows.extend(extraction.evidences().iter().cloned().map(|text| {
        (
            MemoryKind::Evidence,
            text,
            None,
            None,
            None,
            Some("llm".to_owned()),
            None,
        )
    }));
    rows.extend(extraction.timeline_events().iter().map(|event| {
        (
            MemoryKind::Timeline,
            event.text().to_owned(),
            None,
            None,
            event.event_time().map(str::to_owned),
            None,
            None,
        )
    }));
    rows.extend(
        extraction
            .decisions()
            .iter()
            .cloned()
            .map(|text| (MemoryKind::Decision, text, None, None, None, None, None)),
    );
    rows.extend(
        extraction
            .hypotheses()
            .iter()
            .cloned()
            .map(|text| (MemoryKind::Hypothesis, text, None, None, None, None, None)),
    );
    rows.extend(
        extraction
            .entities()
            .iter()
            .cloned()
            .map(|text| (MemoryKind::Entity, text, None, None, None, None, None)),
    );
    rows.extend(
        extraction
            .tags()
            .iter()
            .cloned()
            .map(|text| (MemoryKind::Tag, text, None, None, None, None, None)),
    );
    rows
}

fn update_bucket_after_extraction(
    transaction: &Transaction<'_>,
    bucket_id: &str,
    extraction: &ExtractionResult,
    timestamp: &str,
) -> Result<(), StoreError> {
    let existing_summary: String = transaction.query_row(
        "SELECT summary FROM buckets WHERE id = ?1",
        [bucket_id],
        |row| row.get(0),
    )?;
    let summary = merge_summary(&existing_summary, extraction.summary(), 2_000);
    transaction.execute(
        "UPDATE buckets SET summary = ?1, updated_at = ?2, last_active_at = ?2
         WHERE id = ?3",
        params![summary, timestamp, bucket_id],
    )?;
    let mut position: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM bucket_tags WHERE bucket_id = ?1",
        [bucket_id],
        |row| row.get(0),
    )?;
    let mut existing = transaction
        .prepare("SELECT tag FROM bucket_tags WHERE bucket_id = ?1")?
        .query_map([bucket_id], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    for tag in extraction.tags() {
        let tag = tag.trim();
        if tag.is_empty() || !existing.insert(tag.to_owned()) {
            continue;
        }
        transaction.execute(
            "INSERT INTO bucket_tags(bucket_id, tag, position) VALUES (?1, ?2, ?3)",
            params![bucket_id, tag, position],
        )?;
        position += 1;
    }
    Ok(())
}

fn validate_archive_inputs(
    classification: &ClassificationResult,
    extraction: Option<&ExtractionResult>,
) -> Result<(), StoreError> {
    match (classification.action(), extraction) {
        (ClassificationAction::AskUser, Some(_)) => Err(StoreError::InvalidArchiveWrite {
            action: "ask_user",
            reason: "confirmation requests do not persist an extraction",
        }),
        (ClassificationAction::AskUser, None) => Ok(()),
        (ClassificationAction::AppendExisting | ClassificationAction::CreateNew, Some(_)) => Ok(()),
        (action, None) => Err(StoreError::InvalidArchiveWrite {
            action: action.as_str(),
            reason: "automatic archive actions require extraction",
        }),
    }
}

fn ensure_bucket(transaction: &Transaction<'_>, bucket_id: &str) -> Result<(), StoreError> {
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM buckets WHERE id = ?1)",
        [bucket_id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(StoreError::MissingRecord {
            table: "buckets",
            id: bucket_id.to_owned(),
        })
    }
}

fn source_bucket_should_be_removed_after_move(
    transaction: &Transaction<'_>,
    source_bucket_id: &str,
    moved_entry_id: &str,
) -> Result<bool, StoreError> {
    let source_was_created_for_entry: bool = transaction.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM archive_attempts
             WHERE action = 'create_new'
               AND bucket_id = ?1
               AND entry_id = ?2
         )",
        params![source_bucket_id, moved_entry_id],
        |row| row.get(0),
    )?;
    if !source_was_created_for_entry {
        return Ok(false);
    }

    let remaining_bucket_records: i64 = transaction.query_row(
        "SELECT
             (SELECT COUNT(*) FROM entries WHERE bucket_id = ?1)
           + (SELECT COUNT(*) FROM memory_items WHERE bucket_id = ?1)",
        [source_bucket_id],
        |row| row.get(0),
    )?;
    Ok(remaining_bucket_records == 0)
}

fn delete_empty_source_bucket(
    transaction: &Transaction<'_>,
    source_bucket_id: &str,
) -> Result<(), StoreError> {
    let deleted = transaction.execute("DELETE FROM buckets WHERE id = ?1", [source_bucket_id])?;
    if deleted == 1 {
        Ok(())
    } else {
        Err(StoreError::MissingRecord {
            table: "buckets",
            id: source_bucket_id.to_owned(),
        })
    }
}

fn merged_candidates(server: &[String], result: &ClassificationResult) -> Vec<String> {
    let mut values = server.to_vec();
    values.extend(result.candidate_bucket_ids().iter().cloned());
    if let Some(bucket_id) = result.bucket_id() {
        values.push(bucket_id.to_owned());
    }
    dedupe(values)
}

fn decode_error(error: StoreError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn decode_bucket_base(row: &Row<'_>) -> rusqlite::Result<RustBucket> {
    let id: String = row.get(0)?;
    let kind: String = row.get(2)?;
    let lifecycle: String = row.get(3)?;
    Ok(RustBucket {
        id: id.clone(),
        title: row.get(1)?,
        bucket_type: parse_bucket_type(&id, kind).map_err(decode_error)?,
        status: parse_bucket_status(&id, lifecycle).map_err(decode_error)?,
        summary: row.get(4)?,
        tags: Vec::new(),
        created_at: parse_timestamp("buckets", "created_at", &id, row.get(5)?)
            .map_err(decode_error)?,
        updated_at: parse_timestamp("buckets", "updated_at", &id, row.get(6)?)
            .map_err(decode_error)?,
        last_active_at: parse_timestamp("buckets", "last_active_at", &id, row.get(7)?)
            .map_err(decode_error)?,
        archived_at: parse_optional_timestamp("buckets", "archived_at", &id, row.get(8)?)
            .map_err(decode_error)?,
    })
}

fn decode_entry(row: &Row<'_>) -> rusqlite::Result<RustEntry> {
    let id: String = row.get(0)?;
    Ok(RustEntry {
        id: id.clone(),
        bucket_id: row.get(1)?,
        raw_text: row.get(2)?,
        summary: row.get(3)?,
        content_type: row.get(4)?,
        classification_confidence: row.get(5)?,
        classification_reason: row.get(6)?,
        created_at: parse_timestamp("entries", "created_at", &id, row.get(7)?)
            .map_err(decode_error)?,
        moved_from_bucket_id: row.get(8)?,
        archive_state: row.get(9)?,
        archived_at: parse_timestamp("entries", "archived_at", &id, row.get(10)?)
            .map_err(decode_error)?,
    })
}

fn decode_memory_item(row: &Row<'_>) -> rusqlite::Result<RustMemoryItem> {
    let id: String = row.get(0)?;
    let metadata_json: String = row.get(12)?;
    Ok(RustMemoryItem {
        id: id.clone(),
        bucket_id: row.get(1)?,
        entry_id: row.get(2)?,
        kind: MemoryKind::parse(row.get(3)?).map_err(decode_error)?,
        text: row.get(4)?,
        status: row.get(5)?,
        due_at: parse_optional_timestamp("memory_items", "due_at", &id, row.get(6)?)
            .map_err(decode_error)?,
        occurred_at: row.get(7)?,
        source: row.get(8)?,
        reason: row.get(9)?,
        created_at: parse_timestamp("memory_items", "created_at", &id, row.get(10)?)
            .map_err(decode_error)?,
        updated_at: parse_timestamp("memory_items", "updated_at", &id, row.get(11)?)
            .map_err(decode_error)?,
        metadata: parse_json("memory_items", "metadata_json", &id, &metadata_json)
            .map_err(decode_error)?,
    })
}

fn decode_archive_attempt(row: &Row<'_>) -> rusqlite::Result<RustArchiveAttempt> {
    let id: String = row.get(0)?;
    let corrected =
        parse_bool("archive_attempts", "corrected", &id, row.get(13)?).map_err(decode_error)?;
    let candidate_json: String = row.get(9)?;
    Ok(RustArchiveAttempt {
        id: id.clone(),
        raw_text: row.get(1)?,
        action: parse_action(&id, row.get(2)?).map_err(decode_error)?,
        archive_state: row.get(3)?,
        bucket_id: row.get(4)?,
        entry_id: row.get(5)?,
        confidence: row.get(6)?,
        reason: row.get(7)?,
        question: row.get(8)?,
        candidate_bucket_ids: parse_json(
            "archive_attempts",
            "candidate_bucket_ids_json",
            &id,
            &candidate_json,
        )
        .map_err(decode_error)?,
        focus_bucket_id: row.get(10)?,
        prompt_version: row.get(11)?,
        model_name: row.get(12)?,
        corrected,
        created_at: parse_timestamp("archive_attempts", "created_at", &id, row.get(14)?)
            .map_err(decode_error)?,
        resolved_at: parse_optional_timestamp("archive_attempts", "resolved_at", &id, row.get(15)?)
            .map_err(decode_error)?,
    })
}

fn decode_chat_message(row: &Row<'_>) -> rusqlite::Result<RustChatMessage> {
    let id: String = row.get(0)?;
    let details_json: Option<String> = row.get(6)?;
    Ok(RustChatMessage {
        id: id.clone(),
        sequence: row.get(1)?,
        role: parse_chat_role(&id, row.get(2)?).map_err(decode_error)?,
        content: row.get(3)?,
        tool_name: row.get(4)?,
        tool_call_id: row.get(5)?,
        details: details_json
            .as_deref()
            .map(|raw| parse_json("conversation_messages", "details_json", &id, raw))
            .transpose()
            .map_err(decode_error)?,
        created_at: parse_timestamp("conversation_messages", "created_at", &id, row.get(7)?)
            .map_err(decode_error)?,
    })
}

fn decode_correction(row: &Row<'_>) -> rusqlite::Result<RustCorrection> {
    let id: String = row.get(0)?;
    Ok(RustCorrection {
        id: id.clone(),
        command_text: row.get(1)?,
        action: row.get(2)?,
        target_type: row.get(3)?,
        target_id: row.get(4)?,
        before: row
            .get::<_, Option<String>>(5)?
            .as_deref()
            .map(|raw| parse_json("corrections", "before_json", &id, raw))
            .transpose()
            .map_err(decode_error)?,
        after: row
            .get::<_, Option<String>>(6)?
            .as_deref()
            .map(|raw| parse_json("corrections", "after_json", &id, raw))
            .transpose()
            .map_err(decode_error)?,
        created_at: parse_timestamp("corrections", "created_at", &id, row.get(7)?)
            .map_err(decode_error)?,
    })
}

fn parse_bucket_type(bucket_id: &str, value: String) -> Result<BucketType, StoreError> {
    BucketType::ALL
        .into_iter()
        .find(|kind| kind.as_str() == value)
        .ok_or_else(|| StoreError::InvalidBucketType {
            bucket_id: bucket_id.to_owned(),
            value,
        })
}

fn parse_bucket_status(bucket_id: &str, value: String) -> Result<BucketStatus, StoreError> {
    [
        BucketStatus::Active,
        BucketStatus::Paused,
        BucketStatus::Done,
        BucketStatus::Archived,
    ]
    .into_iter()
    .find(|status| status.as_str() == value)
    .ok_or_else(|| StoreError::InvalidBucketStatus {
        bucket_id: bucket_id.to_owned(),
        value,
    })
}

fn parse_action(record_id: &str, value: String) -> Result<ClassificationAction, StoreError> {
    [
        ClassificationAction::AppendExisting,
        ClassificationAction::CreateNew,
        ClassificationAction::AskUser,
    ]
    .into_iter()
    .find(|action| action.as_str() == value)
    .ok_or_else(|| StoreError::InvalidClassificationAction {
        classification_record_id: record_id.to_owned(),
        value,
    })
}

fn parse_chat_role(message_id: &str, value: String) -> Result<ChatRole, StoreError> {
    match value.as_str() {
        "user" => Ok(ChatRole::User),
        "assistant" => Ok(ChatRole::Assistant),
        "tool" => Ok(ChatRole::Tool),
        _ => Err(StoreError::InvalidChatRole {
            chat_message_id: message_id.to_owned(),
            value,
        }),
    }
}

fn parse_json<T: serde::de::DeserializeOwned>(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    raw: &str,
) -> Result<T, StoreError> {
    serde_json::from_str(raw).map_err(|source| StoreError::InvalidJson {
        table,
        column,
        record_id: record_id.to_owned(),
        source,
    })
}

fn parse_timestamp(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    raw: String,
) -> Result<StoredTimestamp, StoreError> {
    StoredTimestamp::parse(table, column, record_id, raw)
}

fn parse_optional_timestamp(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    raw: Option<String>,
) -> Result<Option<StoredTimestamp>, StoreError> {
    raw.map(|value| parse_timestamp(table, column, record_id, value))
        .transpose()
}

fn parse_bool(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    value: i64,
) -> Result<bool, StoreError> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        value => Err(StoreError::InvalidBoolean {
            table,
            column,
            record_id: record_id.to_owned(),
            value,
        }),
    }
}

fn normalize_details(details: Option<Value>) -> Result<Option<Value>, StoreError> {
    match details {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(_) | Value::Array(_)) => Ok(details),
        Some(_) => Err(StoreError::InvalidJsonType {
            table: "conversation_messages",
            column: "details_json",
            record_id: "new-message".to_owned(),
            expected: "object, array, or null",
            found: "scalar",
        }),
    }
}

fn checked_limit(limit: usize) -> Result<i64, StoreError> {
    if limit < 1 {
        return Err(StoreError::InvalidLimit(limit));
    }
    i64::try_from(limit).map_err(|_| StoreError::InvalidLimit(limit))
}

fn current_timestamp(transaction: &Transaction<'_>) -> Result<String, StoreError> {
    Ok(transaction.query_row(
        "SELECT strftime('%Y-%m-%d %H:%M:%f000', 'now')",
        [],
        |row| row.get(0),
    )?)
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn non_empty(value: String, field: &'static str) -> Result<String, StoreError> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        Err(StoreError::InvalidWriteField {
            field,
            reason: "must not be empty",
        })
    } else {
        Ok(value)
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn token_score(needle: &str, haystack: &str) -> usize {
    let mut score = 0;
    if haystack.contains(needle) {
        score += 3;
    }
    for token in needle.split_whitespace().filter(|token| token.len() > 1) {
        if haystack.contains(token) {
            score += 1;
        }
    }
    score
}

fn merge_summary(existing: &str, incoming: &str, max_chars: usize) -> String {
    let incoming = incoming.trim();
    if incoming.is_empty() {
        return existing.chars().take(max_chars).collect();
    }
    let merged = if existing.trim().is_empty() {
        incoming.to_owned()
    } else {
        format!("{}\n{}", existing.trim(), incoming)
    };
    let chars: Vec<char> = merged.chars().collect();
    if chars.len() <= max_chars {
        merged
    } else {
        chars[chars.len() - max_chars..].iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use tempfile::NamedTempFile;
    use work_memory_core::{BucketType, ClassificationResult, ExtractionResult};

    use super::{RustArchiveAudit, RustStore};

    #[test]
    fn initializes_a_rust_owned_schema_and_searches_with_new_scoring() {
        let database = NamedTempFile::new().expect("temporary database");
        let mut store = RustStore::initialize(database.path()).expect("canonical schema");
        let classification = ClassificationResult::create_new(
            BucketType::Incident,
            "Payment callback",
            0.96,
            "new incident",
            vec![],
        )
        .expect("classification");
        let extraction =
            ExtractionResult::minimal("Investigating 502 callbacks.").expect("extraction");
        let outcome = store
            .archive(
                "The payment callback returned 502.",
                classification,
                Some(extraction),
                RustArchiveAudit::new(vec![], None, "rust-classification-v1", "test-model")
                    .expect("audit"),
            )
            .expect("archive");
        assert_eq!(outcome.archive_state, "archived");
        assert_eq!(store.search("callback", 10).expect("search").len(), 1);
        assert!(
            store
                .bucket_detail(outcome.bucket_id.as_deref().expect("bucket"))
                .expect("detail")
                .is_some()
        );
    }

    #[test]
    fn confirmation_attempt_does_not_create_an_entry() {
        let database = NamedTempFile::new().expect("temporary database");
        let mut store = RustStore::initialize(database.path()).expect("canonical schema");
        let classification = ClassificationResult::ask_user(
            Some(BucketType::Incident),
            None,
            0.4,
            "ambiguous",
            "Choose a bucket",
            vec![],
        )
        .expect("classification");
        let outcome = store
            .archive(
                "Put this somewhere else.",
                classification,
                None,
                RustArchiveAudit::new(vec![], None, "rust-classification-v1", "test-model")
                    .expect("audit"),
            )
            .expect("pending archive");
        assert_eq!(outcome.archive_state, "needs_confirmation");
        assert!(outcome.entry_id.is_none());
        assert_eq!(store.list_archive_attempts(10).expect("attempts").len(), 1);
    }
}
