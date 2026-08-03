import json

import pytest

from app.extraction_evaluation import (
    ExtractionCase,
    ExtractionPrediction,
    evaluate_extractions,
    load_extraction_cases,
    load_extraction_predictions,
)
from app.schemas import ExtractionResult, TimelineEventExtract


def _payment_case() -> ExtractionCase:
    return ExtractionCase(
        id="payment",
        input="支付回调 10:20 开始失败，第三方返回 502，待补复盘。",
        bucket_type="incident",
        expected_summary_terms=["支付回调", "502"],
        expected_todo_terms=["复盘"],
        expected_evidence_terms=["502"],
        expected_timeline_terms=["10:20"],
        forbidden_terms=["退款", "503"],
    )


def test_extraction_fixture_is_human_authored_and_covers_core_fields():
    cases = load_extraction_cases("tests/fixtures/extraction_cases.json")

    assert len(cases) >= 3
    assert {case.bucket_type for case in cases} >= {"incident", "experiment", "meeting"}
    assert any(case.expected_todo_terms for case in cases)
    assert any(case.expected_evidence_terms for case in cases)
    assert any(case.expected_timeline_terms for case in cases)
    assert any(case.expected_decision_terms for case in cases)
    assert all(case.forbidden_terms for case in cases)


def test_faithful_extraction_has_full_term_recall_and_no_risk_flags():
    case = _payment_case()
    prediction = ExtractionPrediction(
        id=case.id,
        result=ExtractionResult(
            summary="支付回调从 10:20 起失败，第三方返回 502。",
            todos=["补充故障复盘"],
            evidences=["第三方返回 502"],
            timeline_events=[
                TimelineEventExtract(event_time="10:20", text="支付回调开始失败")
            ],
        ),
    )

    metrics = evaluate_extractions([case], [prediction])

    assert metrics.summary_term_recall == 1.0
    assert metrics.todo_term_recall == 1.0
    assert metrics.evidence_term_recall == 1.0
    assert metrics.timeline_term_recall == 1.0
    # No expected decisions means there is nothing to recall, so recall is 1.0.
    assert metrics.decision_term_recall == 1.0
    assert metrics.forbidden_term_violation_count == 0
    assert metrics.novel_numeric_claim_count == 0


def test_extraction_evaluation_flags_omissions_forbidden_terms_and_new_numbers():
    case = _payment_case()
    prediction = ExtractionPrediction(
        id=case.id,
        result=ExtractionResult(
            summary="支付回调失败，随后执行退款，错误码为 503。",
        ),
    )

    metrics = evaluate_extractions([case], [prediction])
    check = metrics.case_checks[0]

    assert check.missing_summary_terms == ["502"]
    assert check.missing_todo_terms == ["复盘"]
    assert check.missing_evidence_terms == ["502"]
    assert check.missing_timeline_terms == ["10:20"]
    assert check.forbidden_term_matches == ["退款", "503"]
    assert check.novel_numeric_claims == ["503"]
    assert metrics.forbidden_term_violation_count == 2
    assert metrics.novel_numeric_claim_count == 1


def test_numeric_risk_check_treats_source_percentage_and_plain_number_as_equivalent():
    case = ExtractionCase(
        id="cpu",
        input="CPU 85%。",
        bucket_type="experiment",
    )
    prediction = ExtractionPrediction(
        id="cpu",
        result=ExtractionResult(summary="CPU 为 85。"),
    )

    metrics = evaluate_extractions([case], [prediction])

    assert metrics.novel_numeric_claim_count == 0


def test_extraction_predictions_loader_accepts_versioned_report(tmp_path):
    result = ExtractionResult(summary="支付回调返回 502")
    path = tmp_path / "report.json"
    path.write_text(
        json.dumps(
            {
                "model_name": "test-model",
                "prompt_version": "extraction-v1",
                "predictions": [{"id": "payment", "result": result.model_dump()}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    predictions = load_extraction_predictions(path)

    assert predictions == [ExtractionPrediction(id="payment", result=result)]


def test_extraction_evaluation_rejects_prediction_id_mismatch():
    with pytest.raises(ValueError, match="prediction ids mismatch"):
        evaluate_extractions(
            [_payment_case()],
            [
                ExtractionPrediction(
                    id="other",
                    result=ExtractionResult(summary="无关结果"),
                )
            ],
        )
