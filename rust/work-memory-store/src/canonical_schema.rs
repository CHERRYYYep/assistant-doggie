use std::collections::HashSet;

use rusqlite::{Connection, DatabaseName};

use crate::{StoreError, schema};

pub(crate) const CANONICAL_SCHEMA_VERSION: u32 = 1;
pub(crate) const CANONICAL_SCHEMA_KIND: &str = "rust-work-memory";
pub(crate) const CANONICAL_MIGRATION_NAME: &str = "create_rust_memory_schema_v1";

const REQUIRED_TABLES: &[(&str, &[&str])] = &[
    (
        "buckets",
        &[
            "id",
            "title",
            "kind",
            "lifecycle",
            "summary",
            "created_at",
            "updated_at",
            "last_active_at",
            "archived_at",
            "metadata_json",
        ],
    ),
    (
        "entries",
        &[
            "id",
            "bucket_id",
            "raw_text",
            "summary",
            "content_type",
            "classification_confidence",
            "classification_reason",
            "created_at",
            "moved_from_bucket_id",
            "archive_state",
            "archived_at",
            "metadata_json",
        ],
    ),
    ("bucket_tags", &["bucket_id", "tag", "position"]),
    (
        "memory_items",
        &[
            "id",
            "bucket_id",
            "entry_id",
            "kind",
            "text",
            "status",
            "due_at",
            "occurred_at",
            "source",
            "reason",
            "created_at",
            "updated_at",
            "metadata_json",
        ],
    ),
    (
        "archive_attempts",
        &[
            "id",
            "raw_text",
            "action",
            "archive_state",
            "bucket_id",
            "entry_id",
            "confidence",
            "reason",
            "question",
            "candidate_bucket_ids_json",
            "focus_bucket_id",
            "prompt_version",
            "model_name",
            "corrected",
            "created_at",
            "resolved_at",
        ],
    ),
    (
        "corrections",
        &[
            "id",
            "command_text",
            "action",
            "target_type",
            "target_id",
            "before_json",
            "after_json",
            "created_at",
        ],
    ),
    (
        "conversation_messages",
        &[
            "id",
            "sequence",
            "role",
            "content",
            "tool_name",
            "tool_call_id",
            "details_json",
            "created_at",
        ],
    ),
];

const CANONICAL_TABLES: &[(&str, &[&str])] = &[
    ("rust_schema_meta", &["key", "value"]),
    ("rust_schema_migrations", &["version", "name", "applied_at"]),
    ("buckets", REQUIRED_TABLES[0].1),
    ("entries", REQUIRED_TABLES[1].1),
    ("bucket_tags", REQUIRED_TABLES[2].1),
    ("memory_items", REQUIRED_TABLES[3].1),
    ("archive_attempts", REQUIRED_TABLES[4].1),
    ("corrections", REQUIRED_TABLES[5].1),
    ("conversation_messages", REQUIRED_TABLES[6].1),
];

const CANONICAL_TABLE_NAMES: &[&str] = &[
    "rust_schema_meta",
    "rust_schema_migrations",
    "buckets",
    "entries",
    "bucket_tags",
    "memory_items",
    "archive_attempts",
    "corrections",
    "conversation_messages",
];

struct CanonicalIndexSpec {
    table: &'static str,
    name: &'static str,
    columns: &'static [&'static str],
}

const CANONICAL_INDEXES: &[CanonicalIndexSpec] = &[
    CanonicalIndexSpec {
        table: "buckets",
        name: "ix_buckets_lifecycle_activity",
        columns: &["lifecycle", "last_active_at", "updated_at"],
    },
    CanonicalIndexSpec {
        table: "buckets",
        name: "ix_buckets_kind",
        columns: &["kind"],
    },
    CanonicalIndexSpec {
        table: "entries",
        name: "ix_entries_bucket_created",
        columns: &["bucket_id", "created_at"],
    },
    CanonicalIndexSpec {
        table: "entries",
        name: "ix_entries_created",
        columns: &["created_at"],
    },
    CanonicalIndexSpec {
        table: "memory_items",
        name: "ix_memory_items_bucket_created",
        columns: &["bucket_id", "created_at"],
    },
    CanonicalIndexSpec {
        table: "memory_items",
        name: "ix_memory_items_entry",
        columns: &["entry_id"],
    },
    CanonicalIndexSpec {
        table: "memory_items",
        name: "ix_memory_items_kind",
        columns: &["kind"],
    },
    CanonicalIndexSpec {
        table: "archive_attempts",
        name: "ix_archive_attempts_state_created",
        columns: &["archive_state", "created_at"],
    },
    CanonicalIndexSpec {
        table: "archive_attempts",
        name: "ix_archive_attempts_bucket",
        columns: &["bucket_id"],
    },
    CanonicalIndexSpec {
        table: "archive_attempts",
        name: "ix_archive_attempts_entry",
        columns: &["entry_id"],
    },
    CanonicalIndexSpec {
        table: "corrections",
        name: "ix_corrections_target",
        columns: &["target_type", "target_id", "created_at"],
    },
    CanonicalIndexSpec {
        table: "conversation_messages",
        name: "ix_conversation_messages_created",
        columns: &["created_at", "sequence"],
    },
];

struct CanonicalForeignKeySpec {
    table: &'static str,
    column: &'static str,
    referenced_table: &'static str,
    referenced_column: &'static str,
    on_delete: &'static str,
}

const CANONICAL_FOREIGN_KEYS: &[CanonicalForeignKeySpec] = &[
    CanonicalForeignKeySpec {
        table: "entries",
        column: "bucket_id",
        referenced_table: "buckets",
        referenced_column: "id",
        on_delete: "CASCADE",
    },
    CanonicalForeignKeySpec {
        table: "bucket_tags",
        column: "bucket_id",
        referenced_table: "buckets",
        referenced_column: "id",
        on_delete: "CASCADE",
    },
    CanonicalForeignKeySpec {
        table: "memory_items",
        column: "bucket_id",
        referenced_table: "buckets",
        referenced_column: "id",
        on_delete: "CASCADE",
    },
    CanonicalForeignKeySpec {
        table: "memory_items",
        column: "entry_id",
        referenced_table: "entries",
        referenced_column: "id",
        on_delete: "SET NULL",
    },
    CanonicalForeignKeySpec {
        table: "archive_attempts",
        column: "bucket_id",
        referenced_table: "buckets",
        referenced_column: "id",
        on_delete: "SET NULL",
    },
    CanonicalForeignKeySpec {
        table: "archive_attempts",
        column: "entry_id",
        referenced_table: "entries",
        referenced_column: "id",
        on_delete: "SET NULL",
    },
];

struct CanonicalUniqueSpec {
    table: &'static str,
    columns: &'static [&'static str],
    name: &'static str,
}

const CANONICAL_UNIQUES: &[CanonicalUniqueSpec] = &[
    CanonicalUniqueSpec {
        table: "rust_schema_migrations",
        columns: &["name"],
        name: "name_unique",
    },
    CanonicalUniqueSpec {
        table: "bucket_tags",
        columns: &["bucket_id", "position"],
        name: "bucket_position_unique",
    },
    CanonicalUniqueSpec {
        table: "conversation_messages",
        columns: &["sequence"],
        name: "sequence_unique",
    },
];

const CANONICAL_PRIMARY_KEYS: &[(&str, &[&str])] = &[
    ("rust_schema_meta", &["key"]),
    ("rust_schema_migrations", &["version"]),
    ("buckets", &["id"]),
    ("entries", &["id"]),
    ("bucket_tags", &["bucket_id", "tag"]),
    ("memory_items", &["id"]),
    ("archive_attempts", &["id"]),
    ("corrections", &["id"]),
    ("conversation_messages", &["id"]),
];

pub(crate) fn initialize(connection: &Connection) -> Result<(), StoreError> {
    if has_table(connection, "rust_schema_meta")? || has_any_user_object(connection)? {
        return Err(StoreError::CanonicalSchemaAlreadyExists);
    }

    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         BEGIN IMMEDIATE;
         CREATE TABLE rust_schema_meta (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE rust_schema_migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL UNIQUE,
             applied_at TEXT NOT NULL
         );
         CREATE TABLE buckets (
             id TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             kind TEXT NOT NULL,
             lifecycle TEXT NOT NULL,
             summary TEXT NOT NULL DEFAULT '',
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             last_active_at TEXT NOT NULL,
             archived_at TEXT,
             metadata_json TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE entries (
             id TEXT PRIMARY KEY,
             bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
             raw_text TEXT NOT NULL,
             summary TEXT,
             content_type TEXT NOT NULL DEFAULT 'note',
             classification_confidence REAL,
             classification_reason TEXT,
             created_at TEXT NOT NULL,
             moved_from_bucket_id TEXT,
             archive_state TEXT NOT NULL DEFAULT 'archived',
             archived_at TEXT NOT NULL,
             metadata_json TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE bucket_tags (
             bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
             tag TEXT NOT NULL,
             position INTEGER NOT NULL,
             PRIMARY KEY (bucket_id, tag),
             UNIQUE (bucket_id, position)
         );
         CREATE TABLE memory_items (
             id TEXT PRIMARY KEY,
             bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
             entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
             kind TEXT NOT NULL,
             text TEXT NOT NULL,
             status TEXT,
             due_at TEXT,
             occurred_at TEXT,
             source TEXT,
             reason TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             metadata_json TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE archive_attempts (
             id TEXT PRIMARY KEY,
             raw_text TEXT NOT NULL,
             action TEXT NOT NULL,
             archive_state TEXT NOT NULL,
             bucket_id TEXT REFERENCES buckets(id) ON DELETE SET NULL,
             entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
             confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
             reason TEXT NOT NULL,
             question TEXT,
             candidate_bucket_ids_json TEXT NOT NULL DEFAULT '[]',
             focus_bucket_id TEXT,
             prompt_version TEXT NOT NULL,
             model_name TEXT NOT NULL,
             corrected INTEGER NOT NULL DEFAULT 0 CHECK (corrected IN (0, 1)),
             created_at TEXT NOT NULL,
             resolved_at TEXT
         );
         CREATE TABLE corrections (
             id TEXT PRIMARY KEY,
             command_text TEXT NOT NULL,
             action TEXT NOT NULL,
             target_type TEXT NOT NULL,
             target_id TEXT NOT NULL,
             before_json TEXT,
             after_json TEXT,
             created_at TEXT NOT NULL
         );
         CREATE TABLE conversation_messages (
             id TEXT PRIMARY KEY,
             sequence INTEGER NOT NULL UNIQUE,
             role TEXT NOT NULL,
             content TEXT NOT NULL,
             tool_name TEXT,
             tool_call_id TEXT,
             details_json TEXT,
             created_at TEXT NOT NULL
         );
         CREATE INDEX ix_buckets_lifecycle_activity
             ON buckets(lifecycle, last_active_at DESC, updated_at DESC);
         CREATE INDEX ix_buckets_kind ON buckets(kind);
         CREATE INDEX ix_entries_bucket_created ON entries(bucket_id, created_at ASC);
         CREATE INDEX ix_entries_created ON entries(created_at ASC);
         CREATE INDEX ix_memory_items_bucket_created
             ON memory_items(bucket_id, created_at ASC);
         CREATE INDEX ix_memory_items_entry ON memory_items(entry_id);
         CREATE INDEX ix_memory_items_kind ON memory_items(kind);
         CREATE INDEX ix_archive_attempts_state_created
             ON archive_attempts(archive_state, created_at DESC);
         CREATE INDEX ix_archive_attempts_bucket ON archive_attempts(bucket_id);
         CREATE INDEX ix_archive_attempts_entry ON archive_attempts(entry_id);
         CREATE INDEX ix_corrections_target ON corrections(target_type, target_id, created_at ASC);
         CREATE INDEX ix_conversation_messages_created
             ON conversation_messages(created_at ASC, sequence ASC);
         INSERT INTO rust_schema_meta(key, value)
             VALUES ('schema_kind', 'rust-work-memory'),
                    ('schema_version', '1');
         INSERT INTO rust_schema_migrations(version, name, applied_at)
             VALUES (1, 'create_rust_memory_schema_v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
         COMMIT;",
    )?;
    Ok(())
}

/// Enable foreign-key enforcement on every writable canonical connection.
///
/// SQLite treats `foreign_keys` as a per-connection setting and silently
/// ignores attempts to change it while a transaction is active.  Callers use
/// this before beginning any write transaction, then this helper verifies the
/// resulting state instead of assuming the pragma took effect.
pub(crate) fn enable_foreign_keys(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    let foreign_keys: i64 = connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    if foreign_keys != 1 {
        return Err(StoreError::WriteConnectionNotReady {
            opened_read_only: connection.is_readonly(DatabaseName::Main)?,
            query_only: connection
                .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))?
                == 1,
            foreign_keys: false,
        });
    }
    Ok(())
}

/// Return whether the canonical business tables contain any rows.
pub(crate) fn has_business_rows(connection: &Connection) -> Result<bool, StoreError> {
    let rows: i64 = connection.query_row(
        "SELECT
             (SELECT COUNT(*) FROM buckets)
           + (SELECT COUNT(*) FROM bucket_tags)
           + (SELECT COUNT(*) FROM entries)
           + (SELECT COUNT(*) FROM memory_items)
           + (SELECT COUNT(*) FROM archive_attempts)
           + (SELECT COUNT(*) FROM corrections)
           + (SELECT COUNT(*) FROM conversation_messages)",
        [],
        |row| row.get(0),
    )?;
    Ok(rows > 0)
}

pub(crate) fn validate(connection: &Connection) -> Result<(), StoreError> {
    let kind: String = connection
        .query_row(
            "SELECT value FROM rust_schema_meta WHERE key = 'schema_kind'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| StoreError::CanonicalSchemaMarkerMissing)?;
    if kind != CANONICAL_SCHEMA_KIND {
        return Err(StoreError::CanonicalSchemaKindMismatch { found: kind });
    }

    let version: String = connection
        .query_row(
            "SELECT value FROM rust_schema_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| StoreError::CanonicalSchemaMarkerMissing)?;
    let version = version
        .parse::<u32>()
        .map_err(|_| StoreError::CanonicalSchemaVersionInvalid(version))?;
    if version != CANONICAL_SCHEMA_VERSION {
        return Err(StoreError::UnsupportedCanonicalSchemaVersion {
            found: version,
            supported: CANONICAL_SCHEMA_VERSION,
        });
    }

    validate_object_whitelist(connection)?;
    for (table, columns) in CANONICAL_TABLES {
        validate_table_columns(connection, table, columns)?;
    }
    for (table, columns) in CANONICAL_PRIMARY_KEYS {
        schema::validate_primary_key_columns(connection, table, columns)?;
    }
    for index in CANONICAL_INDEXES {
        schema::validate_index_columns(connection, index.table, index.name, index.columns)?;
    }
    validate_unique_constraints(connection)?;
    validate_foreign_keys(connection)?;
    validate_archive_checks(connection)?;
    validate_schema_metadata(connection)?;
    validate_migration_history(connection)?;
    validate_integrity(connection)
}

fn validate_object_whitelist(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection.prepare(
        "SELECT type, name, tbl_name
         FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'
           AND type IN ('table', 'index', 'view', 'trigger')
         ORDER BY type, name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;

    for row in rows {
        let (object_type, name, table_name) = row?;
        let expected = match object_type.as_str() {
            "table" => CANONICAL_TABLE_NAMES.contains(&name.as_str()),
            "index" => CANONICAL_INDEXES
                .iter()
                .any(|index| index.table == table_name && index.name == name),
            _ => false,
        };
        if !expected {
            let object_name = if object_type == "index" {
                format!("{table_name}.{name}")
            } else {
                name
            };
            return Err(StoreError::UnexpectedCanonicalObject {
                object_type,
                name: object_name,
            });
        }
    }
    Ok(())
}

fn validate_table_columns(
    connection: &Connection,
    table: &'static str,
    expected: &'static [&'static str],
) -> Result<(), StoreError> {
    if !has_table(connection, table)? {
        return Err(StoreError::MissingTable(table));
    }

    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&pragma)?;
    let found = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    for column in expected {
        if !found.iter().any(|value| value == column) {
            return Err(StoreError::MissingColumn { table, column });
        }
    }

    if found.len() != expected.len() {
        let expected: HashSet<&str> = expected.iter().copied().collect();
        if let Some(column) = found
            .iter()
            .find(|column| !expected.contains(column.as_str()))
        {
            return Err(StoreError::UnexpectedCanonicalObject {
                object_type: "column".to_owned(),
                name: format!("{table}.{column}"),
            });
        }
    }
    Ok(())
}

fn validate_unique_constraints(connection: &Connection) -> Result<(), StoreError> {
    for table in CANONICAL_TABLE_NAMES {
        let expected: Vec<&CanonicalUniqueSpec> = CANONICAL_UNIQUES
            .iter()
            .filter(|constraint| constraint.table == *table)
            .collect();
        let found = unique_index_columns(connection, table)?;

        for constraint in &expected {
            if !found.iter().any(|(_, columns)| {
                columns
                    .iter()
                    .map(String::as_str)
                    .eq(constraint.columns.iter().copied())
            }) {
                return Err(StoreError::MissingCanonicalConstraint {
                    table: constraint.table,
                    constraint: constraint.name,
                });
            }
        }
        if found.len() > expected.len() {
            let (_, columns) = &found[expected.len()];
            return Err(StoreError::UnexpectedCanonicalObject {
                object_type: "unique constraint".to_owned(),
                name: format!("{table} ({columns:?})"),
            });
        }
    }
    Ok(())
}

fn unique_index_columns(
    connection: &Connection,
    table: &str,
) -> Result<Vec<(String, Vec<String>)>, StoreError> {
    let pragma = format!("PRAGMA index_list({table})");
    let mut statement = connection.prepare(&pragma)?;
    let indexes = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    indexes
        .into_iter()
        .filter(|(_, unique, origin)| *unique == 1 && origin == "u")
        .map(|(name, _, _)| {
            let pragma = format!("PRAGMA index_info({name})");
            let mut statement = connection.prepare(&pragma)?;
            let mut columns = statement
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            columns.sort_by_key(|(position, _)| *position);
            Ok((
                name,
                columns
                    .into_iter()
                    .map(|(_, column)| column.unwrap_or_else(|| "<expression>".to_owned()))
                    .collect(),
            ))
        })
        .collect()
}

fn validate_foreign_keys(connection: &Connection) -> Result<(), StoreError> {
    for table in CANONICAL_TABLE_NAMES {
        let expected: Vec<&CanonicalForeignKeySpec> = CANONICAL_FOREIGN_KEYS
            .iter()
            .filter(|foreign_key| foreign_key.table == *table)
            .collect();
        let found = foreign_key_count(connection, table)?;

        for foreign_key in &expected {
            schema::validate_foreign_key_reference(
                connection,
                foreign_key.table,
                foreign_key.column,
                foreign_key.referenced_table,
                foreign_key.referenced_column,
                foreign_key.on_delete,
            )?;
        }
        if found != expected.len() {
            return Err(StoreError::UnexpectedCanonicalObject {
                object_type: "foreign key".to_owned(),
                name: format!("{table} ({found} found, {} expected)", expected.len()),
            });
        }
    }
    Ok(())
}

fn foreign_key_count(connection: &Connection, table: &str) -> Result<usize, StoreError> {
    let pragma = format!("PRAGMA foreign_key_list({table})");
    let mut statement = connection.prepare(&pragma)?;
    Ok(statement
        .query_map([], |_| Ok(()))?
        .collect::<Result<Vec<_>, _>>()?
        .len())
}

fn validate_archive_checks(connection: &Connection) -> Result<(), StoreError> {
    const EXPECTED: &[(&str, &str)] = &[
        ("confidence_range", "confidence>=0andconfidence<=1"),
        ("corrected_boolean", "correctedin(0,1)"),
    ];
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'archive_attempts'",
        [],
        |row| row.get(0),
    )?;
    let found: HashSet<String> = extract_check_expressions(&sql)
        .into_iter()
        .map(|expression| normalize_sql_fragment(&expression))
        .collect();

    for (name, expression) in EXPECTED {
        if !found.contains(*expression) {
            return Err(StoreError::MissingCanonicalConstraint {
                table: "archive_attempts",
                constraint: name,
            });
        }
    }
    if found.len() > EXPECTED.len() {
        return Err(StoreError::UnexpectedCanonicalObject {
            object_type: "check constraint".to_owned(),
            name: format!("archive_attempts ({found:?})"),
        });
    }
    Ok(())
}

fn extract_check_expressions(sql: &str) -> Vec<String> {
    let lower = sql.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut expressions = Vec::new();
    let mut offset = 0;

    while offset < bytes.len() {
        let Some(relative) = lower[offset..].find("check") else {
            break;
        };
        let start = offset + relative;
        let before_is_identifier = start > 0 && is_sql_identifier_byte(bytes[start - 1]);
        let after = start + "check".len();
        let after_is_identifier = after < bytes.len() && is_sql_identifier_byte(bytes[after]);
        if before_is_identifier || after_is_identifier {
            offset = after;
            continue;
        }

        let mut cursor = after;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'(' {
            offset = cursor.saturating_add(1);
            continue;
        }

        let expression_start = cursor + 1;
        let mut depth = 1usize;
        let mut quote: Option<u8> = None;
        let mut index = expression_start;
        while index < bytes.len() {
            let byte = bytes[index];
            if let Some(quote_byte) = quote {
                if byte == quote_byte {
                    if index + 1 < bytes.len() && bytes[index + 1] == quote_byte {
                        index += 2;
                        continue;
                    }
                    quote = None;
                }
            } else if matches!(byte, b'\'' | b'"' | b'`') {
                quote = Some(byte);
            } else if byte == b'(' {
                depth += 1;
            } else if byte == b')' {
                depth -= 1;
                if depth == 0 {
                    expressions.push(sql[expression_start..index].to_owned());
                    offset = index + 1;
                    break;
                }
            }
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
    }
    expressions
}

fn is_sql_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn normalize_sql_fragment(fragment: &str) -> String {
    fragment
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect()
}

fn validate_schema_metadata(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection.prepare("SELECT key FROM rust_schema_meta ORDER BY key")?;
    let keys = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if keys.len() != 2 {
        if let Some(key) = keys
            .iter()
            .find(|key| !matches!(key.as_str(), "schema_kind" | "schema_version"))
        {
            return Err(StoreError::UnexpectedCanonicalObject {
                object_type: "schema metadata".to_owned(),
                name: key.clone(),
            });
        }
        return Err(StoreError::CanonicalSchemaMarkerMissing);
    }
    Ok(())
}

fn validate_migration_history(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection
        .prepare("SELECT version, name FROM rust_schema_migrations ORDER BY version ASC")?;
    let migrations = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if migrations.len() != 1 {
        if migrations.is_empty() {
            return Err(StoreError::CanonicalMigrationMismatch {
                version: 0,
                name: "<missing>".to_owned(),
            });
        }
        return Err(StoreError::UnexpectedCanonicalObject {
            object_type: "migration record".to_owned(),
            name: format!("{} records", migrations.len()),
        });
    }
    let (version, name) = &migrations[0];
    if *version != i64::from(CANONICAL_SCHEMA_VERSION) || name != CANONICAL_MIGRATION_NAME {
        return Err(StoreError::CanonicalMigrationMismatch {
            version: *version,
            name: name.clone(),
        });
    }
    Ok(())
}

pub(crate) fn is_canonical(connection: &Connection) -> Result<bool, StoreError> {
    if !has_table(connection, "rust_schema_meta")? {
        return Ok(false);
    }
    let kind = connection.query_row(
        "SELECT value FROM rust_schema_meta WHERE key = 'schema_kind'",
        [],
        |row| row.get::<_, String>(0),
    );
    Ok(matches!(kind, Ok(value) if value == CANONICAL_SCHEMA_KIND))
}

fn has_table(connection: &Connection, table: &str) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1
         )",
        [table],
        |row| row.get(0),
    )?)
}

fn has_any_user_object(connection: &Connection) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
               AND type IN ('table', 'index', 'view', 'trigger')
         )",
        [],
        |row| row.get(0),
    )?)
}

fn validate_integrity(connection: &Connection) -> Result<(), StoreError> {
    let quick_check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(StoreError::IntegrityCheckFailed(quick_check));
    }
    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    if let Some(row) = rows.next()? {
        return Err(StoreError::ForeignKeyCheckFailed {
            table: row.get(0)?,
            row_id: row.get(1)?,
            parent: row.get(2)?,
            foreign_key_id: row.get(3)?,
        });
    }
    Ok(())
}
