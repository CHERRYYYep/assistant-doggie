"""Bucket candidate construction, LLM classification, and risk gating."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Sequence

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.llm import configured_model, parse_with_schema
from app.models import Bucket, ClassificationRecord
from app.prompts import (
    CLASSIFICATION_PROMPT_VERSION,
    CLASSIFICATION_SYSTEM_PROMPT,
    build_classification_user_prompt,
)
from app.schemas import BucketView, ClassificationResult

SchemaParser = Callable[[str, str, type[BaseModel]], BaseModel]


@dataclass(frozen=True)
class ConfidencePolicy:
    """Configurable thresholds for automatic persistence."""

    auto_archive_threshold: float = 0.85
    confirm_threshold: float = 0.55

    def __post_init__(self) -> None:
        if not 0 <= self.confirm_threshold <= self.auto_archive_threshold <= 1:
            raise ValueError("confidence thresholds must satisfy 0 <= confirm <= auto <= 1")

    @classmethod
    def from_environment(cls) -> "ConfidencePolicy":
        return cls(
            auto_archive_threshold=float(
                os.getenv("AUTO_ARCHIVE_CONFIDENCE", "0.85")
            ),
            confirm_threshold=float(os.getenv("CONFIRM_CONFIDENCE", "0.55")),
        )


def bucket_to_view(bucket: Bucket) -> BucketView:
    """Convert an ORM Bucket into the bounded context sent to the LLM."""

    return BucketView(
        id=bucket.id,
        title=bucket.title,
        type=bucket.type.value,
        status=bucket.status.value,
        summary=bucket.summary,
        tags=bucket.tags,
        last_active_at=bucket.last_active_at,
    )


def build_bucket_candidates(
    buckets: Sequence[Bucket | BucketView],
    *,
    current_focus_bucket_id: str | None = None,
    limit: int = 20,
) -> list[BucketView]:
    """Return de-duplicated, bounded candidates with the focus Bucket first."""

    if limit < 1:
        raise ValueError("candidate limit must be at least 1")

    views = [item if isinstance(item, BucketView) else bucket_to_view(item) for item in buckets]
    deduplicated: dict[str, BucketView] = {view.id: view for view in views}
    ordered = sorted(
        deduplicated.values(),
        key=lambda view: (
            view.id != current_focus_bucket_id,
            -view.last_active_at.timestamp(),
        ),
    )
    return ordered[:limit]


def _ask_user_result(
    original: ClassificationResult,
    *,
    question: str,
    candidate_ids: list[str],
    reason_suffix: str,
) -> ClassificationResult:
    return ClassificationResult(
        action="ask_user",
        bucket_type=original.bucket_type,
        title=original.title,
        confidence=original.confidence,
        reason=f"{original.reason} {reason_suffix}".strip(),
        should_ask_user=True,
        question=question,
        candidate_bucket_ids=candidate_ids,
    )


def validate_candidate_reference(
    result: ClassificationResult,
    candidates: Sequence[BucketView],
) -> ClassificationResult:
    """Prevent a generated Bucket ID from reaching persistence."""

    candidate_ids = {candidate.id for candidate in candidates}
    if result.action == "append_existing" and result.bucket_id not in candidate_ids:
        return _ask_user_result(
            result,
            question="模型给出的目标不存在，请选择要归档到哪个 Bucket。",
            candidate_ids=[candidate.id for candidate in candidates],
            reason_suffix="目标 Bucket ID 不在服务端候选列表中，已阻止自动归档。",
        )

    invalid_candidates = [
        candidate_id
        for candidate_id in result.candidate_bucket_ids
        if candidate_id not in candidate_ids
    ]
    if invalid_candidates:
        valid_ids = [
            candidate_id
            for candidate_id in result.candidate_bucket_ids
            if candidate_id in candidate_ids
        ]
        return _ask_user_result(
            result,
            question=result.question or "请从有效候选中选择目标 Bucket。",
            candidate_ids=valid_ids,
            reason_suffix="模型返回了不存在的候选 ID，已过滤并要求确认。",
        )
    return result


def apply_confidence_gate(
    result: ClassificationResult,
    *,
    policy: ConfidencePolicy | None = None,
) -> ClassificationResult:
    """Convert uncertain or ambiguous automatic actions into confirmation."""

    active_policy = policy or ConfidencePolicy.from_environment()
    if result.action == "ask_user":
        return result

    likely_ids = list(result.candidate_bucket_ids)
    if result.bucket_id and result.bucket_id not in likely_ids:
        likely_ids.insert(0, result.bucket_id)
    ambiguous = len(likely_ids) > 1

    if ambiguous:
        return _ask_user_result(
            result,
            question="多个 Bucket 都可能匹配，请确认本条内容的归属。",
            candidate_ids=likely_ids,
            reason_suffix="存在多个相似候选，已降级为用户确认。",
        )

    if result.confidence >= active_policy.auto_archive_threshold:
        return result

    if result.confidence >= active_policy.confirm_threshold:
        question = (
            "请确认是否创建这个新 Bucket。"
            if result.action == "create_new"
            else "分类置信度一般，请确认是否追加到该 Bucket。"
        )
    else:
        question = "当前信息不足以安全归档，请确认目标 Bucket 或新建事务。"

    return _ask_user_result(
        result,
        question=question,
        candidate_ids=likely_ids,
        reason_suffix="置信度未达到自动归档阈值。",
    )


def classify_input(
    text: str,
    active_buckets: Sequence[Bucket | BucketView],
    current_focus_bucket_id: str | None = None,
    *,
    parser: SchemaParser = parse_with_schema,
    policy: ConfidencePolicy | None = None,
    candidate_limit: int = 20,
) -> ClassificationResult:
    """Classify input against server-provided candidates and apply risk gating."""

    cleaned = text.strip()
    if not cleaned:
        raise ValueError("text must not be empty")

    candidates = build_bucket_candidates(
        active_buckets,
        current_focus_bucket_id=current_focus_bucket_id,
        limit=candidate_limit,
    )
    by_id = {candidate.id: candidate for candidate in candidates}
    focus = by_id.get(current_focus_bucket_id)
    prompt = build_classification_user_prompt(
        cleaned,
        [candidate.model_dump(mode="json") for candidate in candidates],
        focus.model_dump(mode="json") if focus else None,
    )
    parsed = parser(
        CLASSIFICATION_SYSTEM_PROMPT,
        prompt,
        ClassificationResult,
    )
    result = ClassificationResult.model_validate(parsed)
    result = validate_candidate_reference(result, candidates)
    return apply_confidence_gate(result, policy=policy)


def save_classification_record(
    text: str,
    result: ClassificationResult,
    *,
    current_focus_bucket_id: str | None,
    session: Session,
    model_name: str | None = None,
    candidate_bucket_ids: Sequence[str] | None = None,
) -> ClassificationRecord:
    """Persist the evidence needed to audit and calibrate one classification."""

    record = ClassificationRecord(
        raw_text=text.strip(),
        action=result.action,
        bucket_id=result.bucket_id,
        confidence=result.confidence,
        reason=result.reason,
        candidate_bucket_ids=list(
            dict.fromkeys([*(candidate_bucket_ids or []), *result.candidate_bucket_ids])
        ),
        current_focus_bucket_id=current_focus_bucket_id,
        prompt_version=CLASSIFICATION_PROMPT_VERSION,
        model_name=model_name or configured_model(),
    )
    session.add(record)
    session.flush()
    return record
