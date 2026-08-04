"""Delete one deterministic SQLAlchemy Bucket for Rust parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.models import Bucket
from tests.fixtures.create_sqlite_compat_fixture import ACTIVE_LATEST_ID


def apply_fixture(database_path: Path) -> None:
    """Delete the fixed Bucket and commit SQLAlchemy's cascade behavior."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        bucket = session.get(Bucket, ACTIVE_LATEST_ID)
        if bucket is None:
            raise LookupError(f"bucket not found: {ACTIVE_LATEST_ID}")
        session.delete(bucket)
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
