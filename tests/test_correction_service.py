import pytest
from sqlalchemy import select

from app.db import get_session, init_db
from app.models import ClassificationRecord, Correction
from app.schemas import ExtractionResult
from app.services.bucket_service import (
    append_entry,
    create_bucket,
    get_bucket_detail,
    save_extraction,
)
from app.services.correction_service import move_entry, move_latest_entry


@pytest.fixture
def session(tmp_path):
    url = f"sqlite:///{tmp_path / 'correction.db'}"
    init_db(url)
    with get_session(url) as active_session:
        yield active_session


def test_move_entry_moves_all_children_and_writes_audit(session):
    source = create_bucket("支付问题", "incident", session=session)
    target = create_bucket("接口稳定性问题", "task", session=session)
    entry = append_entry(source.id, "接口超时", "接口出现超时", session=session)
    save_extraction(
        source.id,
        entry.id,
        ExtractionResult(
            summary="接口出现超时",
            todos=["增加告警"],
            evidences=["超时率 5%"],
            timeline_events=[{"event_time": "下午", "text": "开始超时"}],
            decisions=["临时扩容"],
        ),
        session=session,
    )
    classification_record = ClassificationRecord(
        raw_text=entry.raw_text,
        action="append_existing",
        bucket_id=source.id,
        entry_id=entry.id,
        confidence=0.9,
        reason="测试",
        candidate_bucket_ids=[source.id],
        prompt_version="test",
        model_name="mock",
    )
    session.add(classification_record)
    session.flush()

    correction = move_entry(
        entry.id,
        target.id,
        "把刚才那条移到接口稳定性问题里",
        session=session,
    )
    session.expire_all()
    source_detail = get_bucket_detail(source.id, session=session)
    target_detail = get_bucket_detail(target.id, session=session)

    assert correction.action == "move_entry"
    assert correction.before_json["bucket_id"] == source.id
    assert correction.after_json["bucket_id"] == target.id
    assert source_detail is not None and source_detail.entries == []
    assert target_detail is not None
    assert [item.id for item in target_detail.entries] == [entry.id]
    assert all(item.bucket_id == target.id for item in target_detail.todos)
    assert all(item.bucket_id == target.id for item in target_detail.evidences)
    assert all(item.bucket_id == target.id for item in target_detail.timeline_events)
    assert all(item.bucket_id == target.id for item in target_detail.decisions)
    assert session.get(ClassificationRecord, classification_record.id).corrected is True
    assert session.scalar(select(Correction)).id == correction.id


def test_move_latest_entry_can_resolve_target_from_command(session):
    source = create_bucket("支付问题", "incident", session=session)
    target = create_bucket("接口稳定性问题", "task", session=session)
    entry = append_entry(source.id, "错误归档内容", "接口问题", session=session)

    move_latest_entry(
        "刚才那条不要放到支付问题，放到接口稳定性问题里。",
        session=session,
    )

    assert entry.bucket_id == target.id
