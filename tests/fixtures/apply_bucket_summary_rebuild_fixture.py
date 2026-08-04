"""Rebuild one Python Bucket summary for Rust service-parity tests."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from app.db import get_session
from app.models import Entry
from app.services.bucket_service import rebuild_bucket_summary

BUCKET_ID = "11111111-1111-1111-1111-111111111111"
MAX_ENTRIES = 4
MAX_CHARS = 1200
ENTRY_FIXTURES = [
    (
        "12121212-1212-4121-8121-121212121212",
        "Older duplicate summary",
        "  Duplicate fact  ",
        datetime(2026, 8, 4, 13, 0, tzinfo=timezone.utc),
    ),
    (
        "13131313-1313-4131-8131-131313131313",
        "Newer duplicate summary",
        "Duplicate fact",
        datetime(2026, 8, 4, 14, 0, tzinfo=timezone.utc),
    ),
    (
        "14141414-1414-4141-8141-141414141414",
        "Whitespace-only summary",
        "   ",
        datetime(2026, 8, 4, 15, 0, tzinfo=timezone.utc),
    ),
    (
        "15151515-1515-4151-8151-151515151515",
        "Newest summary",
        "Newest fact",
        datetime(2026, 8, 4, 16, 0, tzinfo=timezone.utc),
    ),
]


def apply_fixture(database_path: Path) -> None:
    """Seed deterministic Entries, rebuild, and commit on an isolated database."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        session.add_all(
            Entry(
                id=entry_id,
                bucket_id=BUCKET_ID,
                raw_text=raw_text,
                summary=summary,
                content_type="note",
                classification_confidence=None,
                classification_reason=None,
                created_at=created_at,
                moved_from_bucket_id=None,
            )
            for entry_id, raw_text, summary, created_at in ENTRY_FIXTURES
        )
        session.flush()
        rebuild_bucket_summary(
            BUCKET_ID,
            session=session,
            max_entries=MAX_ENTRIES,
            max_chars=MAX_CHARS,
        )
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    args = parser.parse_args()
    apply_fixture(args.database_path)


if __name__ == "__main__":
    main()
