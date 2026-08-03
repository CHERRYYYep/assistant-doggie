import pytest

from app.db import get_session, init_db
from app.schemas import ExtractionResult
from app.services.bucket_service import (
    append_entry,
    create_bucket,
    get_bucket_detail,
    save_extraction,
    update_bucket_summary,
)
from app.services.extract_service import extract_info


@pytest.fixture
def session(tmp_path):
    url = f"sqlite:///{tmp_path / 'memory.db'}"
    init_db(url)
    with get_session(url) as active_session:
        yield active_session


def sample_extraction():
    return ExtractionResult(
        summary="支付回调 10:20 开始失败，第三方返回 502。",
        todos=["补充事故复盘"],
        evidences=["第三方返回 502"],
        timeline_events=[{"event_time": "10:20", "text": "支付回调开始失败"}],
        decisions=["切换备用通道"],
        tags=["payment", "502"],
    )


def test_extract_info_uses_validated_structured_output():
    def parser(_system, user, _schema):
        assert "2026-08-03" in user
        return sample_extraction()

    result = extract_info(
        "支付回调 10:20 开始失败",
        bucket_type="incident",
        current_date=__import__("datetime").date(2026, 8, 3),
        parser=parser,
    )

    assert result.timeline_events[0].event_time == "10:20"


def test_save_extraction_persists_children_and_deduplicates(session):
    bucket = create_bucket("支付回调失败", "incident", session=session)
    first_entry = append_entry(bucket.id, "第一条", session=session)
    extraction = sample_extraction()

    saved = save_extraction(bucket.id, first_entry.id, extraction, session=session)
    second_entry = append_entry(bucket.id, "第二条重复证据", session=session)
    duplicate = save_extraction(bucket.id, second_entry.id, extraction, session=session)
    detail = get_bucket_detail(bucket.id, session=session)

    assert len(saved.todos) == len(saved.evidences) == len(saved.timeline_events) == 1
    assert len(saved.decisions) == 1
    assert duplicate.todos == []
    assert duplicate.evidences == []
    assert detail is not None
    assert detail.tags == ["payment", "502"]
    assert detail.entries[0].summary == extraction.summary
    assert len(detail.todos) == 1
    assert detail.todos[0].entry_id == first_entry.id


def test_update_bucket_summary_is_bounded_and_nonduplicating(session):
    bucket = create_bucket("长期任务", "task", "项目目标", session=session)
    update_bucket_summary(bucket.id, "完成数据库", session=session, max_chars=100)
    update_bucket_summary(bucket.id, "完成数据库", session=session, max_chars=100)
    update_bucket_summary(bucket.id, "开始分类评估", session=session, max_chars=100)

    assert bucket.summary.count("完成数据库") == 1
    assert len(bucket.summary) <= 100
