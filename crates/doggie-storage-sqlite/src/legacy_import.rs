//! One-time semantic importer from the legacy-owned SQLite schema.
//!
//! The importer deliberately reads the legacy tables directly and writes only
//! to a fresh Doggie-owned database.  It is not a compatibility writer and does
//! not alter the source database.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, DatabaseName, OpenFlags, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};

use crate::canonical_schema;
use crate::{ImportReport, StoreError, StoredTimestamp, migration, schema};

/// Import the complete semantic contents of a legacy database into a new Doggie
/// canonical database.  Source IDs are retained so correction/audit links and
/// forensic references remain useful after the import.
pub fn import_legacy_database(
    source_path: &Path,
    target_path: &Path,
) -> Result<ImportReport, StoreError> {
    let source_identity = comparable_path(source_path)?;
    let target_identity = comparable_path(target_path)?;
    if source_identity == target_identity {
        return Err(StoreError::ImportSourceTargetSame {
            path: source_identity,
        });
    }

    // Keep this exact read-only connection for validation and every import
    // query.  The read transaction below gives the whole import one stable
    // snapshot and avoids reopening a path after it has been validated.
    let mut source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    source.execute_batch("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;")?;
    let opened_read_only = source.is_readonly(DatabaseName::Main)?;
    let query_only: i64 = source.query_row("PRAGMA query_only", [], |row| row.get(0))?;
    let foreign_keys: i64 = source.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    if !(opened_read_only && query_only == 1 && foreign_keys == 1) {
        return Err(StoreError::WriteConnectionNotReady {
            opened_read_only,
            query_only: query_only == 1,
            foreign_keys: foreign_keys == 1,
        });
    }

    let source_snapshot = source.transaction_with_behavior(TransactionBehavior::Deferred)?;
    schema::validate_full_legacy_schema(&source_snapshot)?;
    migration::ensure_supported_history_if_present(&source_snapshot)?;
    validate_legacy_memory_id_namespace(&source_snapshot)?;

    let mut target = open_target(target_path)?;
    canonical_schema::enable_foreign_keys(&target)?;
    let transaction = target.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let report = import_rows(&source_snapshot, &transaction)?;
    transaction.commit()?;
    Ok(report)
}

fn import_rows(source: &Connection, target: &Transaction<'_>) -> Result<ImportReport, StoreError> {
    let mut report = ImportReport::default();
    import_buckets(source, target, &mut report)?;
    import_entries(source, target, &mut report)?;
    import_memory_items(source, target, &mut report)?;
    import_archive_attempts(source, target, &mut report)?;
    import_corrections(source, target, &mut report)?;
    import_chat_messages(source, target, &mut report)?;
    Ok(report)
}

fn import_buckets(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, title, type, status, summary, tags, created_at,
                updated_at, last_active_at
         FROM buckets
         ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let bucket_type: String = row.get(2)?;
        let status: String = row.get(3)?;
        validate_bucket_type(&id, &bucket_type)?;
        validate_bucket_status(&id, &status)?;
        let summary: String = row.get(4)?;
        let tags_raw: String = row.get(5)?;
        let tags = parse_string_list("buckets", "tags", &id, &tags_raw)?;
        let created_at: String = row.get(6)?;
        let updated_at: String = row.get(7)?;
        let last_active_at: String = row.get(8)?;
        validate_timestamp("buckets", "created_at", &id, &created_at)?;
        validate_timestamp("buckets", "updated_at", &id, &updated_at)?;
        validate_timestamp("buckets", "last_active_at", &id, &last_active_at)?;
        let archived_at = (status == "archived").then_some(updated_at.clone());

        target.execute(
            "INSERT INTO buckets
                (id, title, kind, lifecycle, summary, created_at, updated_at,
                 last_active_at, archived_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                title,
                bucket_type,
                status,
                summary,
                created_at,
                updated_at,
                last_active_at,
                archived_at,
                json!({"imported_from": "legacy", "legacy_tags_json": tags_raw}).to_string(),
            ],
        )?;

        for (position, tag) in tags.into_iter().enumerate() {
            // The legacy writer normally de-duplicates tags.  Keep the first
            // occurrence if an old hand-edited database contains duplicates;
            // the original JSON remains in bucket metadata_json above.
            target.execute(
                "INSERT OR IGNORE INTO bucket_tags(bucket_id, tag, position)
                 VALUES (?1, ?2, ?3)",
                params![
                    id,
                    tag,
                    i64::try_from(position).map_err(|_| StoreError::InvalidWriteField {
                        field: "tag_position",
                        reason: "tag position is outside SQLite integer range",
                    })?
                ],
            )?;
        }
        report.buckets += 1;
    }
    Ok(())
}

fn import_entries(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, bucket_id, raw_text, summary, content_type,
                classification_confidence, classification_reason, created_at,
                moved_from_bucket_id
         FROM entries
         ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let created_at: String = row.get(7)?;
        validate_timestamp("entries", "created_at", &id, &created_at)?;
        target.execute(
            "INSERT INTO entries
                (id, bucket_id, raw_text, summary, content_type,
                 classification_confidence, classification_reason, created_at,
                 moved_from_bucket_id, archive_state, archived_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'archived', ?8, ?10)",
            params![
                id,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                created_at,
                row.get::<_, Option<String>>(8)?,
                json!({"imported_from": "legacy"}).to_string(),
            ],
        )?;
        report.entries += 1;
    }
    Ok(())
}

fn import_memory_items(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    import_todos(source, target, report)?;
    import_evidences(source, target, report)?;
    import_timeline_events(source, target, report)?;
    import_decisions(source, target, report)?;
    Ok(())
}

fn import_todos(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, bucket_id, entry_id, text, status, due_date, created_at, updated_at
         FROM todos ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let created_at: String = row.get(6)?;
        let updated_at: String = row.get(7)?;
        validate_timestamp("todos", "created_at", &id, &created_at)?;
        validate_timestamp("todos", "updated_at", &id, &updated_at)?;
        let due_at: Option<String> = row.get(5)?;
        if let Some(value) = &due_at {
            validate_timestamp("todos", "due_date", &id, value)?;
        }
        let status: String = row.get(4)?;
        validate_todo_status(&id, &status)?;
        insert_memory_item(
            target,
            &id,
            row.get(1)?,
            row.get(2)?,
            "todo",
            row.get(3)?,
            Some(status),
            due_at,
            None,
            None,
            None,
            &created_at,
            &updated_at,
            "todos",
        )?;
        report.memory_items += 1;
    }
    Ok(())
}

fn import_evidences(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, bucket_id, entry_id, text, source, created_at
         FROM evidences ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let created_at: String = row.get(5)?;
        validate_timestamp("evidences", "created_at", &id, &created_at)?;
        insert_memory_item(
            target,
            &id,
            row.get(1)?,
            row.get(2)?,
            "evidence",
            row.get(3)?,
            None,
            None,
            None,
            row.get(4)?,
            None,
            &created_at,
            &created_at,
            "evidences",
        )?;
        report.memory_items += 1;
    }
    Ok(())
}

fn import_timeline_events(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, bucket_id, entry_id, event_time, text, created_at
         FROM timeline_events ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let created_at: String = row.get(5)?;
        validate_timestamp("timeline_events", "created_at", &id, &created_at)?;
        insert_memory_item(
            target,
            &id,
            row.get(1)?,
            row.get(2)?,
            "timeline",
            row.get(4)?,
            None,
            None,
            row.get(3)?,
            None,
            None,
            &created_at,
            &created_at,
            "timeline_events",
        )?;
        report.memory_items += 1;
    }
    Ok(())
}

fn import_decisions(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, bucket_id, entry_id, text, reason, created_at
         FROM decisions ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let created_at: String = row.get(5)?;
        validate_timestamp("decisions", "created_at", &id, &created_at)?;
        insert_memory_item(
            target,
            &id,
            row.get(1)?,
            row.get(2)?,
            "decision",
            row.get(3)?,
            None,
            None,
            None,
            None,
            row.get(4)?,
            &created_at,
            &created_at,
            "decisions",
        )?;
        report.memory_items += 1;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_memory_item(
    target: &Transaction<'_>,
    id: &str,
    bucket_id: String,
    entry_id: Option<String>,
    kind: &str,
    text: String,
    status: Option<String>,
    due_at: Option<String>,
    occurred_at: Option<String>,
    source: Option<String>,
    reason: Option<String>,
    created_at: &str,
    updated_at: &str,
    legacy_table: &str,
) -> Result<(), StoreError> {
    target.execute(
        "INSERT INTO memory_items
            (id, bucket_id, entry_id, kind, text, status, due_at, occurred_at,
             source, reason, created_at, updated_at, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            bucket_id,
            entry_id,
            kind,
            text,
            status,
            due_at,
            occurred_at,
            source,
            reason,
            created_at,
            updated_at,
            json!({"imported_from": "legacy", "legacy_table": legacy_table}).to_string(),
        ],
    )?;
    Ok(())
}

fn import_archive_attempts(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, raw_text, action, bucket_id, entry_id, confidence, reason,
                candidate_bucket_ids, current_focus_bucket_id, prompt_version,
                model_name, corrected, created_at
         FROM classification_records ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let action: String = row.get(2)?;
        validate_action(&id, &action)?;
        let candidate_json: Option<String> = row.get(7)?;
        let candidate_json = candidate_json.unwrap_or_else(|| "[]".to_owned());
        parse_string_list(
            "classification_records",
            "candidate_bucket_ids",
            &id,
            &candidate_json,
        )?;
        let corrected: i64 = row.get(11)?;
        if corrected != 0 && corrected != 1 {
            return Err(StoreError::InvalidBoolean {
                table: "classification_records",
                column: "corrected",
                record_id: id,
                value: corrected,
            });
        }
        let created_at: String = row.get(12)?;
        validate_timestamp("classification_records", "created_at", &id, &created_at)?;
        let entry_id: Option<String> = row.get(4)?;
        let archive_state = if action == "ask_user" {
            "needs_confirmation"
        } else if entry_id.is_some() {
            "archived"
        } else {
            "audit_only"
        };
        let bucket_id: Option<String> = row.get(3)?;
        // The legacy schema does not enforce classification bucket_id as a
        // foreign key.  Keep it when it resolves in the canonical target and
        // otherwise preserve the candidate/raw audit data without violating
        // the Doggie FK.
        let bucket_id = match bucket_id {
            Some(value) if target_bucket_exists(target, &value)? => Some(value),
            _ => None,
        };
        target.execute(
            "INSERT INTO archive_attempts
                (id, raw_text, action, archive_state, bucket_id, entry_id,
                 confidence, reason, question, candidate_bucket_ids_json,
                 focus_bucket_id, prompt_version, model_name, corrected,
                 created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11,
                     ?12, ?13, ?14, ?15)",
            params![
                id,
                row.get::<_, String>(1)?,
                action,
                archive_state,
                bucket_id,
                entry_id,
                row.get::<_, f64>(5)?,
                row.get::<_, String>(6)?,
                candidate_json,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                corrected,
                created_at,
                (corrected == 1).then_some(created_at.clone()),
            ],
        )?;
        report.archive_attempts += 1;
    }
    Ok(())
}

fn import_corrections(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, command_text, action, target_type, target_id,
                before_json, after_json, created_at
         FROM corrections ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let created_at: String = row.get(7)?;
        validate_timestamp("corrections", "created_at", &id, &created_at)?;
        let before_json: Option<String> = row.get(5)?;
        let after_json: Option<String> = row.get(6)?;
        validate_optional_json("corrections", "before_json", &id, before_json.as_deref())?;
        validate_optional_json("corrections", "after_json", &id, after_json.as_deref())?;
        target.execute(
            "INSERT INTO corrections
                (id, command_text, action, target_type, target_id,
                 before_json, after_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                before_json,
                after_json,
                created_at,
            ],
        )?;
        report.corrections += 1;
    }
    Ok(())
}

fn import_chat_messages(
    source: &Connection,
    target: &Transaction<'_>,
    report: &mut ImportReport,
) -> Result<(), StoreError> {
    let mut rows = source.prepare(
        "SELECT id, role, content, tool_name, tool_call_id, details_json, created_at
         FROM chat_messages ORDER BY created_at ASC, id ASC",
    )?;
    let mut mapped = rows.query([])?;
    let mut sequence = 1_i64;
    while let Some(row) = mapped.next()? {
        let id: String = row.get(0)?;
        let role: String = row.get(1)?;
        validate_chat_role(&id, &role)?;
        let created_at: String = row.get(6)?;
        validate_timestamp("chat_messages", "created_at", &id, &created_at)?;
        let details_json: Option<String> = row.get(5)?;
        validate_optional_json(
            "chat_messages",
            "details_json",
            &id,
            details_json.as_deref(),
        )?;
        target.execute(
            "INSERT INTO conversation_messages
                (id, sequence, role, content, tool_name, tool_call_id,
                 details_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                sequence,
                role,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                details_json,
                created_at,
            ],
        )?;
        sequence = sequence
            .checked_add(1)
            .ok_or(StoreError::InvalidWriteField {
                field: "chat_sequence",
                reason: "conversation sequence overflowed SQLite integer range",
            })?;
        report.chat_messages += 1;
    }
    Ok(())
}

fn open_target(path: &Path) -> Result<Connection, StoreError> {
    let connection = Connection::open(path)?;
    if canonical_schema::is_canonical(&connection)? {
        canonical_schema::validate(&connection)?;
        if canonical_schema::has_business_rows(&connection)? {
            return Err(StoreError::ImportTargetNotEmpty(path.to_owned()));
        }
        // A failed import leaves the committed canonical schema behind but
        // rolls back all business rows.  Reusing that empty shell makes a
        // failed import safely retryable without weakening the non-empty
        // target guard.
        return Ok(connection);
    }

    let non_internal_objects: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'view', 'trigger')",
        [],
        |row| row.get(0),
    )?;
    if non_internal_objects != 0 {
        return Err(StoreError::ImportTargetNotEmpty(path.to_owned()));
    }

    canonical_schema::initialize(&connection)?;
    canonical_schema::validate(&connection)?;
    Ok(connection)
}

fn validate_legacy_memory_id_namespace(source: &Connection) -> Result<(), StoreError> {
    let mut seen = HashMap::<String, &'static str>::new();
    for table in ["todos", "evidences", "timeline_events", "decisions"] {
        let query = format!("SELECT id FROM {table} ORDER BY id ASC");
        let mut statement = source.prepare(&query)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            if let Some(first_table) = seen.insert(id.clone(), table) {
                return Err(StoreError::LegacyMemoryIdCollision {
                    id,
                    first_table,
                    second_table: table,
                });
            }
        }
    }
    Ok(())
}

fn comparable_path(path: &Path) -> Result<PathBuf, StoreError> {
    if path.exists() {
        fs::canonicalize(path).map_err(|source| StoreError::Io {
            operation: "canonicalize path",
            path: path.to_owned(),
            source,
        })
    } else {
        let absolute = if path.is_absolute() {
            path.to_owned()
        } else {
            std::env::current_dir()
                .map_err(|source| StoreError::Io {
                    operation: "resolve current directory",
                    path: path.to_owned(),
                    source,
                })?
                .join(path)
        };
        Ok(absolute)
    }
}

fn target_bucket_exists(target: &Transaction<'_>, bucket_id: &str) -> Result<bool, StoreError> {
    Ok(target.query_row(
        "SELECT EXISTS(SELECT 1 FROM buckets WHERE id = ?1)",
        [bucket_id],
        |row| row.get(0),
    )?)
}

fn parse_string_list(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    raw: &str,
) -> Result<Vec<String>, StoreError> {
    let value: Value = serde_json::from_str(raw).map_err(|source| StoreError::InvalidJson {
        table,
        column,
        record_id: record_id.to_owned(),
        source,
    })?;
    let Some(items) = value.as_array() else {
        return Err(StoreError::InvalidJsonType {
            table,
            column,
            record_id: record_id.to_owned(),
            expected: "JSON array of strings",
            found: json_type_name(&value),
        });
    };
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| StoreError::InvalidJsonType {
                    table,
                    column,
                    record_id: record_id.to_owned(),
                    expected: "JSON array of strings",
                    found: json_type_name(item),
                })
        })
        .collect()
}

fn validate_optional_json(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    raw: Option<&str>,
) -> Result<(), StoreError> {
    if let Some(raw) = raw {
        serde_json::from_str::<Value>(raw).map_err(|source| StoreError::InvalidJson {
            table,
            column,
            record_id: record_id.to_owned(),
            source,
        })?;
    }
    Ok(())
}

fn validate_timestamp(
    table: &'static str,
    column: &'static str,
    record_id: &str,
    raw: &str,
) -> Result<(), StoreError> {
    StoredTimestamp::parse(table, column, record_id, raw.to_owned()).map(|_| ())
}

fn validate_bucket_type(id: &str, value: &str) -> Result<(), StoreError> {
    if matches!(
        value,
        "idea"
            | "task"
            | "incident"
            | "experiment"
            | "decision"
            | "meeting"
            | "knowledge"
            | "draft"
    ) {
        Ok(())
    } else {
        Err(StoreError::InvalidBucketType {
            bucket_id: id.to_owned(),
            value: value.to_owned(),
        })
    }
}

fn validate_bucket_status(id: &str, value: &str) -> Result<(), StoreError> {
    if matches!(value, "active" | "paused" | "done" | "archived") {
        Ok(())
    } else {
        Err(StoreError::InvalidBucketStatus {
            bucket_id: id.to_owned(),
            value: value.to_owned(),
        })
    }
}

fn validate_todo_status(id: &str, value: &str) -> Result<(), StoreError> {
    if matches!(value, "open" | "done" | "cancelled") {
        Ok(())
    } else {
        Err(StoreError::InvalidTodoStatus {
            todo_id: id.to_owned(),
            value: value.to_owned(),
        })
    }
}

fn validate_action(id: &str, value: &str) -> Result<(), StoreError> {
    if matches!(value, "append_existing" | "create_new" | "ask_user") {
        Ok(())
    } else {
        Err(StoreError::InvalidClassificationAction {
            classification_record_id: id.to_owned(),
            value: value.to_owned(),
        })
    }
}

fn validate_chat_role(id: &str, value: &str) -> Result<(), StoreError> {
    if matches!(value, "user" | "assistant" | "tool") {
        Ok(())
    } else {
        Err(StoreError::InvalidChatRole {
            chat_message_id: id.to_owned(),
            value: value.to_owned(),
        })
    }
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
