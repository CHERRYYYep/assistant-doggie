"""Create deterministic Python-owned data for Rust Bucket search parity tests."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from app.db import get_session, init_db
from app.models import Bucket, BucketStatus, BucketType, Entry

EXACT_PAYMENT_ID = "01010101-0101-0101-0101-010101010101"
CONTAINS_PAYMENT_ID = "02020202-0202-0202-0202-020202020202"
UNICODE_CASEFOLD_ID = "03030303-0303-0303-0303-030303030303"
LITERAL_WILDCARD_ID = "04040404-0404-0404-0404-040404040404"
LITERAL_WILDCARD_DECOY_ID = "04141414-0414-0414-0414-041414141414"
SUMMARY_ID = "05050505-0505-0505-0505-050505050505"
TAG_ID = "06060606-0606-0606-0606-060606060606"
ENTRY_ID = "07070707-0707-0707-0707-070707070707"
TIE_FIRST_ID = "08080808-0808-0808-0808-080808080808"
TIE_SECOND_ID = "09090909-0909-0909-0909-090909090909"
UNICODE_JSON_TAG_ID = "10101010-1010-1010-1010-101010101010"


def utc(hour: int, minute: int = 0) -> datetime:
    """Return a fixed UTC timestamp on the search-fixture date."""

    return datetime(2026, 8, 5, hour, minute, tzinfo=timezone.utc)


def bucket(
    bucket_id: str,
    title: str,
    bucket_type: BucketType,
    summary: str,
    *,
    tags: list[str] | None = None,
    status: BucketStatus = BucketStatus.ACTIVE,
    last_active_at: datetime,
) -> Bucket:
    """Build one deterministic Bucket row."""

    return Bucket(
        id=bucket_id,
        title=title,
        type=bucket_type,
        status=status,
        summary=summary,
        tags=tags or [],
        created_at=utc(8),
        updated_at=last_active_at,
        last_active_at=last_active_at,
    )


def entry(
    entry_id: str,
    bucket_id: str,
    raw_text: str,
    *,
    created_at: datetime,
) -> Entry:
    """Build one deterministic Entry row."""

    return Entry(
        id=entry_id,
        bucket_id=bucket_id,
        raw_text=raw_text,
        summary=None,
        content_type="note",
        classification_confidence=None,
        classification_reason=None,
        created_at=created_at,
    )


def create_fixture(database_path: Path) -> None:
    """Create the current schema and deterministic search candidates."""

    if database_path.exists():
        raise FileExistsError(f"fixture database already exists: {database_path}")

    database_path.parent.mkdir(parents=True, exist_ok=True)
    database_url = f"sqlite:///{database_path.resolve()}"
    init_db(database_url)

    buckets = [
        bucket(
            EXACT_PAYMENT_ID,
            "payment",
            BucketType.INCIDENT,
            "Payment status dashboard",
            tags=["Payment", "critical"],
            last_active_at=utc(15),
        ),
        bucket(
            CONTAINS_PAYMENT_ID,
            "Payment callback incident",
            BucketType.INCIDENT,
            "Investigating payment failures.",
            tags=["payments", "callback"],
            last_active_at=utc(16),
        ),
        bucket(
            UNICODE_CASEFOLD_ID,
            "Straße",
            BucketType.KNOWLEDGE,
            "Unicode folding candidate.",
            last_active_at=utc(17),
        ),
        bucket(
            LITERAL_WILDCARD_ID,
            "50%_literal/path",
            BucketType.EXPERIMENT,
            "Literal wildcard regression.",
            status=BucketStatus.PAUSED,
            last_active_at=utc(18),
        ),
        bucket(
            LITERAL_WILDCARD_DECOY_ID,
            "50XYZAliteral/path",
            BucketType.EXPERIMENT,
            "Must not match escaped percent and underscore literals.",
            last_active_at=utc(18, 30),
        ),
        bucket(
            SUMMARY_ID,
            "Homepage redesign",
            BucketType.MEETING,
            "Card layout review",
            last_active_at=utc(13),
        ),
        bucket(
            TAG_ID,
            "Localization notes",
            BucketType.KNOWLEDGE,
            "Tag-only ASCII search candidate.",
            tags=["payment-tag"],
            last_active_at=utc(14),
        ),
        bucket(
            ENTRY_ID,
            "Checkout confirmation",
            BucketType.TASK,
            "Entry-only numeric search candidate.",
            last_active_at=utc(12),
        ),
        bucket(
            TIE_FIRST_ID,
            "First stable tie",
            BucketType.DRAFT,
            "same activity",
            last_active_at=utc(11),
        ),
        bucket(
            TIE_SECOND_ID,
            "Second stable tie",
            BucketType.DRAFT,
            "same activity",
            last_active_at=utc(11),
        ),
        bucket(
            UNICODE_JSON_TAG_ID,
            "Chinese localization",
            BucketType.KNOWLEDGE,
            "Serialized JSON tag behavior.",
            tags=["支付"],
            last_active_at=utc(10),
        ),
    ]
    entries = [
        entry(
            "11111111-0101-0101-0101-010101010101",
            EXACT_PAYMENT_ID,
            "PAYMENT retry succeeded.",
            created_at=utc(9),
        ),
        entry(
            "12121212-0101-0101-0101-010101010101",
            EXACT_PAYMENT_ID,
            "payment alerts remain quiet.",
            created_at=utc(10),
        ),
        entry(
            "22222222-0202-0202-0202-020202020202",
            CONTAINS_PAYMENT_ID,
            "Payment callback returned an error.",
            created_at=utc(9),
        ),
        entry(
            "23232323-0202-0202-0202-020202020202",
            CONTAINS_PAYMENT_ID,
            "Gateway returned 502.",
            created_at=utc(10),
        ),
        entry(
            "33333333-0303-0303-0303-030303030303",
            UNICODE_CASEFOLD_ID,
            "STRASSE marker keeps this candidate visible.",
            created_at=utc(9),
        ),
        entry(
            "77777777-0707-0707-0707-070707070707",
            ENTRY_ID,
            "Order confirmation returned 502.",
            created_at=utc(9),
        ),
    ]

    with get_session(database_url) as session:
        session.add_all([*buckets, *entries])
        session.commit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    args = parser.parse_args()
    create_fixture(args.database_path)


if __name__ == "__main__":
    main()
