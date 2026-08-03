from datetime import datetime, timezone

from app.schemas import BucketView, ClassificationResult
from app.services.classify_service import (
    ConfidencePolicy,
    apply_confidence_gate,
    build_bucket_candidates,
    classify_input,
)


def bucket(bucket_id, title, last_day):
    return BucketView(
        id=bucket_id,
        title=title,
        type="incident",
        status="active",
        summary=title,
        last_active_at=datetime(2026, 8, last_day, tzinfo=timezone.utc),
    )


def test_candidates_put_current_focus_first_and_deduplicate():
    candidates = build_bucket_candidates(
        [bucket("old", "旧问题", 1), bucket("new", "新问题", 3), bucket("old", "旧问题", 1)],
        current_focus_bucket_id="old",
    )

    assert [item.id for item in candidates] == ["old", "new"]


def test_classify_input_accepts_only_server_candidate_ids():
    candidates = [bucket("payment", "支付故障", 3)]

    def parser(_system, user, _schema):
        assert '"id": "payment"' in user
        return ClassificationResult(
            action="append_existing",
            bucket_id="invented",
            confidence=0.99,
            reason="模型编造了目标。",
        )

    result = classify_input(
        "支付恢复了",
        candidates,
        parser=parser,
        policy=ConfidencePolicy(),
    )

    assert result.action == "ask_user"
    assert result.candidate_bucket_ids == ["payment"]
    assert "不在服务端候选列表" in result.reason


def test_confidence_gate_allows_high_unique_and_blocks_medium():
    high = ClassificationResult(
        action="append_existing",
        bucket_id="payment",
        confidence=0.90,
        reason="明确指向支付故障。",
    )
    medium = ClassificationResult(
        action="create_new",
        bucket_type="experiment",
        title="接口 B 压测",
        confidence=0.70,
        reason="可能是新实验。",
    )

    assert apply_confidence_gate(high).action == "append_existing"
    gated = apply_confidence_gate(medium)
    assert gated.action == "ask_user"
    assert gated.should_ask_user is True
