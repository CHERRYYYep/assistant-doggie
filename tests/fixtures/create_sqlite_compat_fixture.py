"""Create a deterministic Python-owned SQLite database for Rust compatibility tests."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from app.db import get_session, init_db
from app.models import (
    Bucket,
    BucketStatus,
    BucketType,
    ChatMessage,
    ClassificationRecord,
    Correction,
    Decision,
    Entry,
    Evidence,
    TimelineEvent,
    Todo,
    TodoStatus,
)

ACTIVE_LATEST_ID = "11111111-1111-1111-1111-111111111111"
ACTIVE_TIE_NEWER_ID = "22222222-2222-2222-2222-222222222222"
ACTIVE_TIE_OLDER_ID = "33333333-3333-3333-3333-333333333333"
PAUSED_ID = "44444444-4444-4444-4444-444444444444"


def utc(hour: int, minute: int = 0, microsecond: int = 0) -> datetime:
    """Return a fixed UTC timestamp on the compatibility-fixture date."""

    return datetime(2026, 8, 4, hour, minute, 0, microsecond, tzinfo=timezone.utc)


def create_fixture(database_path: Path) -> None:
    """Create the current SQLAlchemy schema and deterministic rows for all tables."""

    if database_path.exists():
        raise FileExistsError(f"fixture database already exists: {database_path}")

    database_path.parent.mkdir(parents=True, exist_ok=True)
    database_url = f"sqlite:///{database_path}"
    init_db(database_url)

    buckets = [
        Bucket(
            id=ACTIVE_LATEST_ID,
            title="Payment callback incident",
            type=BucketType.INCIDENT,
            status=BucketStatus.ACTIVE,
            summary="Investigating callback failures.",
            tags=["payments", "callback", "支付"],
            created_at=utc(8, microsecond=123456),
            updated_at=utc(12, 15),
            last_active_at=utc(12),
        ),
        Bucket(
            id=ACTIVE_TIE_NEWER_ID,
            title="Newer tie-break update",
            type=BucketType.TASK,
            status=BucketStatus.ACTIVE,
            summary="Same activity time, newer update.",
            tags=[],
            created_at=utc(8, 5),
            updated_at=utc(11, 45),
            last_active_at=utc(11),
        ),
        Bucket(
            id=ACTIVE_TIE_OLDER_ID,
            title="Older tie-break update",
            type=BucketType.KNOWLEDGE,
            status=BucketStatus.ACTIVE,
            summary="Same activity time, older update.",
            tags=["ordering"],
            created_at=utc(8, 10),
            updated_at=utc(11, 30),
            last_active_at=utc(11),
        ),
        Bucket(
            id=PAUSED_ID,
            title="Paused newest bucket",
            type=BucketType.EXPERIMENT,
            status=BucketStatus.PAUSED,
            summary="Must not appear in active results.",
            tags=["paused"],
            created_at=utc(8, 15),
            updated_at=utc(13),
            last_active_at=utc(13),
        ),
    ]
    entries = [
        Entry(
            id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            bucket_id=ACTIVE_LATEST_ID,
            raw_text="Payment callback returned 502.",
            summary="Callback returned 502.",
            content_type="incident_update",
            classification_confidence=0.91,
            classification_reason="Matches the active callback incident.",
            created_at=utc(9, microsecond=654321),
        ),
        Entry(
            id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            bucket_id=ACTIVE_LATEST_ID,
            raw_text="Retry succeeded after the proxy restart.",
            summary=None,
            content_type="note",
            classification_confidence=None,
            classification_reason=None,
            created_at=utc(10),
            moved_from_bucket_id=PAUSED_ID,
        ),
        Entry(
            id="cccccccc-cccc-cccc-cccc-cccccccccccc",
            bucket_id=ACTIVE_TIE_NEWER_ID,
            raw_text="Prepare the compatibility review.",
            summary="Prepare review.",
            content_type="todo",
            classification_confidence=0.82,
            classification_reason="Explicit task language.",
            created_at=utc(10, 30),
        ),
    ]

    related_rows = [
        Todo(
            id="dddddddd-dddd-dddd-dddd-dddddddddddd",
            bucket_id=ACTIVE_LATEST_ID,
            entry_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            text="Confirm callback retries remain healthy.",
            status=TodoStatus.OPEN,
            due_date=utc(18),
            created_at=utc(10, 5),
            updated_at=utc(10, 10),
        ),
        Evidence(
            id="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
            bucket_id=ACTIVE_LATEST_ID,
            entry_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            text="The retry success rate returned to 99.9%.",
            source="metrics/payment-callback",
            created_at=utc(10, 15),
        ),
        TimelineEvent(
            id="ffffffff-ffff-ffff-ffff-ffffffffffff",
            bucket_id=ACTIVE_LATEST_ID,
            entry_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            event_time="2026-08-04T10:00:00Z",
            text="Proxy restarted and callback retries recovered.",
            created_at=utc(10, 20),
        ),
        Decision(
            id="12121212-1212-1212-1212-121212121212",
            bucket_id=ACTIVE_LATEST_ID,
            entry_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            text="Keep retry traffic on the recovered proxy pool.",
            reason="Error rate stayed below the rollback threshold.",
            created_at=utc(10, 25),
        ),
        ClassificationRecord(
            id="13131313-1313-1313-1313-131313131313",
            raw_text="Payment callback returned 502.",
            action="append",
            bucket_id=ACTIVE_LATEST_ID,
            entry_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            confidence=0.91,
            reason="Matches the active callback incident.",
            candidate_bucket_ids=[ACTIVE_LATEST_ID, ACTIVE_TIE_NEWER_ID],
            current_focus_bucket_id=ACTIVE_LATEST_ID,
            prompt_version="classification-v1",
            model_name="fixture-model",
            corrected=False,
            created_at=utc(9, 1),
        ),
        Correction(
            id="14141414-1414-1414-1414-141414141414",
            command_text="Move the retry note back to the incident.",
            action="move_entry",
            target_type="entry",
            target_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            before_json={"bucket_id": PAUSED_ID},
            after_json={"bucket_id": ACTIVE_LATEST_ID, "reason": "用户纠正"},
            created_at=utc(10, 2),
        ),
        ChatMessage(
            id="15151515-1515-1515-1515-151515151515",
            role="assistant",
            content="The callback incident was updated.",
            tool_name="archive_entry",
            tool_call_id="fixture-call-1",
            details_json={"bucket_id": ACTIVE_LATEST_ID, "ok": True},
            created_at=utc(10, 3),
        ),
    ]

    with get_session(database_url) as session:
        session.add_all(buckets)
        session.flush()
        session.add_all(entries)
        session.flush()
        session.add_all(related_rows)
        session.commit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    args = parser.parse_args()
    create_fixture(args.database_path.resolve())


if __name__ == "__main__":
    main()
