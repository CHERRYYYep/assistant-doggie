from streamlit.testing.v1 import AppTest

from app import db
from app.services.bucket_service import create_bucket


def _configure_database(tmp_path, monkeypatch, name: str) -> str:
    database_url = f"sqlite:///{tmp_path / name}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    db._create_engine.cache_clear()
    return database_url


def test_streamlit_renders_unified_conversation_and_memory(tmp_path, monkeypatch):
    _configure_database(tmp_path, monkeypatch, "unified-ui.db")

    app = AppTest.from_file("ui/streamlit_app.py").run(timeout=15)

    assert not app.exception
    assert any(item.value == "🧠 Doggie" for item in app.title)
    assert any(item.value == "💬 对话与问题解决" for item in app.subheader)
    assert any(item.value == "🗂️ Bucket 记忆" for item in app.subheader)
    assert app.chat_input[0].placeholder.startswith("向 Doggie 提问")
    assert not any(item.label == "分析并归档" for item in app.button)
    assert any("还没有 Bucket" in item.value for item in app.info)


def test_unified_memory_panel_lists_existing_bucket(tmp_path, monkeypatch):
    database_url = _configure_database(tmp_path, monkeypatch, "bucket-panel.db")
    db.init_db(database_url)
    bucket = create_bucket(
        "assistant-doggie 单会话升级",
        "task",
        summary="把回答问题和 Bucket 记忆合并到同一个对话。",
    )

    app = AppTest.from_file("ui/streamlit_app.py").run(timeout=15)

    assert not app.exception
    bucket_button = next(item for item in app.button if bucket.title in item.label)
    bucket_button.click().run(timeout=15)
    assert not app.exception
    assert app.session_state["current_bucket_id"] == bucket.id
    assert any(bucket.title in item.value for item in app.markdown)
