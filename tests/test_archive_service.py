import pytest
from sqlalchemy import select

from app.db import get_session, init_db
from app.models import ClassificationRecord, Entry
from app.schemas import ClassificationResult, ExtractionResult
from app.services.archive_service import archive_user_input
from app.services.bucket_service import create_bucket, get_bucket_detail


@pytest.fixture
def session(tmp_path):
    url = f"sqlite:///{tmp_path / 'archive.db'}"
    init_db(url)
    with get_session(url) as active_session:
        yield active_session


def extraction(text="已提取摘要"):
    return ExtractionResult(
        summary=text,
        todos=["补复盘"],
        evidences=["第三方返回 502"],
        timeline_events=[{"event_time": "10:20", "text": "开始失败"}],
        decisions=["切备用通道"],
        tags=["payment"],
    )


def test_archive_flow_creates_bucket_entry_and_structured_records(session):
    def classifier(_text, _buckets, **_kwargs):
        return ClassificationResult(
            action="create_new",
            bucket_type="incident",
            title="支付回调失败",
            confidence=0.93,
            reason="新的线上故障。",
        )

    result = archive_user_input(
        "支付回调 10:20 开始失败，第三方返回 502",
        classifier=classifier,
        extractor=lambda _text, **_kwargs: extraction(),
        session=session,
        model_name="mock-model",
    )
    detail = get_bucket_detail(result.bucket_id, session=session)
    record = session.scalar(select(ClassificationRecord))

    assert result.status == "archived"
    assert result.action == "create_new"
    assert detail is not None
    assert len(detail.entries) == 1
    assert len(detail.todos) == 1
    assert len(detail.evidences) == 1
    assert len(detail.timeline_events) == 1
    assert len(detail.decisions) == 1
    assert record is not None
    assert record.entry_id == result.entry_id
    assert record.prompt_version == "classification-v1"


def test_archive_flow_appends_to_existing_bucket(session):
    bucket = create_bucket("接口 A 压测", "experiment", session=session)

    def classifier(_text, buckets, **_kwargs):
        assert [item.id for item in buckets] == [bucket.id]
        return ClassificationResult(
            action="append_existing",
            bucket_id=bucket.id,
            bucket_type="experiment",
            confidence=0.91,
            reason="继续同一压测。",
        )

    result = archive_user_input(
        "连接池调到 100 后 P99 降到 1.4 秒",
        current_focus_bucket_id=bucket.id,
        classifier=classifier,
        extractor=lambda _text, **_kwargs: ExtractionResult(
            summary="调整连接池后 P99 降低",
            evidences=["连接池从 50 调到 100 后 P99 降到 1.4 秒"],
        ),
        session=session,
        model_name="mock-model",
    )

    assert result.bucket_id == bucket.id
    assert session.scalar(select(Entry)).bucket_id == bucket.id


def test_uncertain_classification_records_audit_but_not_formal_memory(session):
    bucket = create_bucket("支付故障", "incident", session=session)

    def classifier(_text, _buckets, **_kwargs):
        return ClassificationResult(
            action="ask_user",
            confidence=0.40,
            reason="两个问题都可能匹配。",
            should_ask_user=True,
            question="属于哪个问题？",
            candidate_bucket_ids=[bucket.id],
        )

    result = archive_user_input(
        "继续那个问题",
        classifier=classifier,
        extractor=lambda *_args, **_kwargs: pytest.fail("should not extract"),
        session=session,
        model_name="mock-model",
    )

    assert result.status == "needs_confirmation"
    assert session.scalar(select(Entry)) is None
    record = session.scalar(select(ClassificationRecord))
    assert record is not None
    assert record.action == "ask_user"


def test_confirmed_new_bucket_is_persisted_without_reclassification(session):
    from app.services.archive_service import archive_confirmed_new_input

    result = archive_confirmed_new_input(
        "新压测记录",
        "接口 B 压测",
        "experiment",
        extractor=lambda _text, **_kwargs: ExtractionResult(summary="开始接口 B 压测"),
        session=session,
        model_name="mock-model",
    )

    assert result.status == "archived"
    assert result.action == "create_new"
    assert result.bucket_title == "接口 B 压测"


def test_database_failure_rolls_back_entire_owned_archive_transaction(
    tmp_path, monkeypatch
):
    import app.db as db
    import app.services.archive_service as archive_module
    from app.models import Bucket

    database_url = f"sqlite:///{tmp_path / 'rollback.db'}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    db._create_engine.cache_clear()
    init_db(database_url)

    def classifier(_text, _buckets, **_kwargs):
        return ClassificationResult(
            action="create_new",
            bucket_type="incident",
            title="应被回滚",
            confidence=0.95,
            reason="测试事务。",
        )

    def fail_save(*_args, **_kwargs):
        raise RuntimeError("simulated database failure")

    monkeypatch.setattr(archive_module, "save_extraction", fail_save)

    with pytest.raises(RuntimeError, match="simulated database failure"):
        archive_module.archive_user_input(
            "测试回滚",
            classifier=classifier,
            extractor=lambda _text, **_kwargs: ExtractionResult(summary="测试"),
            model_name="mock-model",
        )

    with get_session(database_url) as verification:
        assert verification.scalar(select(Bucket)) is None
        assert verification.scalar(select(Entry)) is None
        assert verification.scalar(select(ClassificationRecord)) is None
