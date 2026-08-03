from streamlit.testing.v1 import AppTest

from app import db


def test_streamlit_mvp_renders_without_runtime_error(tmp_path, monkeypatch):
    database_url = f"sqlite:///{tmp_path / 'ui.db'}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    db._create_engine.cache_clear()

    app = AppTest.from_file("ui/streamlit_app.py").run(timeout=15)

    assert not app.exception
    assert any("Personal Work Memory Agent" in item.value for item in app.title)
    assert any("分析并归档" in item.label for item in app.button)
