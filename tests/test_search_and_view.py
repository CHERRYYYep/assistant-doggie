import pytest

from app.db import get_session, init_db
from app.schemas import ArchiveResult, ExtractionResult
from app.services.bucket_service import (
    append_entry,
    create_bucket,
    get_bucket_detail,
    save_extraction,
)
from app.services.search_service import search_buckets
from app.services.view_service import archive_result_view, bucket_detail_view


@pytest.fixture
def session(tmp_path):
    url = f"sqlite:///{tmp_path / 'search.db'}"
    init_db(url)
    with get_session(url) as active_session:
        yield active_session


def test_search_covers_title_summary_tags_and_entry_raw_text(session):
    payment = create_bucket(
        "支付回调失败排查",
        "incident",
        "第三方网关异常",
        tags=["payment", "502"],
        session=session,
    )
    append_entry(payment.id, "订单确认受到影响", "订单确认异常", session=session)
    other = create_bucket("首页改版", "meeting", "讨论卡片布局", session=session)

    assert search_buckets("支付", session=session)[0].bucket_id == payment.id
    assert search_buckets("502", session=session)[0].bucket_id == payment.id
    assert search_buckets("订单确认", session=session)[0].matched_entry_count == 1
    assert search_buckets("卡片布局", session=session)[0].bucket_id == other.id


def test_view_service_exposes_complete_bucket_and_archive_result(session):
    bucket = create_bucket("支付故障", "incident", session=session)
    entry = append_entry(bucket.id, "返回 502", "支付接口异常", session=session)
    extraction = ExtractionResult(
        summary="支付接口异常",
        todos=["补复盘"],
        evidences=["返回 502"],
    )
    save_extraction(bucket.id, entry.id, extraction, session=session)
    detail = get_bucket_detail(bucket.id, session=session)

    detail_data = bucket_detail_view(detail)
    result_data = archive_result_view(
        ArchiveResult(
            status="archived",
            action="append_existing",
            bucket_id=bucket.id,
            bucket_title=bucket.title,
            bucket_type="incident",
            entry_id=entry.id,
            confidence=0.9,
            reason="继续故障。",
            extraction=extraction,
        )
    )

    assert detail_data["entries"][0]["raw_text"] == "返回 502"
    assert detail_data["todos"][0]["text"] == "补复盘"
    assert result_data["evidences"] == ["返回 502"]
