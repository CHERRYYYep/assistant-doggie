from datetime import datetime, timezone

from app.schemas import BucketView, ClassificationResult
from app.services.classify_service import (
    ConfidencePolicy,
    apply_confidence_gate,
    apply_low_information_reference_gate,
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


def test_low_information_reference_gate_blocks_vague_high_confidence_append():
    result = ClassificationResult(
        action="append_existing",
        bucket_id="payment",
        confidence=0.97,
        reason="看起来和支付相关。",
    )

    gated = apply_low_information_reference_gate(
        "刚才那个支付相关的继续处理",
        result,
    )

    assert gated.action == "ask_user"
    assert gated.should_ask_user is True
    assert gated.candidate_bucket_ids == ["payment"]
    assert "已阻止高风险自动合并" in gated.reason


def test_low_information_reference_gate_allows_concrete_status_update():
    result = ClassificationResult(
        action="append_existing",
        bucket_id="payment",
        confidence=0.97,
        reason="明确延续支付问题。",
    )

    gated = apply_low_information_reference_gate(
        "刚才那个支付问题恢复了",
        result,
    )

    assert gated.action == "append_existing"
    assert gated.bucket_id == "payment"


def test_first_bucket_create_new_skips_confidence_confirmation_gate():
    def parser(_system, user, _schema):
        assert "最近活跃 Buckets：\n[]" in user
        return ClassificationResult(
            action="create_new",
            bucket_type="task",
            title="整理发布清单",
            confidence=0.62,
            reason="没有已有 Bucket，输入包含明确待办。",
        )

    result = classify_input(
        "整理明天发布前的检查清单",
        [],
        parser=parser,
        policy=ConfidencePolicy(),
    )

    assert result.action == "create_new"
    assert result.title == "整理发布清单"
    assert result.confidence == 0.62


def test_empty_bucket_still_asks_for_pure_vague_reference():
    def parser(_system, _user, _schema):
        return ClassificationResult(
            action="ask_user",
            confidence=0.20,
            reason="输入只有指代，无法识别主题。",
            should_ask_user=True,
            question="你指的是哪件事？",
        )

    result = classify_input(
        "刚才那个继续处理",
        [],
        parser=parser,
        policy=ConfidencePolicy(),
    )

    assert result.action == "ask_user"
    assert result.question == "你指的是哪件事？"
