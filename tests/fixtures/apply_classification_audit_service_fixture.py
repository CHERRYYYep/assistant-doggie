"""Apply Python classification-audit scenarios for Rust service parity tests."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from uuid import UUID

from app.db import get_session
from app.models import ClassificationRecord
from app.schemas import ClassificationResult
from app.services.classify_service import save_classification_record
from tests.fixtures.apply_save_classification_fixture import (
    CURRENT_FOCUS_BUCKET_ID,
    MODEL_NAME,
    RAW_TEXT,
    SERVER_CANDIDATE_BUCKET_IDS,
    fixture_classification,
)

APPEND_TWICE = "append_twice"
ALL_ACTIONS = "all_actions"
INSTALL_FAILURE_TRIGGER = "install_failure_trigger"
PROMPT_VERSION = "classification-v2"
CREATE_MODEL_NAME = " create-model "
ASK_MODEL_NAME = " ask-model "
ASK_FOCUS_BUCKET_ID = " ask-focus "


def create_classification() -> ClassificationResult:
    """Return a validated create-new classification for an empty audit text."""

    return ClassificationResult(
        action="create_new",
        bucket_type="knowledge",
        title="Callback recovery notes",
        confidence=0.76,
        reason="The note establishes a standalone recovery reference.",
        candidate_bucket_ids=[" created-model ", "shared"],
    )


def ask_user_classification() -> ClassificationResult:
    """Return a validated ambiguous classification with a suggested Bucket."""

    return ClassificationResult(
        action="ask_user",
        bucket_id="suggested-bucket",
        confidence=0.41,
        reason="The intended Bucket remains ambiguous.",
        should_ask_user=True,
        question="Which Bucket should receive this note?",
        candidate_bucket_ids=["model-choice", "shared"],
    )


def is_uuid_v4(value: str) -> bool:
    """Return whether an ORM identifier is a canonical UUIDv4."""

    try:
        parsed = UUID(value)
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value.lower()


def result_payload(record: ClassificationRecord) -> dict[str, bool]:
    """Normalize one generated classification audit identifier."""

    return {"classification_record_id_is_uuid_v4": is_uuid_v4(record.id)}


def apply_scenario(database_path: Path, scenario: str) -> object:
    """Apply one deterministic Python classification-audit scenario."""

    if scenario == INSTALL_FAILURE_TRIGGER:
        connection = sqlite3.connect(database_path)
        try:
            connection.executescript(
                """
                CREATE TRIGGER fail_classification_audit_service_insert
                BEFORE INSERT ON classification_records
                BEGIN
                    SELECT RAISE(ABORT, 'simulated classification audit failure');
                END;
                """
            )
            connection.commit()
            return {"installed": True}
        finally:
            connection.close()

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        if scenario == APPEND_TWICE:
            first = save_classification_record(
                RAW_TEXT,
                fixture_classification(),
                current_focus_bucket_id=CURRENT_FOCUS_BUCKET_ID,
                session=session,
                model_name=MODEL_NAME,
                candidate_bucket_ids=SERVER_CANDIDATE_BUCKET_IDS,
            )
            duplicate = save_classification_record(
                RAW_TEXT,
                fixture_classification(),
                current_focus_bucket_id=CURRENT_FOCUS_BUCKET_ID,
                session=session,
                model_name=MODEL_NAME,
                candidate_bucket_ids=SERVER_CANDIDATE_BUCKET_IDS,
            )
            payload: object = {
                "first": result_payload(first),
                "duplicate": result_payload(duplicate),
                "ids_are_distinct": first.id != duplicate.id,
            }
        elif scenario == ALL_ACTIONS:
            created = save_classification_record(
                " \t\n ",
                create_classification(),
                current_focus_bucket_id=None,
                session=session,
                model_name=CREATE_MODEL_NAME,
                candidate_bucket_ids=["created-server", "shared"],
            )
            asked = save_classification_record(
                "  Which recovery Bucket does this belong to?  ",
                ask_user_classification(),
                current_focus_bucket_id=ASK_FOCUS_BUCKET_ID,
                session=session,
                model_name=ASK_MODEL_NAME,
                candidate_bucket_ids=["server-choice", "shared"],
            )
            payload = {
                "created": result_payload(created),
                "asked": result_payload(asked),
            }
        else:
            raise ValueError(f"unsupported classification audit scenario: {scenario}")

        session.commit()
        return payload
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    parser.add_argument(
        "scenario",
        choices=[APPEND_TWICE, ALL_ACTIONS, INSTALL_FAILURE_TRIGGER],
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
