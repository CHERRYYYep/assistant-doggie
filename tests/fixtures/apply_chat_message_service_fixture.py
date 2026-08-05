"""Apply Python ChatMessage scenarios for Rust service parity tests."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import UUID

from app.db import get_session
from app.schemas import ChatMessageView
from app.services.agent_service import add_chat_message

APPEND_SEQUENCE = "append_sequence"
NULL_DETAILS = "null_details"
INSTALL_FAILURE_TRIGGER = "install_failure_trigger"
USER_CONTENT = "R3i parity user message."
TOOL_CONTENT = 'R3i parity tool result: {"ok": true}'
ASSISTANT_CONTENT = "R3i parity assistant message."
NULL_CONTENT = "R3i parity null details message."
TOOL_NAME = " parity_tool "
TOOL_CALL_ID = " parity-call-1 "


def is_uuid_v4(value: str) -> bool:
    """Return whether an ORM identifier is a canonical UUIDv4."""

    try:
        parsed = UUID(value)
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value.lower()


def result_payload(message: ChatMessageView) -> dict[str, Any]:
    """Normalize generated message fields while retaining product semantics."""

    return {
        "id_is_uuid_v4": is_uuid_v4(message.id),
        "role": message.role,
        "content": message.content,
        "tool_name": message.tool_name,
        "tool_call_id": message.tool_call_id,
        "details": message.details,
    }


def append_committed_message(
    database_url: str,
    role: str,
    content: str,
    *,
    tool_name: str | None = None,
    tool_call_id: str | None = None,
    details: dict[str, Any] | list[Any] | None = None,
) -> ChatMessageView:
    """Append one message using the Python service's owned-call transaction shape."""

    session = get_session(database_url)
    try:
        message = add_chat_message(
            role,
            content,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            details=details,
            session=session,
        )
        session.commit()
        return message
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def apply_scenario(database_path: Path, scenario: str) -> object:
    """Apply one deterministic Python ChatMessage scenario."""

    if scenario == INSTALL_FAILURE_TRIGGER:
        connection = sqlite3.connect(database_path)
        try:
            connection.executescript(
                """
                CREATE TRIGGER fail_chat_message_service_insert
                BEFORE INSERT ON chat_messages
                BEGIN
                    SELECT RAISE(ABORT, 'simulated chat message failure');
                END;
                """
            )
            connection.commit()
            return {"installed": True}
        finally:
            connection.close()

    database_url = f"sqlite:///{database_path.resolve()}"
    if scenario == APPEND_SEQUENCE:
        first = append_committed_message(
            database_url,
            "user",
            f"  {USER_CONTENT}  ",
        )
        duplicate = append_committed_message(
            database_url,
            "user",
            f"  {USER_CONTENT}  ",
        )
        tool = append_committed_message(
            database_url,
            "tool",
            f"  {TOOL_CONTENT}  ",
            tool_name=TOOL_NAME,
            tool_call_id=TOOL_CALL_ID,
            details={"ok": True, "matches": 2},
        )
        assistant = append_committed_message(
            database_url,
            "assistant",
            f"  {ASSISTANT_CONTENT}  ",
            details=[{"kind": "summary"}, "complete"],
        )
        return {
            "messages": [
                result_payload(first),
                result_payload(duplicate),
                result_payload(tool),
                result_payload(assistant),
            ],
            "duplicate_ids_are_distinct": first.id != duplicate.id,
        }
    if scenario == NULL_DETAILS:
        message = append_committed_message(
            database_url,
            "assistant",
            f"  {NULL_CONTENT}  ",
            details=None,
        )
        return result_payload(message)

    raise ValueError(f"unsupported chat message scenario: {scenario}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database_path", type=Path)
    parser.add_argument(
        "scenario",
        choices=[APPEND_SEQUENCE, NULL_DETAILS, INSTALL_FAILURE_TRIGGER],
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
