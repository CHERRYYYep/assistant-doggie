use std::collections::HashSet;

use rusqlite::Connection;

use crate::StoreError;

pub(crate) const REQUIRED_BUCKET_COLUMNS: &[&str] = &[
    "id",
    "title",
    "type",
    "status",
    "summary",
    "tags",
    "created_at",
    "updated_at",
    "last_active_at",
];
pub(crate) const REQUIRED_ENTRY_COLUMNS: &[&str] = &[
    "id",
    "bucket_id",
    "raw_text",
    "summary",
    "content_type",
    "classification_confidence",
    "classification_reason",
    "created_at",
    "moved_from_bucket_id",
];

const REQUIRED_TODO_COLUMNS: &[&str] = &[
    "id",
    "bucket_id",
    "entry_id",
    "text",
    "status",
    "due_date",
    "created_at",
    "updated_at",
];
const REQUIRED_EVIDENCE_COLUMNS: &[&str] = &[
    "id",
    "bucket_id",
    "entry_id",
    "text",
    "source",
    "created_at",
];
const REQUIRED_TIMELINE_EVENT_COLUMNS: &[&str] = &[
    "id",
    "bucket_id",
    "entry_id",
    "event_time",
    "text",
    "created_at",
];
const REQUIRED_DECISION_COLUMNS: &[&str] = &[
    "id",
    "bucket_id",
    "entry_id",
    "text",
    "reason",
    "created_at",
];
const REQUIRED_CLASSIFICATION_RECORD_COLUMNS: &[&str] = &[
    "id",
    "raw_text",
    "action",
    "bucket_id",
    "entry_id",
    "confidence",
    "reason",
    "candidate_bucket_ids",
    "current_focus_bucket_id",
    "prompt_version",
    "model_name",
    "corrected",
    "created_at",
];
const REQUIRED_CORRECTION_COLUMNS: &[&str] = &[
    "id",
    "command_text",
    "action",
    "target_type",
    "target_id",
    "before_json",
    "after_json",
    "created_at",
];
const REQUIRED_CHAT_MESSAGE_COLUMNS: &[&str] = &[
    "id",
    "role",
    "content",
    "tool_name",
    "tool_call_id",
    "details_json",
    "created_at",
];

const ID_PRIMARY_KEY: &[&str] = &["id"];

struct TableSpec {
    name: &'static str,
    columns: &'static [&'static str],
    primary_key: &'static [&'static str],
    indexes: &'static [IndexSpec],
    foreign_keys: &'static [ForeignKeySpec],
}

struct IndexSpec {
    name: &'static str,
    columns: &'static [&'static str],
}

struct ForeignKeySpec {
    column: &'static str,
    referenced_table: &'static str,
    referenced_column: &'static str,
    on_delete: &'static str,
}

const BUCKET_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_buckets_status_last_active_at",
        columns: &["status", "last_active_at"],
    },
    IndexSpec {
        name: "ix_buckets_type",
        columns: &["type"],
    },
    IndexSpec {
        name: "ix_buckets_status",
        columns: &["status"],
    },
    IndexSpec {
        name: "ix_buckets_updated_at",
        columns: &["updated_at"],
    },
    IndexSpec {
        name: "ix_buckets_last_active_at",
        columns: &["last_active_at"],
    },
];
const ENTRY_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_entries_bucket_created_at",
        columns: &["bucket_id", "created_at"],
    },
    IndexSpec {
        name: "ix_entries_bucket_id",
        columns: &["bucket_id"],
    },
    IndexSpec {
        name: "ix_entries_created_at",
        columns: &["created_at"],
    },
];
const TODO_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_todos_bucket_id",
        columns: &["bucket_id"],
    },
    IndexSpec {
        name: "ix_todos_entry_id",
        columns: &["entry_id"],
    },
];
const EVIDENCE_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_evidences_bucket_id",
        columns: &["bucket_id"],
    },
    IndexSpec {
        name: "ix_evidences_entry_id",
        columns: &["entry_id"],
    },
];
const TIMELINE_EVENT_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_timeline_events_bucket_id",
        columns: &["bucket_id"],
    },
    IndexSpec {
        name: "ix_timeline_events_entry_id",
        columns: &["entry_id"],
    },
];
const DECISION_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_decisions_bucket_id",
        columns: &["bucket_id"],
    },
    IndexSpec {
        name: "ix_decisions_entry_id",
        columns: &["entry_id"],
    },
];
const CLASSIFICATION_RECORD_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_classification_records_action",
        columns: &["action"],
    },
    IndexSpec {
        name: "ix_classification_records_bucket_id",
        columns: &["bucket_id"],
    },
    IndexSpec {
        name: "ix_classification_records_entry_id",
        columns: &["entry_id"],
    },
    IndexSpec {
        name: "ix_classification_records_created_at",
        columns: &["created_at"],
    },
];
const CORRECTION_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_corrections_action",
        columns: &["action"],
    },
    IndexSpec {
        name: "ix_corrections_target_id",
        columns: &["target_id"],
    },
];
const CHAT_MESSAGE_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "ix_chat_messages_role",
        columns: &["role"],
    },
    IndexSpec {
        name: "ix_chat_messages_created_at",
        columns: &["created_at"],
    },
];

const ENTRY_FOREIGN_KEYS: &[ForeignKeySpec] = &[ForeignKeySpec {
    column: "bucket_id",
    referenced_table: "buckets",
    referenced_column: "id",
    on_delete: "CASCADE",
}];
const BUCKET_ENTRY_FOREIGN_KEYS: &[ForeignKeySpec] = &[
    ForeignKeySpec {
        column: "bucket_id",
        referenced_table: "buckets",
        referenced_column: "id",
        on_delete: "CASCADE",
    },
    ForeignKeySpec {
        column: "entry_id",
        referenced_table: "entries",
        referenced_column: "id",
        on_delete: "SET NULL",
    },
];
const CLASSIFICATION_RECORD_FOREIGN_KEYS: &[ForeignKeySpec] = &[ForeignKeySpec {
    column: "entry_id",
    referenced_table: "entries",
    referenced_column: "id",
    on_delete: "SET NULL",
}];

const PYTHON_TABLES: &[TableSpec] = &[
    TableSpec {
        name: "buckets",
        columns: REQUIRED_BUCKET_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: BUCKET_INDEXES,
        foreign_keys: &[],
    },
    TableSpec {
        name: "entries",
        columns: REQUIRED_ENTRY_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: ENTRY_INDEXES,
        foreign_keys: ENTRY_FOREIGN_KEYS,
    },
    TableSpec {
        name: "todos",
        columns: REQUIRED_TODO_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: TODO_INDEXES,
        foreign_keys: BUCKET_ENTRY_FOREIGN_KEYS,
    },
    TableSpec {
        name: "evidences",
        columns: REQUIRED_EVIDENCE_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: EVIDENCE_INDEXES,
        foreign_keys: BUCKET_ENTRY_FOREIGN_KEYS,
    },
    TableSpec {
        name: "timeline_events",
        columns: REQUIRED_TIMELINE_EVENT_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: TIMELINE_EVENT_INDEXES,
        foreign_keys: BUCKET_ENTRY_FOREIGN_KEYS,
    },
    TableSpec {
        name: "decisions",
        columns: REQUIRED_DECISION_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: DECISION_INDEXES,
        foreign_keys: BUCKET_ENTRY_FOREIGN_KEYS,
    },
    TableSpec {
        name: "classification_records",
        columns: REQUIRED_CLASSIFICATION_RECORD_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: CLASSIFICATION_RECORD_INDEXES,
        foreign_keys: CLASSIFICATION_RECORD_FOREIGN_KEYS,
    },
    TableSpec {
        name: "corrections",
        columns: REQUIRED_CORRECTION_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: CORRECTION_INDEXES,
        foreign_keys: &[],
    },
    TableSpec {
        name: "chat_messages",
        columns: REQUIRED_CHAT_MESSAGE_COLUMNS,
        primary_key: ID_PRIMARY_KEY,
        indexes: CHAT_MESSAGE_INDEXES,
        foreign_keys: &[],
    },
];

pub(crate) fn table_exists(
    connection: &Connection,
    table: &'static str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, bool>(0),
    )?)
}

pub(crate) fn validate_table_columns(
    connection: &Connection,
    table: &'static str,
    required_columns: &[&'static str],
) -> Result<(), StoreError> {
    if !table_exists(connection, table)? {
        return Err(StoreError::MissingTable(table));
    }

    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&pragma)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    for column in required_columns {
        if !columns.contains(*column) {
            return Err(StoreError::MissingColumn { table, column });
        }
    }
    Ok(())
}

pub(crate) fn validate_repository_schema(connection: &Connection) -> Result<(), StoreError> {
    for table in PYTHON_TABLES {
        validate_table_columns(connection, table.name, table.columns)?;
    }
    Ok(())
}

pub(crate) fn validate_full_python_schema(connection: &Connection) -> Result<(), StoreError> {
    for table in PYTHON_TABLES {
        validate_table_columns(connection, table.name, table.columns)?;
        validate_primary_key(connection, table)?;
        for index in table.indexes {
            validate_index(connection, table.name, index)?;
        }
        for foreign_key in table.foreign_keys {
            validate_foreign_key(connection, table.name, foreign_key)?;
        }
    }
    validate_integrity(connection)
}

pub(crate) fn validate_integrity(connection: &Connection) -> Result<(), StoreError> {
    let quick_check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(StoreError::IntegrityCheckFailed(quick_check));
    }

    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    if let Some(row) = rows.next()? {
        let table: String = row.get(0)?;
        let row_id: Option<i64> = row.get(1)?;
        let parent: String = row.get(2)?;
        let foreign_key_id: i64 = row.get(3)?;
        return Err(StoreError::ForeignKeyCheckFailed {
            table,
            row_id,
            parent,
            foreign_key_id,
        });
    }
    Ok(())
}

fn validate_primary_key(connection: &Connection, table: &TableSpec) -> Result<(), StoreError> {
    validate_primary_key_columns(connection, table.name, table.primary_key)
}

pub(crate) fn validate_primary_key_columns(
    connection: &Connection,
    table: &'static str,
    expected: &'static [&'static str],
) -> Result<(), StoreError> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&pragma)?;
    let mut primary_key = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        })?
        .filter_map(|result| match result {
            Ok((0, _)) => None,
            other => Some(other),
        })
        .collect::<Result<Vec<_>, _>>()?;
    primary_key.sort_by_key(|(position, _)| *position);
    let found: Vec<String> = primary_key.into_iter().map(|(_, column)| column).collect();
    if found
        .iter()
        .map(String::as_str)
        .eq(expected.iter().copied())
    {
        Ok(())
    } else {
        Err(StoreError::InvalidPrimaryKey {
            table,
            expected,
            found,
        })
    }
}

fn validate_index(
    connection: &Connection,
    table: &'static str,
    index: &IndexSpec,
) -> Result<(), StoreError> {
    validate_index_columns(connection, table, index.name, index.columns)
}

pub(crate) fn validate_index_columns(
    connection: &Connection,
    table: &'static str,
    index_name: &'static str,
    expected: &'static [&'static str],
) -> Result<(), StoreError> {
    let exists = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_schema
            WHERE type = 'index' AND tbl_name = ?1 AND name = ?2
         )",
        [table, index_name],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        return Err(StoreError::MissingIndex {
            table,
            index: index_name,
        });
    }

    let pragma = format!("PRAGMA index_info({index_name})");
    let mut statement = connection.prepare(&pragma)?;
    let mut columns = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    columns.sort_by_key(|(position, _)| *position);
    let found: Vec<String> = columns.into_iter().map(|(_, column)| column).collect();
    if found
        .iter()
        .map(String::as_str)
        .eq(expected.iter().copied())
    {
        Ok(())
    } else {
        Err(StoreError::InvalidIndexColumns {
            table,
            index: index_name,
            expected,
            found,
        })
    }
}

fn validate_foreign_key(
    connection: &Connection,
    table: &'static str,
    expected: &ForeignKeySpec,
) -> Result<(), StoreError> {
    validate_foreign_key_reference(
        connection,
        table,
        expected.column,
        expected.referenced_table,
        expected.referenced_column,
        expected.on_delete,
    )
}

pub(crate) fn validate_foreign_key_reference(
    connection: &Connection,
    table: &'static str,
    column: &'static str,
    referenced_table: &'static str,
    referenced_column: &'static str,
    on_delete: &'static str,
) -> Result<(), StoreError> {
    let pragma = format!("PRAGMA foreign_key_list({table})");
    let mut statement = connection.prepare(&pragma)?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(6)?,
        ))
    })?;

    for row in rows {
        let (found_table, found_column, found_referenced_column, found_on_delete) = row?;
        if found_column == column
            && found_table == referenced_table
            && found_referenced_column == referenced_column
            && found_on_delete == on_delete
        {
            return Ok(());
        }
    }

    Err(StoreError::MissingForeignKey {
        table,
        column,
        referenced_table,
        referenced_column,
        on_delete,
    })
}
