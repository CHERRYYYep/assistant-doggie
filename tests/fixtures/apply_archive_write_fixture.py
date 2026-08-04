"""Apply one deterministic Python archive write for Rust parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.schemas import ExtractionResult, TimelineEventExtract
from app.services.archive_service import archive_confirmed_input
from tests.fixtures.create_sqlite_compat_fixture import ACTIVE_LATEST_ID

RAW_TEXT = "Payment recovery review found the callback path stable."
SUMMARY = "The callback path remained stable during the recovery review."
CONFIDENCE = 0.88
REASON = "The update explicitly continues the active callback incident."
MODEL_NAME = "fixture-model"


def fixture_extractor(_text: str, *, bucket_type: str | None = None) -> ExtractionResult:
    """Return deterministic extraction data without calling a real model."""

    assert bucket_type == "incident"
    return ExtractionResult(
        summary=SUMMARY,
        todos=[
            "Confirm callback retries remain healthy.",
            "Review callback dashboard.",
            "review   callback dashboard.",
        ],
        evidences=[
            "THE RETRY SUCCESS RATE RETURNED TO 99.9%.",
            "The callback error rate stayed below 0.1%.",
        ],
        timeline_events=[
            TimelineEventExtract(
                event_time="2026-08-04T10:00:00Z",
                text="Proxy restarted and callback retries recovered.",
            ),
            TimelineEventExtract(
                event_time="during review",
                text="The callback path stayed stable.",
            ),
        ],
        decisions=[
            "RETAIN THE EXISTING ALERT THRESHOLD.",
            "Keep the recovery dashboard for one more day.",
        ],
        hypotheses=["The proxy restart resolved the transient callback errors."],
        entities=["payment callback", "recovery dashboard"],
        tags=["Payments", "recovery", "RECOVERY", "稳定"],
    )


def apply_fixture(database_path: Path) -> None:
    """Archive the fixed input into the fixed active Bucket and commit it."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        archive_confirmed_input(
            RAW_TEXT,
            ACTIVE_LATEST_ID,
            confidence=CONFIDENCE,
            reason=REASON,
            extractor=fixture_extractor,
            session=session,
            model_name=MODEL_NAME,
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
