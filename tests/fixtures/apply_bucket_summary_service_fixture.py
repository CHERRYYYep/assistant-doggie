"""Apply Python Bucket summary service scenarios for Rust parity tests."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from app.db import get_session
from app.models import Entry
from app.services.bucket_service import rebuild_bucket_summary, update_bucket_summary

BUCKET_ID = "11111111-1111-1111-1111-111111111111"
UPDATE = "update"
REBUILD = "rebuild"
UPDATE_FRAGMENT = (
    "Standalone service summary update with enough detail to exercise the bounded "
    "rolling summary behavior safely."
)
UPDATE_MAX_CHARS = 100
REBUILD_MAX_ENTRIES = 4
REBUILD_MAX_CHARS = 1200
REBUILD_ENTRY_FIXTURES = [
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


def seed_rebuild_entries(session) -> None:
    """Add deterministic Entry summaries used by both runtimes."""

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
        for entry_id, raw_text, summary, created_at in REBUILD_ENTRY_FIXTURES
    )
    session.flush()


def apply_scenario(
    database_path: Path,
    scenario: str,
    *,
    prepare_only: bool = False,
) -> dict[str, str | None]:
    """Prepare or apply one deterministic summary scenario."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        if scenario == UPDATE:
            summary = None
            if not prepare_only:
                summary = update_bucket_summary(
                    BUCKET_ID,
                    f"  {UPDATE_FRAGMENT}  ",
                    session=session,
                    max_chars=UPDATE_MAX_CHARS,
                )
        elif scenario == REBUILD:
            seed_rebuild_entries(session)
            summary = None
            if not prepare_only:
                summary = rebuild_bucket_summary(
                    BUCKET_ID,
                    session=session,
                    max_entries=REBUILD_MAX_ENTRIES,
                    max_chars=REBUILD_MAX_CHARS,
                )
        else:
            raise ValueError(f"unsupported Bucket summary scenario: {scenario}")

        session.commit()
        return {"summary": summary}
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    parser.add_argument("scenario", choices=[UPDATE, REBUILD])
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    print(
        json.dumps(
            apply_scenario(
                args.database_path,
                args.scenario,
                prepare_only=args.prepare_only,
            ),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
