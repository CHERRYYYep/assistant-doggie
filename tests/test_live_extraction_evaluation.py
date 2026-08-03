from datetime import date, datetime, timezone

from app.extraction_evaluation import ExtractionCase
from app.live_extraction_evaluation import (
    LiveExtractionReport,
    run_live_extraction,
    write_live_extraction_report,
)
from app.prompts import EXTRACTION_PROMPT_VERSION
from app.schemas import ExtractionResult, TimelineEventExtract


def test_live_extraction_report_keeps_raw_output_metrics_and_metadata(tmp_path):
    case = ExtractionCase(
        id="payment",
        input="支付回调 10:20 开始失败，第三方返回 502，待补复盘。",
        bucket_type="incident",
        expected_summary_terms=["支付回调", "502"],
        expected_todo_terms=["复盘"],
        expected_evidence_terms=["502"],
        expected_timeline_terms=["10:20"],
        forbidden_terms=["退款"],
    )
    calls = []

    def fake_extractor(text, *, bucket_type=None, current_date=None):
        calls.append((text, bucket_type, current_date))
        return ExtractionResult(
            summary="支付回调从 10:20 起失败，第三方返回 502。",
            todos=["补充复盘"],
            evidences=["第三方返回 502"],
            timeline_events=[
                TimelineEventExtract(event_time="10:20", text="支付回调开始失败")
            ],
        )

    reference_date = date(2026, 8, 3)
    generated_at = datetime(2026, 8, 3, 9, 0, tzinfo=timezone.utc)
    report = run_live_extraction(
        [case],
        extractor=fake_extractor,
        model_name="test-model",
        cases_path="fixtures/extraction.json",
        reference_date=reference_date,
        generated_at=generated_at,
    )

    assert report.generated_at == generated_at
    assert report.reference_date == reference_date
    assert report.model_name == "test-model"
    assert report.prompt_version == EXTRACTION_PROMPT_VERSION
    assert report.cases_path == "fixtures/extraction.json"
    assert report.case_count == 1
    assert report.metrics.summary_term_recall == 1.0
    assert report.metrics.forbidden_term_violation_count == 0
    assert report.metrics.novel_numeric_claim_count == 0
    assert calls == [(case.input, "incident", reference_date)]

    path = write_live_extraction_report(report, tmp_path / "nested" / "report.json")
    restored = LiveExtractionReport.model_validate_json(path.read_text())
    assert restored == report
