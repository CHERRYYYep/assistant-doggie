"""Append deterministic Python ChatMessage rows for Rust parity tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.db import get_session
from app.services.agent_service import add_chat_message

USER_CONTENT = "R2g parity user message."
TOOL_CONTENT = 'R2g parity tool result: {"ok": true}'
ASSISTANT_CONTENT = "R2g parity assistant message."
TOOL_NAME = " parity_tool "
TOOL_CALL_ID = " parity-call-1 "


def apply_fixture(database_path: Path) -> None:
    """Append one message for each supported role and commit them together."""

    database_url = f"sqlite:///{database_path.resolve()}"
    session = get_session(database_url)
    try:
        add_chat_message(
            "user",
            f"  {USER_CONTENT}  ",
            session=session,
        )
        add_chat_message(
            "tool",
            f"  {TOOL_CONTENT}  ",
            tool_name=TOOL_NAME,
            tool_call_id=TOOL_CALL_ID,
            details={"ok": True, "matches": 2},
            session=session,
        )
        add_chat_message(
            "assistant",
            f"  {ASSISTANT_CONTENT}  ",
            details=[{"kind": "summary"}, "complete"],
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
