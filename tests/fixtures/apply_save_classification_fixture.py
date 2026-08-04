"""Apply one deterministic Python classification-audit save for Rust parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.schemas import ClassificationResult
from app.services.classify_service import save_classification_record

RAW_TEXT = "  Callback retries stayed healthy after the proxy recovery.  "
TARGET_BUCKET_ID = "missing-audit-bucket"
CURRENT_FOCUS_BUCKET_ID = " focus-bucket "
PROMPT_VERSION = "classification-v2"
MODEL_NAME = " fixture-model "
SERVER_CANDIDATE_BUCKET_IDS = [
    "server-candidate",
    "shared",
    "server-candidate",
    "",
    " spaced ",
]


def fixture_classification() -> ClassificationResult:
    """Return one validated append classification without calling a real model."""

    return ClassificationResult(
        action="append_existing",
        bucket_id=TARGET_BUCKET_ID,
        confidence=0.87,
        reason="The note continues the callback recovery investigation.",
        candidate_bucket_ids=[" shared ", "model-candidate", "spaced", "SHARED"],
    )


def apply_fixture(database_path: Path) -> None:
    """Persist the fixed audit row and commit it."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        save_classification_record(
            RAW_TEXT,
            fixture_classification(),
            current_focus_bucket_id=CURRENT_FOCUS_BUCKET_ID,
            session=session,
            model_name=MODEL_NAME,
            candidate_bucket_ids=SERVER_CANDIDATE_BUCKET_IDS,
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
