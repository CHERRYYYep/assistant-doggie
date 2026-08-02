from datetime import datetime, timezone

import pytest

from app.db import get_session, init_db
from app.models import BucketStatus, BucketType
from app.services.bucket_service import (
    append_entry,
    create_bucket,
    get_bucket,
    get_bucket_detail,
    list_active_buckets,
)


@pytest.fixture
def database_url(tmp_path):
    url = f"sqlite:///{tmp_path / 'work-memory.db'}"
    init_db(url)
    return url


@pytest.fixture
def session(database_url):
    with get_session(database_url) as database_session:
        yield database_session


def test_create_and_get_bucket(session):
    bucket = create_bucket(
        "支付回调失败排查",
        "incident",
        "支付回调异常",
        tags=["payment", " incident "],
        session=session,
    )

    stored = get_bucket(bucket.id, session=session)

    assert stored is not None
    assert stored.title == "支付回调失败排查"
    assert stored.type is BucketType.INCIDENT
    assert stored.status is BucketStatus.ACTIVE
    assert stored.summary == "支付回调异常"
    assert stored.tags == ["payment", "incident"]


def test_append_entry_updates_bucket_activity_and_detail(session):
    bucket = create_bucket(
        "支付回调失败排查",
        "incident",
        "支付回调异常",
        session=session,
    )
    previous_activity = datetime(2020, 1, 1, tzinfo=timezone.utc)
    bucket.last_active_at = previous_activity
    session.flush()

    entry = append_entry(
        bucket.id,
        "日志里第三方返回 502",
        "第三方接口返回 502",
        content_type="log",
        classification_confidence=0.94,
        classification_reason="包含线上错误日志",
        session=session,
    )
    detail = get_bucket_detail(bucket.id, session=session)

    assert entry.bucket_id == bucket.id
    assert entry.raw_text == "日志里第三方返回 502"
    assert entry.content_type == "log"
    assert detail is not None
    assert [item.id for item in detail.entries] == [entry.id]
    assert detail.last_active_at.replace(tzinfo=timezone.utc) > previous_activity
    assert detail.todos == []
    assert detail.evidences == []
    assert detail.timeline_events == []
    assert detail.decisions == []


def test_list_active_buckets_excludes_non_active_buckets(session):
    active = create_bucket("活跃任务", "task", session=session)
    paused = create_bucket("暂停任务", "task", session=session)
    paused.status = BucketStatus.PAUSED
    session.flush()

    results = list_active_buckets(session=session)

    assert [bucket.id for bucket in results] == [active.id]


def test_append_entry_rejects_missing_bucket(session):
    with pytest.raises(LookupError, match="bucket not found"):
        append_entry("missing-id", "不会被保存", session=session)


def test_service_validates_required_values(session):
    with pytest.raises(ValueError, match="title must not be empty"):
        create_bucket("   ", "idea", session=session)

    bucket = create_bucket("有效标题", "idea", session=session)
    with pytest.raises(ValueError, match="between 0 and 1"):
        append_entry(
            bucket.id,
            "有效内容",
            classification_confidence=1.5,
            session=session,
        )
