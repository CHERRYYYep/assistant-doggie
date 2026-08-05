"""Export deterministic Python search-service results for Rust parity tests."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from app.db import get_session
from app.schemas import BucketSearchResult
from app.services.search_service import search_buckets

SEARCH_CASES = {
    "payment_trimmed": ("  PAYMENT  ", 3),
    "payment_limited": ("payment", 1),
    "unicode_casefold": ("STRASSE", 20),
    "literal_wildcards": ("50%_literal/path", 20),
    "summary": ("card layout", 20),
    "tag": ("payment-tag", 20),
    "entry": ("502", 20),
    "stable_tie": ("same activity", 20),
    "unicode_json_tag": ("支付", 20),
    "missing": ("does-not-exist", 20),
}


def timestamp(value: datetime) -> str:
    """Return the exact six-digit SQLite timestamp representation."""

    return value.isoformat(sep=" ", timespec="microseconds")


def result_payload(result: BucketSearchResult) -> dict[str, Any]:
    return {
        "bucket_id": result.bucket_id,
        "title": result.title,
        "bucket_type": result.bucket_type,
        "status": result.status,
        "summary": result.summary,
        "tags": result.tags,
        "last_active_at": timestamp(result.last_active_at),
        "matched_entry_count": result.matched_entry_count,
        "score": result.score,
    }


def export_fixture(database_path: Path) -> dict[str, list[dict[str, Any]]]:
    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        return {
            label: [
                result_payload(result)
                for result in search_buckets(query, limit=limit, session=session)
            ]
            for label, (query, limit) in SEARCH_CASES.items()
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
