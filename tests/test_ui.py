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
    assert app.chat_input[0].placeholder.startswith("向 Doggie 提问")
    assert [tab.label for tab in app.tabs[:2]] == ["💬 对话助手", "🗂️ Bucket 记忆"]


def test_pending_result_helpers_reuse_same_normalized_text():
    from ui.streamlit_app import (
        _can_reuse_pending_result,
        _fallback_bucket_title,
        _infer_bucket_type,
    )

    result = {"status": "needs_confirmation"}

    assert _can_reuse_pending_result("支付  回调失败", "支付 回调失败", result)
    assert not _can_reuse_pending_result("登录失败", "支付回调失败", result)
    assert _infer_bucket_type("支付回调持续报错 502") == "incident"
    assert _fallback_bucket_title("A" * 40).endswith("…")


def test_empty_database_pending_result_offers_first_bucket_form(tmp_path, monkeypatch):
    database_url = f"sqlite:///{tmp_path / 'first-bucket-ui.db'}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    db._create_engine.cache_clear()

    app = AppTest.from_file("ui/streamlit_app.py").run(timeout=15)
    app.session_state["pending_text"] = "整理明天发布前的检查清单"
    app.session_state["archive_result"] = {
        "status": "needs_confirmation",
        "action": "ask_user",
        "bucket_id": None,
        "bucket_title": None,
        "bucket_type": None,
        "entry_id": None,
        "confidence": 0.35,
        "reason": "当前没有已有 Bucket。",
        "question": "请确认是否创建首个 Bucket。",
        "candidate_bucket_ids": [],
        "todos": [],
        "evidences": [],
        "timeline_events": [],
        "decisions": [],
    }

    app.run(timeout=15)

    assert not app.exception
    assert any(item.label == "Bucket 标题" for item in app.text_input)
    assert any(item.label == "Bucket 类型" for item in app.selectbox)
    assert any(item.label == "创建 Bucket 并归档" for item in app.button)
