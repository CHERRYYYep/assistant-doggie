import pytest
from pydantic import ValidationError

from app.schemas import (
    ClassificationResult,
    ExtractionResult,
    TimelineEventExtract,
)


def test_append_existing_requires_bucket_id():
    result = ClassificationResult(
        action="append_existing",
        bucket_id="bucket-1",
        bucket_type="incident",
        confidence=0.91,
        reason="输入继续描述同一个支付故障。",
    )

    assert result.bucket_id == "bucket-1"
    assert result.should_ask_user is False
    assert result.candidate_bucket_ids == []

    with pytest.raises(ValidationError, match="requires bucket_id"):
        ClassificationResult(
            action="append_existing",
            confidence=0.91,
            reason="缺少目标 bucket。",
        )


def test_create_new_requires_type_and_title():
    result = ClassificationResult(
        action="create_new",
        bucket_type="experiment",
        title="接口 A 压测记录",
        confidence=0.86,
        reason="输入描述了新的压测实验。",
    )

    assert result.bucket_id is None
    assert result.bucket_type == "experiment"

    with pytest.raises(ValidationError, match="requires bucket_type and title"):
        ClassificationResult(
            action="create_new",
            confidence=0.86,
            reason="没有给出新 bucket 信息。",
        )


def test_ask_user_requires_question_and_flag():
    result = ClassificationResult(
        action="ask_user",
        confidence=0.31,
        reason="两个 bucket 都可能匹配。",
        should_ask_user=True,
        question="这条内容属于支付故障还是接口稳定性？",
        candidate_bucket_ids=[" bucket-1 ", "bucket-1", "bucket-2"],
    )

    assert result.candidate_bucket_ids == ["bucket-1", "bucket-2"]

    with pytest.raises(ValidationError, match="should_ask_user=true"):
        ClassificationResult(
            action="ask_user",
            confidence=0.31,
            reason="需要用户判断。",
            question="应该放到哪里？",
        )


def test_classification_rejects_invalid_confidence_and_extra_fields():
    with pytest.raises(ValidationError, match="between 0 and 1"):
        ClassificationResult(
            action="create_new",
            bucket_type="idea",
            title="新想法",
            confidence=1.2,
            reason="新主题。",
        )

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ClassificationResult.model_validate(
            {
                "action": "create_new",
                "bucket_type": "idea",
                "title": "新想法",
                "confidence": 0.8,
                "reason": "新主题。",
                "unknown_field": "must fail",
            }
        )


def test_extraction_normalizes_lists_and_nested_timeline():
    result = ExtractionResult(
        summary=" 支付回调失败，第三方返回 502。 ",
        todos=[" 补充复盘 ", "补充复盘", ""],
        evidences=["第三方返回 502"],
        timeline_events=[
            {"event_time": " 10:20 ", "text": " 开始大量失败 "},
            TimelineEventExtract(event_time="", text="切换备用通道后恢复"),
        ],
        decisions=["切换备用通道"],
        entities=["支付回调", "第三方接口"],
        tags=[" payment ", "payment", "502"],
    )

    assert result.summary == "支付回调失败，第三方返回 502。"
    assert result.todos == ["补充复盘"]
    assert result.tags == ["payment", "502"]
    assert result.timeline_events[0].event_time == "10:20"
    assert result.timeline_events[1].event_time is None


def test_extraction_defaults_are_independent():
    first = ExtractionResult(summary="第一条输入")
    second = ExtractionResult(summary="第二条输入")

    first.todos.append("只属于第一条")

    assert first.todos == ["只属于第一条"]
    assert second.todos == []


def test_extraction_requires_summary_and_valid_timeline_text():
    with pytest.raises(ValidationError, match="summary must not be empty"):
        ExtractionResult(summary="   ")

    with pytest.raises(ValidationError, match="timeline event text must not be empty"):
        ExtractionResult(
            summary="存在时间线",
            timeline_events=[{"event_time": "下午", "text": ""}],
        )


def test_json_schema_forbids_unknown_object_fields():
    classification_schema = ClassificationResult.model_json_schema()
    extraction_schema = ExtractionResult.model_json_schema()

    assert classification_schema["additionalProperties"] is False
    assert extraction_schema["additionalProperties"] is False
    assert classification_schema["properties"]["action"]["enum"] == [
        "append_existing",
        "create_new",
        "ask_user",
    ]
