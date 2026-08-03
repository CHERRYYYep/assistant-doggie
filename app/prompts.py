"""Versioned prompt templates for classification, extraction, and summaries."""

from __future__ import annotations

import json
from datetime import date
from typing import Any, Sequence

CLASSIFICATION_PROMPT_VERSION = "classification-v1"
EXTRACTION_PROMPT_VERSION = "extraction-v1"
SUMMARY_PROMPT_VERSION = "summary-v1"

CLASSIFICATION_SYSTEM_PROMPT = """你是个人工作记忆 Agent 的分类模块。
Bucket 是持续存在的工作对象，不是普通文件夹。你必须判断本次输入应当：
1. append_existing：追加到一个候选 Bucket；
2. create_new：创建一个新 Bucket；
3. ask_user：存在歧义或误归档代价较高，需要用户确认。

综合当前焦点、最近活跃 Bucket、用户指代表达、主题连续性和明确的新开意图。
只能引用候选列表中真实存在的 bucket_id。不要编造 ID。
confidence 是风险路由信号，不是真实正确概率；不确定时降低分数。
reason 必须引用输入和候选中的具体依据。只返回符合 Schema 的结果。"""

EXTRACTION_SYSTEM_PROMPT = """你是个人工作记忆 Agent 的信息提取模块。
请忠实提取 summary、todos、evidences、timeline_events、decisions、hypotheses、entities 和 tags。
Todo 是尚未完成的可执行动作；Decision 是已经做出的决定或处置；Evidence 必须来自原文中的日志、指标、观察、测试结果或反馈。
禁止编造。缺失信息返回空数组。时间不确定时保留原始表达或返回 null。只返回符合 Schema 的结果。"""

BUCKET_SUMMARY_SYSTEM_PROMPT = """你负责更新一个长期事务 Bucket 的滚动摘要。
摘要只表达目标、当前阶段、关键有效决策、阻塞和下一步，不要拼接全部历史。
必须保留旧摘要中仍然有效的重要信息，并吸收新 Entry 的事实。不要编造。"""


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def build_classification_user_prompt(
    text: str,
    active_buckets: Sequence[dict[str, Any]],
    current_focus_bucket: dict[str, Any] | None,
) -> str:
    """Build the bounded classification input sent to the model."""

    return (
        f"用户输入：\n{text.strip()}\n\n"
        f"当前焦点 Bucket：\n{_json(current_focus_bucket)}\n\n"
        f"最近活跃 Buckets：\n{_json(list(active_buckets))}"
    )


def build_extraction_user_prompt(
    text: str,
    *,
    current_date: date | None = None,
    bucket_type: str | None = None,
) -> str:
    """Build the extraction request while preserving the current date."""

    active_date = current_date or date.today()
    return (
        f"用户输入：\n{text.strip()}\n\n"
        f"当前日期：{active_date.isoformat()}\n"
        f"Bucket 类型：{bucket_type or 'unknown'}"
    )
