"""Command-line entry point for initializing the local work-memory database."""

from __future__ import annotations

from app.db import init_db


def main() -> None:
    init_db()
    print("Work Memory Agent database is ready.")
    print("Start the UI with: streamlit run ui/streamlit_app.py")


if __name__ == "__main__":
    main()
