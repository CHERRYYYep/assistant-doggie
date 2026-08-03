"""Minimal Streamlit interface for the personal work-memory MVP."""

from __future__ import annotations

import streamlit as st

from app.db import get_session, init_db
from app.services.archive_service import (
    archive_confirmed_input,
    archive_confirmed_new_input,
    archive_user_input,
)
from app.services.bucket_service import get_bucket_detail, list_active_buckets
from app.services.correction_service import move_latest_entry
from app.services.search_service import search_buckets
from app.services.view_service import archive_result_view, bucket_detail_view


def _show_archive_result(data: dict[str, object]) -> None:
    if data["status"] == "needs_confirmation":
        st.warning(data.get("question") or "需要确认归档位置。")
    else:
        st.success(f"已归档到：{data.get('bucket_title')}")

    cols = st.columns(3)
    cols[0].metric("动作", str(data.get("action")))
    cols[1].metric("置信度", f"{float(data.get('confidence', 0)):.2f}")
    cols[2].metric("类型", str(data.get("bucket_type") or "待确认"))
    st.caption(str(data.get("reason") or ""))

    if data.get("todos"):
        st.write("**Todo**", data["todos"])
    if data.get("evidences"):
        st.write("**Evidence**", data["evidences"])
    if data.get("timeline_events"):
        st.write("**Timeline**", data["timeline_events"])
    if data.get("decisions"):
        st.write("**Decision**", data["decisions"])


def _show_bucket_detail(bucket_id: str) -> None:
    detail = get_bucket_detail(bucket_id)
    if detail is None:
        st.error("Bucket 不存在或已删除。")
        return
    data = bucket_detail_view(detail)
    st.subheader(data["title"])
    st.caption(
        f"{data['type']} · {data['status']} · 最近更新 {data['last_active_at']}"
    )
    st.write(data["summary"] or "暂无摘要")
    if data["tags"]:
        st.write("标签：", " · ".join(data["tags"]))

    tabs = st.tabs(["Todo", "时间线", "证据", "决策", "原始记录"])
    with tabs[0]:
        for item in data["todos"]:
            st.write(f"- [{item['status']}] {item['text']}")
    with tabs[1]:
        for item in data["timeline_events"]:
            st.write(f"- {item['event_time'] or '时间未注明'}：{item['text']}")
    with tabs[2]:
        for item in data["evidences"]:
            st.write(f"- {item['text']}")
    with tabs[3]:
        for item in data["decisions"]:
            st.write(f"- {item['text']}")
    with tabs[4]:
        for item in reversed(data["entries"]):
            with st.expander(item["summary"] or item["created_at"]):
                st.write(item["raw_text"])


def main() -> None:
    st.set_page_config(page_title="Work Memory Agent", page_icon="🧠", layout="wide")
    init_db()

    st.title("🧠 Personal Work Memory Agent")
    st.caption("分类优先、可解释、可纠错的私人事务记忆 MVP")

    if "current_bucket_id" not in st.session_state:
        st.session_state.current_bucket_id = None
    if "archive_result" not in st.session_state:
        st.session_state.archive_result = None
    if "pending_text" not in st.session_state:
        st.session_state.pending_text = None

    active_buckets = list_active_buckets()
    bucket_by_id = {bucket.id: bucket for bucket in active_buckets}

    with st.sidebar:
        st.header("活跃 Bucket")
        if not active_buckets:
            st.info("归档第一条内容后会在这里出现 Bucket。")
        for bucket in active_buckets:
            marker = "▶ " if bucket.id == st.session_state.current_bucket_id else ""
            if st.button(
                f"{marker}{bucket.title}\n({bucket.type.value})",
                key=f"bucket-{bucket.id}",
                use_container_width=True,
            ):
                st.session_state.current_bucket_id = bucket.id
                st.rerun()

        st.divider()
        st.subheader("搜索")
        search_query = st.text_input("关键词", key="search-query")
        if search_query.strip():
            for result in search_buckets(search_query, limit=10):
                if st.button(
                    f"{result.title} · {result.bucket_type}",
                    key=f"search-{result.bucket_id}",
                    use_container_width=True,
                ):
                    st.session_state.current_bucket_id = result.bucket_id
                    st.rerun()

    input_column, detail_column = st.columns([1, 1])
    with input_column:
        st.subheader("归档新内容")
        text = st.text_area(
            "把碎片信息丢进来",
            height=180,
            placeholder="例如：支付回调 10:20 开始失败，第三方返回 502，待补复盘。",
        )
        if st.button("分析并归档", type="primary", use_container_width=True):
            if not text.strip():
                st.warning("请先输入内容。")
            else:
                try:
                    with st.spinner("正在分类和提取……"):
                        result = archive_user_input(
                            text,
                            current_focus_bucket_id=st.session_state.current_bucket_id,
                        )
                    st.session_state.archive_result = archive_result_view(result)
                    if result.status == "archived":
                        st.session_state.current_bucket_id = result.bucket_id
                        st.session_state.pending_text = None
                    else:
                        st.session_state.pending_text = text
                    st.rerun()
                except Exception as exc:
                    st.error(f"归档失败：{exc}")

        result_data = st.session_state.archive_result
        if result_data:
            _show_archive_result(result_data)

        if st.session_state.pending_text and result_data:
            candidate_ids = result_data.get("candidate_bucket_ids", [])
            suggested_title = result_data.get("bucket_title")
            suggested_type = result_data.get("bucket_type")

            if suggested_title and suggested_type and not candidate_ids:
                st.info(f"建议新建：{suggested_title}（{suggested_type}）")
                if st.button("确认创建并归档", use_container_width=True):
                    try:
                        confirmed = archive_confirmed_new_input(
                            st.session_state.pending_text,
                            str(suggested_title),
                            str(suggested_type),
                        )
                        st.session_state.archive_result = archive_result_view(confirmed)
                        st.session_state.current_bucket_id = confirmed.bucket_id
                        st.session_state.pending_text = None
                        st.rerun()
                    except Exception as exc:
                        st.error(f"确认新建失败：{exc}")
            elif active_buckets:
                selectable = [
                    bucket
                    for bucket in active_buckets
                    if not candidate_ids or bucket.id in candidate_ids
                ] or active_buckets
                target_id = st.selectbox(
                    "确认目标 Bucket",
                    options=[bucket.id for bucket in selectable],
                    format_func=lambda item: bucket_by_id[item].title,
                )
                if st.button("确认并归档", use_container_width=True):
                    try:
                        confirmed = archive_confirmed_input(
                            st.session_state.pending_text,
                            target_id,
                        )
                        st.session_state.archive_result = archive_result_view(confirmed)
                        st.session_state.current_bucket_id = target_id
                        st.session_state.pending_text = None
                        st.rerun()
                    except Exception as exc:
                        st.error(f"确认归档失败：{exc}")

        if active_buckets:
            with st.expander("纠正最近一次归档"):
                correction_target = st.selectbox(
                    "移动到",
                    options=[bucket.id for bucket in active_buckets],
                    format_func=lambda item: bucket_by_id[item].title,
                    key="correction-target",
                )
                correction_reason = st.text_input(
                    "纠错说明",
                    value="把刚才那条移到正确的 Bucket",
                )
                if st.button("移动最近 Entry"):
                    try:
                        correction = move_latest_entry(
                            correction_reason,
                            target_bucket_id=correction_target,
                        )
                        st.success(f"纠错已记录：{correction.id}")
                        st.session_state.current_bucket_id = correction_target
                        st.rerun()
                    except Exception as exc:
                        st.error(f"纠错失败：{exc}")

    with detail_column:
        st.subheader("Bucket 详情")
        if st.session_state.current_bucket_id:
            _show_bucket_detail(st.session_state.current_bucket_id)
        else:
            st.info("从左侧选择一个 Bucket，或先归档一条内容。")


if __name__ == "__main__":
    main()
