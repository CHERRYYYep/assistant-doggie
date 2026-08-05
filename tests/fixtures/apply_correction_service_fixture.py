"""Apply deterministic Python correction-service scenarios for Rust parity tests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from uuid import UUID

from sqlalchemy import select

from app.db import get_session
from app.models import ClassificationRecord
from app.services.correction_service import move_entry, move_latest_entry
from tests.fixtures.create_sqlite_compat_fixture import (
    ACTIVE_LATEST_ID,
    ACTIVE_TIE_NEWER_ID,
)

DIRECT = "direct"
LATEST_EXPLICIT = "latest_explicit"
LATEST_FROM_COMMAND = "latest_from_command"

DIRECT_ENTRY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
LATEST_ENTRY_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
DIRECT_COMMAND = "Move the callback failure into the review Bucket."
LATEST_EXPLICIT_COMMAND = "Move the latest review note into the callback incident."
LATEST_COMMAND = (
    "刚才那条不要放到 Newer tie-break update，"
    "放到 Payment callback 里。"
)


def is_uuid_v4(value: str) -> bool:
    """Return whether a generated identifier is a canonical UUIDv4."""

    try:
        parsed = UUID(value)
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value


def result_payload(correction: object, session: object) -> dict[str, object]:
    """Project the SQLAlchemy Correction into the Rust service result shape."""

    before = correction.before_json
    after = correction.after_json
    classification_ids = list(
        session.scalars(
            select(ClassificationRecord.id)
            .where(ClassificationRecord.entry_id == correction.target_id)
            .where(ClassificationRecord.corrected.is_(True))
            .order_by(ClassificationRecord.created_at, ClassificationRecord.id)
        ).all()
    )
    return {
        "correction_id_is_uuid_v4": is_uuid_v4(correction.id),
        "command_text": correction.command_text,
        "action": correction.action,
        "target_type": correction.target_type,
        "entry_id": correction.target_id,
        "source_bucket_id": before["bucket_id"],
        "target_bucket_id": after["bucket_id"],
        "todo_ids": before["todo_ids"],
        "evidence_ids": before["evidence_ids"],
        "timeline_event_ids": before["timeline_event_ids"],
        "decision_ids": before["decision_ids"],
        "corrected_classification_record_ids": classification_ids,
    }


def apply_scenario(database_path: Path, scenario: str) -> dict[str, object]:
    """Run one Python correction scenario and return its normalized result."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        if scenario == DIRECT:
            correction = move_entry(
                DIRECT_ENTRY_ID,
                ACTIVE_TIE_NEWER_ID,
                f"  {DIRECT_COMMAND}  ",
                session=session,
            )
        elif scenario == LATEST_EXPLICIT:
            correction = move_latest_entry(
                f"  {LATEST_EXPLICIT_COMMAND}  ",
                target_bucket_id=ACTIVE_LATEST_ID,
                session=session,
            )
        elif scenario == LATEST_FROM_COMMAND:
            correction = move_latest_entry(LATEST_COMMAND, session=session)
        else:
            raise ValueError(f"unsupported correction scenario: {scenario}")

        payload = result_payload(correction, session)
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
        choices=[DIRECT, LATEST_EXPLICIT, LATEST_FROM_COMMAND],
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
