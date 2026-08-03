"""End-to-end mock regression for the primary MVP scenarios."""

import pytest

from app.db import get_session, init_db
from app.schemas import ClassificationResult, ExtractionResult
from app.services.archive_service import archive_user_input
from app.services.bucket_service import get_bucket_detail
from app.services.correction_service import move_entry
from app.services.search_service import search_buckets


@pytest.fixture
def session(tmp_path):
    url = f"sqlite:///{tmp_path / 'mvp-regression.db'}"
    init_db(url)
    with get_session(url) as active_session:
        yield active_session


def _classifier(result: ClassificationResult):
    def classify(_text, _buckets, **_kwargs):
        return result

    return classify


def _extractor(result: ExtractionResult):
    def extract(_text, **_kwargs):
        return result

    return extract


def _archive(session, text, classification, extraction):
    return archive_user_input(
        text,
        classifier=_classifier(classification),
        extractor=_extractor(extraction),
        session=session,
        model_name="mock-regression-model",
    )


def test_incident_experiment_meeting_correction_and_search(session):
    incident = _archive(
        session,
        "支付回调从 10:20 开始失败，第三方返回 502。",
        ClassificationResult(
            action="create_new",
            bucket_type="incident",
            title="支付回调失败排查",
            confidence=0.94,
            reason="新的支付故障。",
        ),
        ExtractionResult(
            summary="支付回调从 10:20 开始因第三方 502 失败",
            evidences=["第三方返回 502"],
            timeline_events=[{"event_time": "10:20", "text": "支付回调开始失败"}],
            tags=["支付", "502"],
        ),
    )
    incident_follow_up = _archive(
        session,
        "10:40 切到备用通道后恢复，后面要补复盘。",
        ClassificationResult(
            action="append_existing",
            bucket_id=incident.bucket_id,
            bucket_type="incident",
            confidence=0.92,
            reason="继续同一支付故障。",
        ),
        ExtractionResult(
            summary="10:40 切换备用通道后恢复，待补复盘",
            todos=["补充支付故障复盘"],
            timeline_events=[{"event_time": "10:40", "text": "切换备用通道后恢复"}],
            decisions=["切换到备用通道"],
        ),
    )
    experiment = _archive(
        session,
        "接口 A 在 QPS 1200 时 P99 达到 2.3 秒。",
        ClassificationResult(
            action="create_new",
            bucket_type="experiment",
            title="接口 A 压测",
            confidence=0.93,
            reason="独立压测实验。",
        ),
        ExtractionResult(
            summary="接口 A 在 QPS 1200 时 P99 达到 2.3 秒",
            evidences=["QPS 1200 时 P99 为 2.3 秒"],
            tags=["压测"],
        ),
    )
    meeting = _archive(
        session,
        "首页评审决定保留搜索入口，下周验证卡片布局。",
        ClassificationResult(
            action="create_new",
            bucket_type="meeting",
            title="首页改版评审",
            confidence=0.91,
            reason="新的会议记录。",
        ),
        ExtractionResult(
            summary="首页评审决定保留搜索入口并在下周验证卡片布局",
            todos=["下周验证卡片布局"],
            decisions=["保留搜索入口"],
        ),
    )

    correction = move_entry(
        incident_follow_up.entry_id,
        experiment.bucket_id,
        "把恢复记录移到接口 A 压测",
        session=session,
    )
    incident_detail = get_bucket_detail(incident.bucket_id, session=session)
    experiment_detail = get_bucket_detail(experiment.bucket_id, session=session)
    meeting_detail = get_bucket_detail(meeting.bucket_id, session=session)
    payment_results = search_buckets("支付回调", session=session)

    assert correction.before_json["bucket_id"] == incident.bucket_id
    assert correction.after_json["bucket_id"] == experiment.bucket_id
    assert incident_detail is not None and len(incident_detail.entries) == 1
    assert experiment_detail is not None and len(experiment_detail.entries) == 2
    assert meeting_detail is not None
    assert [item.text for item in meeting_detail.todos] == ["下周验证卡片布局"]
    assert [item.text for item in meeting_detail.decisions] == ["保留搜索入口"]
    assert payment_results[0].bucket_id == incident.bucket_id
