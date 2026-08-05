"""Apply deterministic Python archive-service scenarios for Rust parity tests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Never

from app.db import get_session
from app.schemas import ClassificationResult, ExtractionResult, TimelineEventExtract
from app.services.archive_service import (
    archive_confirmed_input,
    archive_confirmed_new_input,
    archive_user_input,
)
from tests.fixtures.create_sqlite_compat_fixture import (
    ACTIVE_LATEST_ID,
    ACTIVE_TIE_NEWER_ID,
)

MODEL_NAME = "archive-service-fixture-model"
CONFIRMED_EXISTING = "confirmed_existing"
CONFIRMED_NEW = "confirmed_new"
NEEDS_CONFIRMATION = "needs_confirmation"

EXISTING_RAW_TEXT = "Payment recovery review found the callback path stable."
EXISTING_SUMMARY = "The callback path remained stable during the recovery review."
EXISTING_CONFIDENCE = 0.88
EXISTING_REASON = "The update explicitly continues the active callback incident."

NEW_RAW_TEXT = "Create a durable launch checklist for the API rollout."
NEW_TITLE = "API rollout checklist"
NEW_SUMMARY = "A durable API rollout checklist is ready to track."
NEW_CONFIDENCE = 0.93
NEW_REASON = "The user explicitly confirmed a new rollout checklist."

ASK_RAW_TEXT = "Continue that rollout item."
ASK_TITLE = "API rollout ambiguity"
ASK_CONFIDENCE = 0.42
ASK_REASON = "Multiple active Buckets could match the vague continuation."
ASK_QUESTION = "Which active Bucket should receive this update?"
ASK_CANDIDATE_IDS = [ACTIVE_LATEST_ID, ACTIVE_TIE_NEWER_ID]


def existing_extraction() -> ExtractionResult:
    """Return deterministic data for a confirmed append."""

    return ExtractionResult(
        summary=EXISTING_SUMMARY,
        todos=["Review callback dashboard."],
        evidences=["The callback error rate stayed below 0.1%."],
        timeline_events=[
            TimelineEventExtract(
                event_time="during review",
                text="The callback path stayed stable.",
            )
        ],
        decisions=["Keep the recovery dashboard for one more day."],
        hypotheses=["The proxy restart resolved the transient errors."],
        entities=["payment callback", "recovery dashboard"],
        tags=["payments", "recovery", "稳定"],
    )


def new_extraction() -> ExtractionResult:
    """Return deterministic data for a confirmed new Bucket."""

    return ExtractionResult(
        summary=NEW_SUMMARY,
        todos=["Verify the rollback owner before launch."],
        evidences=["The rollout requires a durable checklist."],
        timeline_events=[
            TimelineEventExtract(
                event_time="before launch",
                text="The rollout checklist must be verified.",
            )
        ],
        decisions=["Track the rollout in a dedicated Bucket."],
        hypotheses=["A checklist will reduce missed rollout steps."],
        entities=["API rollout"],
        tags=["api", "rollout", "checklist"],
    )


def fail_extractor(*_args: object, **_kwargs: object) -> Never:
    """Fail if an uncertain classification incorrectly invokes extraction."""

    raise AssertionError("ask_user must not invoke extraction")


def apply_scenario(database_path: Path, scenario: str) -> dict[str, object]:
    """Apply one scenario, commit it, and return a normalized ArchiveResult."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        if scenario == CONFIRMED_EXISTING:
            result = archive_confirmed_input(
                EXISTING_RAW_TEXT,
                ACTIVE_LATEST_ID,
                confidence=EXISTING_CONFIDENCE,
                reason=EXISTING_REASON,
                extractor=lambda _text, **_kwargs: existing_extraction(),
                session=session,
                model_name=MODEL_NAME,
            )
        elif scenario == CONFIRMED_NEW:
            result = archive_confirmed_new_input(
                NEW_RAW_TEXT,
                NEW_TITLE,
                "task",
                confidence=NEW_CONFIDENCE,
                reason=NEW_REASON,
                extractor=lambda _text, **_kwargs: new_extraction(),
                session=session,
                model_name=MODEL_NAME,
            )
        elif scenario == NEEDS_CONFIRMATION:
            def classifier(_text: str, _buckets: object, **_kwargs: object) -> ClassificationResult:
                return ClassificationResult(
                    action="ask_user",
                    bucket_type="task",
                    title=ASK_TITLE,
                    confidence=ASK_CONFIDENCE,
                    reason=ASK_REASON,
                    should_ask_user=True,
                    question=ASK_QUESTION,
                    candidate_bucket_ids=ASK_CANDIDATE_IDS,
                )

            result = archive_user_input(
                ASK_RAW_TEXT,
                current_focus_bucket_id=ACTIVE_LATEST_ID,
                classifier=classifier,
                extractor=fail_extractor,
                session=session,
                model_name=MODEL_NAME,
            )
        else:
            raise ValueError(f"unknown archive service scenario: {scenario}")

        session.commit()
        return normalize_result(result.model_dump(mode="json"), scenario)
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def normalize_result(payload: dict[str, object], scenario: str) -> dict[str, object]:
    """Replace generated IDs while retaining every product-visible field."""

    bucket_id = payload.pop("bucket_id")
    entry_id = payload.pop("entry_id")
    payload["bucket_id_kind"] = (
        None
        if bucket_id is None
        else "existing"
        if scenario == CONFIRMED_EXISTING
        else "generated"
    )
    payload["entry_id_present"] = entry_id is not None
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    parser.add_argument(
        "scenario",
        choices=[CONFIRMED_EXISTING, CONFIRMED_NEW, NEEDS_CONFIRMATION],
    )
    args = parser.parse_args()
    print(
        json.dumps(
            apply_scenario(args.database_path, args.scenario),
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
