"""Export normalized nine-table state for Rust ChatMessage service tests."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

TABLE_PROJECTIONS = {
    "buckets": (
        "id, title, type, status, summary, tags, created_at, updated_at, "
        "last_active_at"
    ),
    "entries": (
        "id, bucket_id, raw_text, summary, content_type, "
        "classification_confidence, classification_reason, created_at, "
        "moved_from_bucket_id"
    ),
    "todos": (
        "id, bucket_id, entry_id, text, status, due_date, created_at, updated_at"
    ),
    "evidences": "id, bucket_id, entry_id, text, source, created_at",
    "timeline_events": "id, bucket_id, entry_id, event_time, text, created_at",
    "decisions": "id, bucket_id, entry_id, text, reason, created_at",
    "classification_records": (
        "id, raw_text, action, bucket_id, entry_id, confidence, reason, "
        "candidate_bucket_ids, current_focus_bucket_id, prompt_version, "
        "model_name, corrected, created_at"
    ),
    "corrections": (
        "id, command_text, action, target_type, target_id, before_json, "
        "after_json, created_at"
    ),
    "chat_messages": "role, content, tool_name, tool_call_id, details_json",
}
ORDER_COLUMNS = {
    "chat_messages": "created_at, id",
}
JSON_COLUMNS = {
    "buckets": {5},
    "classification_records": {7},
    "corrections": {5, 6},
    "chat_messages": {4},
}


def normalized_rows(
    connection: sqlite3.Connection,
    table: str,
    columns: str,
) -> list[list[Any]]:
    """Return stable rows with generated ChatMessage IDs and times removed."""

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
    """Return nine-table semantics excluding generated message IDs and times."""

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
