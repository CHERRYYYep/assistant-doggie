"""Apply Python extraction-persistence scenarios for Rust service parity tests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from uuid import UUID

from app.db import get_session
from app.schemas import ExtractionResult
from app.services.bucket_service import SavedExtraction, save_extraction
from tests.fixtures.apply_save_extraction_fixture import ENTRY_ID, fixture_extraction
from tests.fixtures.create_sqlite_compat_fixture import ACTIVE_LATEST_ID

FULL_TWICE = "full_twice"
MINIMAL = "minimal"
MINIMAL_SUMMARY = "Minimal standalone extraction summary."


def is_uuid_v4(value: str) -> bool:
    """Return whether a generated ORM identifier is a canonical UUIDv4."""

    try:
        parsed = UUID(value)
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value.lower()


def result_payload(saved: SavedExtraction) -> dict[str, object]:
    """Normalize generated child IDs while preserving result cardinality."""

    ids = [
        *(item.id for item in saved.todos),
        *(item.id for item in saved.evidences),
        *(item.id for item in saved.timeline_events),
        *(item.id for item in saved.decisions),
    ]
    return {
        "bucket_id": ACTIVE_LATEST_ID,
        "entry_id": ENTRY_ID,
        "todo_count": len(saved.todos),
        "evidence_count": len(saved.evidences),
        "timeline_event_count": len(saved.timeline_events),
        "decision_count": len(saved.decisions),
        "all_ids_are_uuid_v4": all(is_uuid_v4(value) for value in ids),
    }


def apply_scenario(database_path: Path, scenario: str) -> dict[str, object]:
    """Apply one deterministic Python service scenario and commit it."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        if scenario == FULL_TWICE:
            extraction = fixture_extraction()
            first = save_extraction(
                ACTIVE_LATEST_ID,
                ENTRY_ID,
                extraction,
                session=session,
            )
            duplicate = save_extraction(
                ACTIVE_LATEST_ID,
                ENTRY_ID,
                extraction,
                session=session,
            )
            payload: dict[str, object] = {
                "first": result_payload(first),
                "duplicate": result_payload(duplicate),
            }
        elif scenario == MINIMAL:
            saved = save_extraction(
                ACTIVE_LATEST_ID,
                ENTRY_ID,
                ExtractionResult(summary=MINIMAL_SUMMARY),
                session=session,
            )
            payload = result_payload(saved)
        else:
            raise ValueError(f"unsupported extraction persistence scenario: {scenario}")

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
    parser.add_argument("scenario", choices=[FULL_TWICE, MINIMAL])
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
