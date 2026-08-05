"""Export deterministic Python Bucket-query service results for Rust parity tests."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from app.db import get_session
from app.models import Bucket, Decision, Entry, Evidence, TimelineEvent, Todo
from app.services.bucket_service import (
    get_bucket,
    get_bucket_detail,
    list_active_buckets,
)

ACTIVE_LATEST_ID = "11111111-1111-1111-1111-111111111111"
PAUSED_ID = "44444444-4444-4444-4444-444444444444"
MISSING_ID = "missing-bucket"


def timestamp(value: datetime | None) -> str | None:
    """Return the exact six-digit SQLite timestamp representation."""

    if value is None:
        return None
    return value.isoformat(sep=" ", timespec="microseconds")


def bucket_payload(bucket: Bucket) -> dict[str, Any]:
    return {
        "id": bucket.id,
        "title": bucket.title,
        "type": bucket.type.value,
        "status": bucket.status.value,
        "summary": bucket.summary,
        "tags": bucket.tags,
        "created_at": timestamp(bucket.created_at),
        "updated_at": timestamp(bucket.updated_at),
        "last_active_at": timestamp(bucket.last_active_at),
    }


def entry_payload(entry: Entry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "bucket_id": entry.bucket_id,
        "raw_text": entry.raw_text,
        "summary": entry.summary,
        "content_type": entry.content_type,
        "classification_confidence": entry.classification_confidence,
        "classification_reason": entry.classification_reason,
        "created_at": timestamp(entry.created_at),
        "moved_from_bucket_id": entry.moved_from_bucket_id,
    }


def todo_payload(todo: Todo) -> dict[str, Any]:
    return {
        "id": todo.id,
        "bucket_id": todo.bucket_id,
        "entry_id": todo.entry_id,
        "text": todo.text,
        "status": todo.status.value,
        "due_date": timestamp(todo.due_date),
        "created_at": timestamp(todo.created_at),
        "updated_at": timestamp(todo.updated_at),
    }


def evidence_payload(evidence: Evidence) -> dict[str, Any]:
    return {
        "id": evidence.id,
        "bucket_id": evidence.bucket_id,
        "entry_id": evidence.entry_id,
        "text": evidence.text,
        "source": evidence.source,
        "created_at": timestamp(evidence.created_at),
    }


def timeline_event_payload(event: TimelineEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "bucket_id": event.bucket_id,
        "entry_id": event.entry_id,
        "event_time": event.event_time,
        "text": event.text,
        "created_at": timestamp(event.created_at),
    }


def decision_payload(decision: Decision) -> dict[str, Any]:
    return {
        "id": decision.id,
        "bucket_id": decision.bucket_id,
        "entry_id": decision.entry_id,
        "text": decision.text,
        "reason": decision.reason,
        "created_at": timestamp(decision.created_at),
    }


def detail_payload(bucket: Bucket) -> dict[str, Any]:
    return {
        "bucket": bucket_payload(bucket),
        "entries": [entry_payload(entry) for entry in bucket.entries],
        "todos": [todo_payload(todo) for todo in bucket.todos],
        "evidences": [evidence_payload(item) for item in bucket.evidences],
        "timeline_events": [
            timeline_event_payload(event) for event in bucket.timeline_events
        ],
        "decisions": [decision_payload(item) for item in bucket.decisions],
    }


def export_fixture(database_path: Path) -> dict[str, Any]:
    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        active = list_active_buckets(limit=2, session=session)
        paused = get_bucket(PAUSED_ID, session=session)
        detail = get_bucket_detail(ACTIVE_LATEST_ID, session=session)
        return {
            "active": [bucket_payload(bucket) for bucket in active],
            "paused": bucket_payload(paused) if paused else None,
            "missing_bucket": get_bucket(MISSING_ID, session=session) is None,
            "detail": detail_payload(detail) if detail else None,
            "missing_detail": get_bucket_detail(MISSING_ID, session=session) is None,
        }
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    args = parser.parse_args()
    json.dump(
        export_fixture(args.database_path),
        fp=sys.stdout,
        ensure_ascii=False,
        sort_keys=True,
    )


if __name__ == "__main__":
    main()
