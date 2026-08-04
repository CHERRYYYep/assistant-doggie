"""Apply one deterministic Python Entry-move correction for Rust parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.services.correction_service import move_entry
from tests.fixtures.create_sqlite_compat_fixture import ACTIVE_TIE_NEWER_ID

ENTRY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
COMMAND_TEXT = "  Move the callback failure into the review Bucket.  "


def apply_fixture(database_path: Path) -> None:
    """Move the fixed Entry into the fixed target Bucket and commit it."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        move_entry(
            ENTRY_ID,
            ACTIVE_TIE_NEWER_ID,
            COMMAND_TEXT,
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
