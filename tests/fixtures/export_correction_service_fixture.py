"""Export normalized correction-service database state for Rust parity tests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from app.db import get_session
from app.models import (
    Bucket,
    ChatMessage,
    ClassificationRecord,
    Correction,
    Decision,
    Entry,
    Evidence,
    TimelineEvent,
    Todo,
)
from tests.fixtures.apply_correction_service_fixture import (
    DIRECT,
    DIRECT_COMMAND,
    DIRECT_ENTRY_ID,
    LATEST_COMMAND,
    LATEST_ENTRY_ID,
    LATEST_EXPLICIT,
    LATEST_EXPLICIT_COMMAND,
    LATEST_FROM_COMMAND,
)

BUSINESS_MODELS = [
    Bucket,
    Entry,
    Todo,
    Evidence,
    TimelineEvent,
    Decision,
    ClassificationRecord,
    Correction,
    ChatMessage,
]


def enum_value(value: object) -> object:
    """Return SQLAlchemy enum values as their persisted strings."""

    return getattr(value, "value", value)


def child_rows(session: object, model: Any, entry_id: str) -> list[dict[str, object]]:
    """Return generated-ID-independent child placement for one Entry."""

    records = list(
        session.scalars(
            select(model)
            .where(model.entry_id == entry_id)
            .order_by(model.created_at, model.id)
        ).all()
    )
    return [
        {
            "id": record.id,
            "bucket_id": record.bucket_id,
            "entry_id": record.entry_id,
        }
        for record in records
    ]


def export_scenario(database_path: Path, scenario: str) -> dict[str, object]:
    """Return the semantic state produced by one correction scenario."""

    entry_id, command_text = {
        DIRECT: (DIRECT_ENTRY_ID, DIRECT_COMMAND),
        LATEST_EXPLICIT: (LATEST_ENTRY_ID, LATEST_EXPLICIT_COMMAND),
        LATEST_FROM_COMMAND: (LATEST_ENTRY_ID, LATEST_COMMAND),
    }[scenario]
    database_url = f"sqlite:///{database_path.resolve()}"
    with get_session(database_url) as session:
        correction = session.scalar(
            select(Correction)
            .where(Correction.target_type == "entry")
            .where(Correction.target_id == entry_id)
            .where(Correction.command_text == command_text)
        )
        if correction is None:
            raise LookupError(f"correction not found for scenario: {scenario}")
        entry = session.get(Entry, entry_id)
        if entry is None:
            raise LookupError(f"entry not found: {entry_id}")
        source_bucket_id = correction.before_json["bucket_id"]
        target_bucket_id = correction.after_json["bucket_id"]
        source = session.get(Bucket, source_bucket_id)
        target = session.get(Bucket, target_bucket_id)
        if source is None or target is None:
            raise LookupError("correction source and target Buckets must exist")

        classification_rows = list(
            session.scalars(
                select(ClassificationRecord)
                .where(ClassificationRecord.entry_id == entry_id)
                .order_by(ClassificationRecord.created_at, ClassificationRecord.id)
            ).all()
        )
        table_counts = {
            model.__tablename__: session.scalar(select(func.count()).select_from(model))
            for model in BUSINESS_MODELS
        }
        return {
            "source_bucket": {
                "id": source.id,
                "title": source.title,
                "type": enum_value(source.type),
                "status": enum_value(source.status),
                "summary": source.summary,
                "tags": source.tags,
            },
            "target_bucket": {
                "id": target.id,
                "title": target.title,
                "type": enum_value(target.type),
                "status": enum_value(target.status),
                "summary": target.summary,
                "tags": target.tags,
            },
            "entry": {
                "id": entry.id,
                "bucket_id": entry.bucket_id,
                "raw_text": entry.raw_text,
                "summary": entry.summary,
                "content_type": entry.content_type,
                "classification_confidence": entry.classification_confidence,
                "classification_reason": entry.classification_reason,
                "moved_from_bucket_id": entry.moved_from_bucket_id,
            },
            "todos": child_rows(session, Todo, entry_id),
            "evidences": child_rows(session, Evidence, entry_id),
            "timeline_events": child_rows(session, TimelineEvent, entry_id),
            "decisions": child_rows(session, Decision, entry_id),
            "classification_records": [
                {
                    "id": record.id,
                    "bucket_id": record.bucket_id,
                    "entry_id": record.entry_id,
                    "corrected": record.corrected,
                }
                for record in classification_rows
            ],
            "correction": {
                "command_text": correction.command_text,
                "action": correction.action,
                "target_type": correction.target_type,
                "target_id": correction.target_id,
                "before_json": correction.before_json,
                "after_json": correction.after_json,
            },
            "table_counts": table_counts,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    parser.add_argument(
        "scenario",
        choices=[DIRECT, LATEST_EXPLICIT, LATEST_FROM_COMMAND],
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
