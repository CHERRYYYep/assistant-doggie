"""Append one standalone Python Entry for Rust service-parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.services.bucket_service import append_entry

BUCKET_ID = "11111111-1111-1111-1111-111111111111"
RAW_TEXT = "R2k standalone entry."
SUMMARY = "Standalone entry summary."
CONTENT_TYPE = "log"
CONFIDENCE = 0.82
REASON = "Explicit standalone append."


def apply_fixture(database_path: Path) -> None:
    """Append and commit the deterministic service input on an isolated database."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        append_entry(
            BUCKET_ID,
            f"  {RAW_TEXT}  ",
            f"  {SUMMARY}  ",
            content_type=f"  {CONTENT_TYPE}  ",
            classification_confidence=CONFIDENCE,
            classification_reason=f"  {REASON}  ",
            session=session,
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
