"""Export normalized extraction-persistence state for Rust service parity tests."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

TABLE_PROJECTIONS = {
    "buckets": (
        "id, title, type, status, summary, tags, created_at, last_active_at"
    ),
    "entries": (
        "id, bucket_id, raw_text, summary, content_type, "
        "classification_confidence, classification_reason, created_at, "
        "moved_from_bucket_id"
    ),
    "todos": "bucket_id, entry_id, text, status, due_date",
    "evidences": "bucket_id, entry_id, text, source",
    "timeline_events": "bucket_id, entry_id, event_time, text",
    "decisions": "bucket_id, entry_id, text, reason",
    "classification_records": (
        "id, raw_text, action, bucket_id, entry_id, confidence, reason, "
        "candidate_bucket_ids, current_focus_bucket_id, prompt_version, "
        "model_name, corrected, created_at"
    ),
    "corrections": (
        "id, command_text, action, target_type, target_id, before_json, "
        "after_json, created_at"
    ),
    "chat_messages": (
        "id, role, content, tool_name, tool_call_id, details_json, created_at"
    ),
}
ORDER_COLUMNS = {
    "todos": "bucket_id, entry_id, text, status, due_date",
    "evidences": "bucket_id, entry_id, text, source",
    "timeline_events": "bucket_id, entry_id, event_time, text",
    "decisions": "bucket_id, entry_id, text, reason",
}
JSON_COLUMNS = {
    "buckets": {5},
    "classification_records": {7},
    "corrections": {5, 6},
    "chat_messages": {5},
}


def normalized_rows(
    connection: sqlite3.Connection,
    table: str,
    columns: str,
) -> list[list[Any]]:
    """Return stable semantic rows with JSON fields parsed."""

    order = ORDER_COLUMNS.get(table, "id")
    rows = []
    for source_row in connection.execute(
        f"SELECT {columns} FROM {table} ORDER BY {order}"
    ).fetchall():
        row = list(source_row)
        for index in JSON_COLUMNS.get(table, set()):
            if row[index] is not None:
                row[index] = json.loads(row[index])
        rows.append(row)
    return rows


def export_snapshot(database_path: Path) -> dict[str, object]:
    """Return semantics excluding generated child IDs and runtime write times."""

    connection = sqlite3.connect(database_path)
    try:
        return {
            "rows": {
                table: normalized_rows(connection, table, columns)
                for table, columns in TABLE_PROJECTIONS.items()
            }
        }
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            export_snapshot(args.database_path),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
