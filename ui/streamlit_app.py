"""Streamlit interface with a persistent chat area and memory sidebar."""

from __future__ import annotations

import sys
from pathlib import Path

import streamlit as st

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.db import init_db
from app.models import Bucket
from app.schemas import ChatMessageView
from app.services.agent_service import list_chat_messages, run_agent_turn
from app.services.bucket_service import get_bucket_detail, list_active_buckets
from app.services.correction_service import move_latest_entry
from app.services.search_service import search_buckets
from app.services.view_service import bucket_detail_view

_TOOL_LABELS = {
    "list_active_buckets": "读取活跃 Bucket",
    "search_memory": "搜索 Bucket 记忆",
    "get_bucket_detail": "读取 Bucket 详情",
    "archive_memory": "自动整理并写入记忆",
    "save_to_existing_bucket": "写入已有 Bucket",
    "create_bucket_and_save": "创建 Bucket 并写入",
}


def _tool_activity_label(message: ChatMessageView) -> str:
    """Return a concise user-facing label for one persisted tool call."""

    action = _TOOL_LABELS.get(message.tool_name or "", message.tool_name or "工具")
    output = message.details.get("output") if isinstance(message.details, dict) else None
    succeeded = not isinstance(output, dict) or output.get("ok", True)
    marker = "✅" if succeeded else "⚠️"
    return f"{marker} {action}"


def _show_chat_timeline() -> None:
    """Render the singleton conversation and its memory activity inline."""

    messages = list_chat_messages(limit=200)
    if not messages:
        st.info(
            "直接开始对话即可。Doggie 每轮都会读取活跃 Bucket 概览，并自动判断哪些工作信息值得长期保存。"
        )
        return

    for message in messages:
        if message.role == "tool":
            with st.expander(_tool_activity_label(message), expanded=False):
                if message.details is not None:
                    st.json(message.details)
                else:
                    st.code(message.content)
            continue
        with st.chat_message(message.role):
            st.markdown(message.content)


def _write_empty_or_items(items: list[dict[str, object]], empty_text: str) -> None:
    """Render compact Bucket detail records inside the narrow sidebar."""

    if not items:
        st.caption(empty_text)
        return
    for item in items:
        st.write(f"- {item['text']}")


def _show_bucket_detail(bucket_id: str) -> None:
    """Render the selected Bucket in collapsible sidebar sections."""

    detail = get_bucket_detail(bucket_id)
    if detail is None:
        st.error("Bucket 不存在或已删除。")
        return

    data = bucket_detail_view(detail)
    st.markdown(f"#### {data['title']}")
    st.caption(
        f"{data['type']} · {data['status']} · 最近更新 {data['last_active_at']}"
    )
    st.write(data["summary"] or "暂无摘要")
    if data["tags"]:
        st.caption("标签：" + " · ".join(data["tags"]))

    with st.expander(f"Todo · {len(data['todos'])}", expanded=True):
        if not data["todos"]:
            st.caption("暂无 Todo")
        for item in data["todos"]:
            st.write(f"- [{item['status']}] {item['text']}")

    with st.expander(f"证据 · {len(data['evidences'])}"):
        _write_empty_or_items(data["evidences"], "暂无证据")

    with st.expander(f"决策 · {len(data['decisions'])}"):
        _write_empty_or_items(data["decisions"], "暂无决策")

    with st.expander(f"时间线 · {len(data['timeline_events'])}"):
        if not data["timeline_events"]:
            st.caption("暂无时间线")
        for item in data["timeline_events"]:
            st.write(f"- {item['event_time'] or '时间未注明'}：{item['text']}")

    with st.expander(f"原始记录 · {len(data['entries'])}"):
        if not data["entries"]:
            st.caption("暂无原始记录")
        for item in reversed(data["entries"]):
            st.markdown(f"**{item['summary'] or item['created_at']}**")
            st.write(item["raw_text"])
            st.divider()


def _show_bucket_browser() -> tuple[list[Bucket], dict[str, Bucket]]:
    """Render Bucket search and focus selection at the top of the sidebar."""

    active_buckets = list_active_buckets()
    bucket_by_id = {bucket.id: bucket for bucket in active_buckets}

    st.metric("活跃 Bucket", len(active_buckets))
    search_query = st.text_input(
        "搜索记忆",
        key="memory-search-query",
        placeholder="项目、故障、会议或结论关键词",
    )

    if search_query.strip():
        candidates = search_buckets(search_query, limit=10)
        if not candidates:
            st.caption("没有找到匹配的 Bucket。")
        for result in candidates:
            if st.button(
                f"🔎 {result.title} · {result.bucket_type}",
                key=f"search-{result.bucket_id}",
                use_container_width=True,
            ):
                st.session_state.current_bucket_id = result.bucket_id
                st.rerun()
        return active_buckets, bucket_by_id

    if not active_buckets:
        st.info("还没有 Bucket。直接在对话中描述工作，Doggie 会自动判断是否创建。")
        return active_buckets, bucket_by_id

    st.caption("选择一个 Bucket 作为当前对话焦点")
    for bucket in active_buckets:
        marker = "▶" if bucket.id == st.session_state.current_bucket_id else "○"
        if st.button(
            f"{marker} {bucket.title}\n{bucket.type.value}",
            key=f"bucket-{bucket.id}",
            use_container_width=True,
        ):
            st.session_state.current_bucket_id = bucket.id
            st.rerun()

    return active_buckets, bucket_by_id


def _show_memory_actions(
    active_buckets: list[Bucket],
    bucket_by_id: dict[str, Bucket],
) -> None:
    """Render corrective memory operations in an isolated sidebar section."""

    if not active_buckets:
        return

    with st.expander("记忆管理"):
        st.caption("当前支持移动最近一次归档；后续工具可以继续放在本区域。")
        correction_target = st.selectbox(
            "移动最近 Entry 到",
            options=[bucket.id for bucket in active_buckets],
            format_func=lambda item: bucket_by_id[item].title,
            key="correction-target",
        )
        correction_reason = st.text_input(
            "纠错说明",
            value="把刚才那条移到正确的 Bucket",
        )
        if st.button("移动最近 Entry", use_container_width=True):
            try:
                correction = move_latest_entry(
                    correction_reason,
                    target_bucket_id=correction_target,
                )
                st.session_state.current_bucket_id = correction_target
                st.success(f"纠错已记录：{correction.id}")
                st.rerun()
            except Exception as exc:
                st.error(f"纠错失败：{exc}")


def _show_workspace_sidebar() -> None:
    """Render the independently scrolling workspace sidebar."""

    with st.sidebar:
        st.header("🗂️ Bucket 记忆")
        st.caption("独立于对话滚动，始终可以从左上角展开或收起。")

        active_buckets, bucket_by_id = _show_bucket_browser()

        selected_bucket_id = st.session_state.current_bucket_id
        if selected_bucket_id:
            st.divider()
            st.subheader("当前焦点")
            _show_bucket_detail(selected_bucket_id)

        st.divider()
        _show_memory_actions(active_buckets, bucket_by_id)

        st.caption("侧边栏后续可继续扩展 Todo 总览、文件工具、审批记录和设置。")


def main() -> None:
    st.set_page_config(
        page_title="Doggie",
        page_icon="🧠",
        layout="wide",
        initial_sidebar_state="expanded",
    )
    init_db()

    if "current_bucket_id" not in st.session_state:
        st.session_state.current_bucket_id = None

    _show_workspace_sidebar()

    st.title("🧠 Doggie")
    st.caption(
        "一个对话，一套长期记忆：主区域专注对话，Bucket 和扩展工具放在独立侧边栏。"
    )
    st.subheader("💬 对话与问题解决")
    st.caption(
        "直接说出问题、进展、结论或下一步；读取和写入记忆的操作会显示在对话时间线中。"
    )
    _show_chat_timeline()

    prompt = st.chat_input("向 Doggie 提问，或直接描述你的工作进展……")
    if prompt:
        try:
            with st.spinner("Doggie 正在结合对话与 Bucket 记忆思考……"):
                run_agent_turn(
                    prompt,
                    current_focus_bucket_id=st.session_state.current_bucket_id,
                )
            st.rerun()
        except Exception as exc:
            st.error(f"对话失败：{exc}")


if __name__ == "__main__":
    main()
