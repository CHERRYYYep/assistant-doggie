"""Export normalized Bucket summary service state for Rust parity tests."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

from tests.fixtures.apply_bucket_summary_service_fixture import REBUILD, UPDATE

TABLE_PROJECTIONS = {
    "buckets": (
        "id, title, type, status, summary, tags, created_at, last_active_at"
    ),
    "entries": (
        "id, bucket_id, raw_text, summary, content_type, "
        "classification_confidence, classification_reason, created_at, "
        "moved_from_bucket_id"
    ),
    "todos": "id, bucket_id, entry_id, text, status, due_date, created_at",
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
    "chat_messages": (
        "id, role, content, tool_name, tool_call_id, details_json, created_at"
    ),
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
    """Return stable rows with serialized JSON fields parsed."""

    rows = []
    for source_row in connection.execute(
        f"SELECT {columns} FROM {table} ORDER BY id"
    ).fetchall():
        row = list(source_row)
        for index in JSON_COLUMNS.get(table, set()):
            if row[index] is not None:
                row[index] = json.loads(row[index])
        rows.append(row)
    return rows


def export_snapshot(database_path: Path, scenario: str) -> dict[str, object]:
    """Return database semantics excluding runtime-generated Bucket updated_at."""

    if scenario not in {UPDATE, REBUILD}:
        raise ValueError(f"unsupported Bucket summary scenario: {scenario}")

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
    parser.add_argument("scenario", choices=[UPDATE, REBUILD])
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
