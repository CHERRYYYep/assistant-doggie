from sqlalchemy import inspect

from app.db import get_session, init_db


def test_init_db_creates_day_two_tables(tmp_path):
    database_url = f"sqlite:///{tmp_path / 'schema.db'}"

    engine = init_db(database_url)

    assert set(inspect(engine).get_table_names()) == {
        "buckets",
        "classification_records",
        "corrections",
        "decisions",
        "entries",
        "evidences",
        "timeline_events",
        "todos",
    }


def test_get_session_can_persist_data(tmp_path):
    database_url = f"sqlite:///{tmp_path / 'session.db'}"
    init_db(database_url)

    with get_session(database_url) as session:
        assert session.bind is not None
