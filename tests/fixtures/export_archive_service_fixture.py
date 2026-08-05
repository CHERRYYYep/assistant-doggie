"""Export normalized archive-service database state for Rust parity tests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.db import get_session
from app.models import (
    Bucket,
    ClassificationRecord,
    Decision,
    Entry,
    Evidence,
    TimelineEvent,
    Todo,
)
from tests.fixtures.apply_archive_service_fixture import (
    ASK_RAW_TEXT,
    CONFIRMED_EXISTING,
    CONFIRMED_NEW,
    EXISTING_RAW_TEXT,
    NEEDS_CONFIRMATION,
    NEW_RAW_TEXT,
)


def enum_value(value: object) -> object:
    """Return SQLAlchemy enum values as their persisted strings."""

    return getattr(value, "value", value)


def sorted_payload(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort generated-ID-independent child projections deterministically."""

    return sorted(
        items,
        key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True),
    )


def export_scenario(database_path: Path, scenario: str) -> dict[str, object]:
    """Return the product-visible state created by one archive scenario."""

    raw_text = {
        CONFIRMED_EXISTING: EXISTING_RAW_TEXT,
        CONFIRMED_NEW: NEW_RAW_TEXT,
        NEEDS_CONFIRMATION: ASK_RAW_TEXT,
    }[scenario]
    database_url = f"sqlite:///{database_path.resolve()}"
    with get_session(database_url) as session:
        record = session.scalar(
            select(ClassificationRecord)
            .where(ClassificationRecord.raw_text == raw_text)
            .order_by(ClassificationRecord.created_at.desc())
        )
        if record is None:
            raise LookupError(f"classification record not found for: {raw_text}")

        classification = {
            "raw_text": record.raw_text,
            "action": record.action,
            "confidence": record.confidence,
            "reason": record.reason,
            "candidate_bucket_ids": record.candidate_bucket_ids,
            "current_focus_bucket_id": record.current_focus_bucket_id,
            "prompt_version": record.prompt_version,
            "model_name": record.model_name,
            "corrected": record.corrected,
            "bucket_linked": record.bucket_id is not None,
            "entry_linked": record.entry_id is not None,
        }

        if record.entry_id is None:
            matching_entry_count = len(
                session.scalars(select(Entry).where(Entry.raw_text == raw_text)).all()
            )
            return {
                "classification": classification,
                "bucket": None,
                "entry": None,
                "todos": [],
                "evidences": [],
                "timeline_events": [],
                "decisions": [],
                "matching_entry_count": matching_entry_count,
            }

        entry = session.get(Entry, record.entry_id)
        bucket = session.get(Bucket, record.bucket_id)
        if entry is None or bucket is None:
            raise LookupError("archived classification links are incomplete")

        todos = session.scalars(select(Todo).where(Todo.entry_id == entry.id)).all()
        evidences = session.scalars(
            select(Evidence).where(Evidence.entry_id == entry.id)
        ).all()
        timeline_events = session.scalars(
            select(TimelineEvent).where(TimelineEvent.entry_id == entry.id)
        ).all()
        decisions = session.scalars(
            select(Decision).where(Decision.entry_id == entry.id)
        ).all()

        return {
            "classification": classification,
            "bucket": {
                "title": bucket.title,
                "type": enum_value(bucket.type),
                "status": enum_value(bucket.status),
                "summary": bucket.summary,
                "tags": bucket.tags,
            },
            "entry": {
                "raw_text": entry.raw_text,
                "summary": entry.summary,
                "content_type": entry.content_type,
                "classification_confidence": entry.classification_confidence,
                "classification_reason": entry.classification_reason,
                "moved_from_bucket_id": entry.moved_from_bucket_id,
            },
            "todos": sorted_payload(
                [
                    {
                        "text": todo.text,
                        "status": enum_value(todo.status),
                        "due_date": todo.due_date.isoformat() if todo.due_date else None,
                    }
                    for todo in todos
                ]
            ),
            "evidences": sorted_payload(
                [
                    {"text": evidence.text, "source": evidence.source}
                    for evidence in evidences
                ]
            ),
            "timeline_events": sorted_payload(
                [
                    {"event_time": event.event_time, "text": event.text}
                    for event in timeline_events
                ]
            ),
            "decisions": sorted_payload(
                [
                    {"text": decision.text, "reason": decision.reason}
                    for decision in decisions
                ]
            ),
            "matching_entry_count": 1,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    parser.add_argument(
        "scenario",
        choices=[CONFIRMED_EXISTING, CONFIRMED_NEW, NEEDS_CONFIRMATION],
    )
    args = parser.parse_args()
    print(
        json.dumps(
            export_scenario(args.database_path, args.scenario),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
