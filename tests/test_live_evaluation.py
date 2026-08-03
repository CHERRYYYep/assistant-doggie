import json
from datetime import datetime, timezone

from app.evaluation import ClassificationCase
from app.live_evaluation import (
    LiveClassificationReport,
    run_live_classification,
    write_live_classification_report,
)
from app.prompts import CLASSIFICATION_PROMPT_VERSION
from app.schemas import ClassificationResult


def test_live_classification_report_keeps_reproducibility_metadata(tmp_path):
    case = ClassificationCase(
        id="append-payment",
        input="支付回调已经恢复",
        current_focus_bucket_id="payment",
        buckets=[
            {
                "id": "payment",
                "title": "支付回调故障",
                "type": "incident",
                "summary": "第三方返回 502",
            }
        ],
        expected_action="append_existing",
        expected_bucket_id="payment",
        should_ask_user=False,
        error_cost="high",
    )
    calls = []

    def fake_classifier(text, buckets, current_focus_bucket_id=None):
        calls.append((text, buckets, current_focus_bucket_id))
        return ClassificationResult(
            action="append_existing",
            bucket_id="payment",
            bucket_type="incident",
            confidence=0.93,
            reason="输入延续当前支付故障。",
        )

    generated_at = datetime(2026, 8, 3, 8, 30, tzinfo=timezone.utc)
    report = run_live_classification(
        [case],
        classifier=fake_classifier,
        model_name="test-model",
        cases_path="fixtures/classification.json",
        generated_at=generated_at,
    )

    assert report.generated_at == generated_at
    assert report.model_name == "test-model"
    assert report.prompt_version == CLASSIFICATION_PROMPT_VERSION
    assert report.cases_path == "fixtures/classification.json"
    assert report.case_count == 1
    assert report.metrics.action_accuracy == 1.0
    assert report.metrics.existing_bucket_accuracy == 1.0
    assert calls[0][0] == case.input
    assert calls[0][1][0].id == "payment"
    assert calls[0][1][0].last_active_at == generated_at
    assert calls[0][2] == "payment"

    path = write_live_classification_report(report, tmp_path / "nested" / "report.json")
    restored = LiveClassificationReport.model_validate_json(path.read_text())
    assert restored == report
    assert json.loads(path.read_text())["model_name"] == "test-model"
