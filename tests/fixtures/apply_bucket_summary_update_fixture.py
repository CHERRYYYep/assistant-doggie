"""Update one Python Bucket summary for Rust service-parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.services.bucket_service import update_bucket_summary

BUCKET_ID = "11111111-1111-1111-1111-111111111111"
ENTRY_SUMMARY = (
    "Standalone summary update with enough detail to exercise the bounded rolling "
    "summary behavior safely."
)
MAX_CHARS = 100


def apply_fixture(database_path: Path) -> None:
    """Update and commit the deterministic service input on an isolated database."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        update_bucket_summary(
            BUCKET_ID,
            f"  {ENTRY_SUMMARY}  ",
            session=session,
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
