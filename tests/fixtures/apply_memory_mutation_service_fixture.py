"""Apply deterministic Python memory-mutation scenarios for Rust parity tests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any
from uuid import UUID

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
from app.services.bucket_service import append_entry, create_bucket
from tests.fixtures.create_sqlite_compat_fixture import ACTIVE_LATEST_ID

CREATE = "create"
APPEND = "append"
DELETE_ENTRY = "delete_entry"
DELETE_BUCKET = "delete_bucket"

CREATE_TITLE = "R3e standalone Bucket"
CREATE_SUMMARY = "Initial standalone summary."
CREATE_TAGS = [" rust ", "", "migration", "rust"]
APPEND_RAW_TEXT = "R3e standalone Entry."
APPEND_SUMMARY = "Standalone entry summary."
APPEND_CONTENT_TYPE = "log"
APPEND_CONFIDENCE = 0.82
APPEND_REASON = "Explicit standalone append."
ENTRY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def is_uuid_v4(value: str) -> bool:
    """Return whether a generated identifier is a canonical UUIDv4."""

    try:
        parsed = UUID(value)
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value


def ids_for_entry(session: Any, model: Any, entry_id: str) -> list[str]:
    """Return stable IDs whose nullable Entry link will be cleared."""

    return list(
        session.scalars(
            select(model.id).where(model.entry_id == entry_id).order_by(model.id)
        ).all()
    )


def ids_for_bucket(session: Any, model: Any, bucket_id: str) -> list[str]:
    """Return stable IDs owned by one Bucket."""

    return list(
        session.scalars(
            select(model.id).where(model.bucket_id == bucket_id).order_by(model.id)
        ).all()
    )


def apply_scenario(database_path: Path, scenario: str) -> dict[str, object]:
    """Run one Python mutation scenario and return its normalized result."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        if scenario == CREATE:
            bucket = create_bucket(
                f"  {CREATE_TITLE}  ",
                "task",
                f"  {CREATE_SUMMARY}  ",
                CREATE_TAGS,
                session=session,
            )
            payload = {
                "id_is_uuid_v4": is_uuid_v4(bucket.id),
                "title": bucket.title,
                "bucket_type": bucket.type.value,
                "status": bucket.status.value,
                "summary": bucket.summary,
                "tags": bucket.tags,
            }
        elif scenario == APPEND:
            entry = append_entry(
                ACTIVE_LATEST_ID,
                f"  {APPEND_RAW_TEXT}  ",
                f"  {APPEND_SUMMARY}  ",
                content_type=f"  {APPEND_CONTENT_TYPE}  ",
                classification_confidence=APPEND_CONFIDENCE,
                classification_reason=f"  {APPEND_REASON}  ",
                session=session,
            )
            bucket = session.get(Bucket, ACTIVE_LATEST_ID)
            if bucket is None:
                raise LookupError(f"bucket not found: {ACTIVE_LATEST_ID}")
            payload = {
                "id_is_uuid_v4": is_uuid_v4(entry.id),
                "bucket_id": entry.bucket_id,
                "raw_text": entry.raw_text,
                "summary": entry.summary,
                "content_type": entry.content_type,
                "classification_confidence": entry.classification_confidence,
                "classification_reason": entry.classification_reason,
                "moved_from_bucket_id": entry.moved_from_bucket_id,
                "activity_matches_entry": (
                    entry.created_at == bucket.updated_at == bucket.last_active_at
                ),
            }
        elif scenario == DELETE_ENTRY:
            entry = session.get(Entry, ENTRY_ID)
            if entry is None:
                raise LookupError(f"entry not found: {ENTRY_ID}")
            payload = {
                "entry_id": entry.id,
                "bucket_id": entry.bucket_id,
                "cleared_todo_ids": ids_for_entry(session, Todo, entry.id),
                "cleared_evidence_ids": ids_for_entry(session, Evidence, entry.id),
                "cleared_timeline_event_ids": ids_for_entry(
                    session, TimelineEvent, entry.id
                ),
                "cleared_decision_ids": ids_for_entry(session, Decision, entry.id),
                "cleared_classification_entry_ids": ids_for_entry(
                    session, ClassificationRecord, entry.id
                ),
            }
            session.delete(entry)
            session.flush()
        elif scenario == DELETE_BUCKET:
            bucket = session.get(Bucket, ACTIVE_LATEST_ID)
            if bucket is None:
                raise LookupError(f"bucket not found: {ACTIVE_LATEST_ID}")
            entry_ids = ids_for_bucket(session, Entry, bucket.id)
            classification_ids = list(
                session.scalars(
                    select(ClassificationRecord.id)
                    .join(Entry, Entry.id == ClassificationRecord.entry_id)
                    .where(Entry.bucket_id == bucket.id)
                    .order_by(ClassificationRecord.id)
                ).all()
            )
            payload = {
                "bucket_id": bucket.id,
                "entry_ids": entry_ids,
                "todo_ids": ids_for_bucket(session, Todo, bucket.id),
                "evidence_ids": ids_for_bucket(session, Evidence, bucket.id),
                "timeline_event_ids": ids_for_bucket(
                    session, TimelineEvent, bucket.id
                ),
                "decision_ids": ids_for_bucket(session, Decision, bucket.id),
                "cleared_classification_entry_ids": classification_ids,
            }
            session.delete(bucket)
            session.flush()
        else:
            raise ValueError(f"unsupported memory mutation scenario: {scenario}")

        session.commit()
        return payload
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


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
            apply_scenario(args.database_path, args.scenario),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
