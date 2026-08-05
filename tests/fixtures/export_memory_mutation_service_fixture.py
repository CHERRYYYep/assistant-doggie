"""Export normalized memory-mutation database state for Rust parity tests."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

from tests.fixtures.apply_memory_mutation_service_fixture import (
    APPEND,
    APPEND_RAW_TEXT,
    CREATE,
    CREATE_TITLE,
    DELETE_BUCKET,
    DELETE_ENTRY,
)

BUSINESS_TABLES = [
    "buckets",
    "entries",
    "todos",
    "evidences",
    "timeline_events",
    "decisions",
    "classification_records",
    "corrections",
    "chat_messages",
]

DELETE_PROJECTIONS = {
    "buckets": "id, title, type, status, summary, tags",
    "entries": (
        "id, bucket_id, raw_text, summary, content_type, "
        "classification_confidence, classification_reason, moved_from_bucket_id"
    ),
    "todos": "id, bucket_id, entry_id, text, status, due_date",
    "evidences": "id, bucket_id, entry_id, text, source",
    "timeline_events": "id, bucket_id, entry_id, event_time, text",
    "decisions": "id, bucket_id, entry_id, text, reason",
    "classification_records": (
        "id, raw_text, action, bucket_id, entry_id, confidence, reason, "
        "candidate_bucket_ids, current_focus_bucket_id, prompt_version, "
        "model_name, corrected"
    ),
    "corrections": (
        "id, command_text, action, target_type, target_id, before_json, after_json"
    ),
    "chat_messages": (
        "id, role, content, tool_name, tool_call_id, details_json"
    ),
}


def rows(
    connection: sqlite3.Connection,
    sql: str,
    parameters: tuple[Any, ...] = (),
) -> list[list[Any]]:
    """Return query rows as JSON-friendly lists."""

    return [list(row) for row in connection.execute(sql, parameters).fetchall()]


def row_counts(connection: sqlite3.Connection) -> dict[str, int]:
    """Return all business-table row counts."""

    return {
        table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in BUSINESS_TABLES
    }


def create_snapshot(connection: sqlite3.Connection) -> dict[str, object]:
    bucket = connection.execute(
        "SELECT title, type, status, summary, tags "
        "FROM buckets WHERE title = ?",
        (CREATE_TITLE,),
    ).fetchone()
    if bucket is None:
        raise LookupError(f"created bucket not found: {CREATE_TITLE}")
    bucket_id = connection.execute(
        "SELECT id FROM buckets WHERE title = ?", (CREATE_TITLE,)
    ).fetchone()[0]
    bucket_values = list(bucket)
    bucket_values[4] = json.loads(bucket_values[4])
    return {
        "counts": row_counts(connection),
        "bucket": bucket_values,
        "related_counts": {
            table: connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE bucket_id = ?", (bucket_id,)
            ).fetchone()[0]
            for table in [
                "entries",
                "todos",
                "evidences",
                "timeline_events",
                "decisions",
            ]
        },
    }


def append_snapshot(connection: sqlite3.Connection) -> dict[str, object]:
    entry = connection.execute(
        "SELECT bucket_id, raw_text, summary, content_type, "
        "classification_confidence, classification_reason, moved_from_bucket_id, "
        "created_at "
        "FROM entries WHERE raw_text = ?",
        (APPEND_RAW_TEXT,),
    ).fetchone()
    if entry is None:
        raise LookupError(f"appended Entry not found: {APPEND_RAW_TEXT}")
    bucket = connection.execute(
        "SELECT title, type, status, summary, tags, updated_at, last_active_at "
        "FROM buckets WHERE id = ?",
        (entry[0],),
    ).fetchone()
    if bucket is None:
        raise LookupError(f"target Bucket not found: {entry[0]}")
    return {
        "counts": row_counts(connection),
        "entry": list(entry[:-1]),
        "bucket": list(bucket[:-2]),
        "activity_matches_entry": entry[-1] == bucket[-2] == bucket[-1],
    }


def delete_snapshot(connection: sqlite3.Connection) -> dict[str, object]:
    return {
        "counts": row_counts(connection),
        "rows": {
            table: rows(
                connection,
                f"SELECT {columns} FROM {table} ORDER BY id",
            )
            for table, columns in DELETE_PROJECTIONS.items()
        },
    }


def export_snapshot(database_path: Path, scenario: str) -> dict[str, object]:
    """Return a runtime-ID/time-independent snapshot for one scenario."""

    connection = sqlite3.connect(database_path)
    try:
        if scenario == CREATE:
            return create_snapshot(connection)
        if scenario == APPEND:
            return append_snapshot(connection)
        if scenario in {DELETE_ENTRY, DELETE_BUCKET}:
            return delete_snapshot(connection)
        raise ValueError(f"unsupported memory mutation scenario: {scenario}")
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    parser.add_argument(
        "scenario",
        choices=[CREATE, APPEND, DELETE_ENTRY, DELETE_BUCKET],
    )
    args = parser.parse_args()
    print(
        json.dumps(
            export_snapshot(args.database_path, args.scenario),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
