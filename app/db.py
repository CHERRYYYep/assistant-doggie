"""Database engine, session, and schema initialization helpers."""

from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base

DEFAULT_DATABASE_URL = "sqlite:///./work_memory.db"


def _database_url(explicit_url: str | None = None) -> str:
    """Resolve the database URL from an argument, the environment, or a default."""

    if explicit_url:
        return explicit_url

    load_dotenv()
    return os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)


@lru_cache(maxsize=None)
def _create_engine(database_url: str) -> Engine:
    """Create and cache one engine per database URL."""

    options: dict[str, object] = {"pool_pre_ping": True}
    if database_url.startswith("sqlite"):
        options["connect_args"] = {"check_same_thread": False}
        if database_url in {"sqlite://", "sqlite:///:memory:"}:
            options["poolclass"] = StaticPool

    engine = create_engine(database_url, **options)

    if database_url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def enable_sqlite_foreign_keys(dbapi_connection, _connection_record) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


def get_engine(database_url: str | None = None) -> Engine:
    """Return the shared SQLAlchemy engine for the selected database URL."""

    return _create_engine(_database_url(database_url))


def get_session(database_url: str | None = None) -> Session:
    """Return a new database session; callers are responsible for closing it."""

    return Session(get_engine(database_url), expire_on_commit=False)


def init_db(database_url: str | None = None) -> Engine:
    """Create all currently declared tables and return the active engine."""

    engine = get_engine(database_url)
    Base.metadata.create_all(engine)
    return engine
