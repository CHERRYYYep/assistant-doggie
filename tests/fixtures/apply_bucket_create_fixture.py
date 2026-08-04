"""Create one standalone Python Bucket for Rust service-parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.services.bucket_service import create_bucket

TITLE = "R2j standalone bucket"
SUMMARY = "Initial standalone summary."
TAGS = [" alpha ", "", "alpha", " beta "]


def apply_fixture(database_path: Path) -> None:
    """Create and commit the deterministic service input on an isolated database."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        create_bucket(
            f"  {TITLE}  ",
            "incident",
            f"  {SUMMARY}  ",
            tags=TAGS,
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
