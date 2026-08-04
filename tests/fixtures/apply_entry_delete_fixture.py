"""Delete one deterministic SQLAlchemy Entry for Rust parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.models import Entry

ENTRY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def apply_fixture(database_path: Path) -> None:
    """Delete the fixed Entry and commit SQLAlchemy's relationship behavior."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        entry = session.get(Entry, ENTRY_ID)
        if entry is None:
            raise LookupError(f"entry not found: {ENTRY_ID}")
        session.delete(entry)
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
