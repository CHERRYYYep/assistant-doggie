import json

import pytest

from app.evaluation import (
    ClassificationPrediction,
    evaluate_classification,
    load_classification_cases,
)


def test_human_labelled_fixture_has_required_coverage():
    cases = load_classification_cases("tests/fixtures/classification_cases.json")

    assert len(cases) >= 50
    assert {case.expected_action for case in cases} == {
        "append_existing",
        "create_new",
        "ask_user",
    }
    assert any(case.error_cost == "high" for case in cases)
    assert any(len(case.buckets) > 1 for case in cases if case.should_ask_user)


def test_evaluation_metrics_cover_safety_and_confidence_bands(tmp_path):
    fixture = [
        {
            "id": "append",
            "input": "继续支付故障",
            "current_focus_bucket_id": "payment",
            "buckets": [
                {"id": "payment", "title": "支付故障", "type": "incident"},
                {"id": "api", "title": "接口治理", "type": "task"},
            ],
            "expected_action": "append_existing",
            "expected_bucket_id": "payment",
            "should_ask_user": False,
            "error_cost": "high",
        },
        {
            "id": "ambiguous",
            "input": "继续那个问题",
            "buckets": [
                {"id": "payment", "title": "支付故障", "type": "incident"},
                {"id": "api", "title": "接口治理", "type": "task"},
            ],
            "expected_action": "ask_user",
            "expected_bucket_id": None,
            "should_ask_user": True,
            "error_cost": "high",
        },
        {
            "id": "create",
            "input": "新建压测",
            "buckets": [],
            "expected_action": "create_new",
            "expected_bucket_id": None,
            "should_ask_user": False,
            "error_cost": "medium",
        },
    ]
    path = tmp_path / "cases.json"
    path.write_text(json.dumps(fixture, ensure_ascii=False))
    cases = load_classification_cases(path)
    predictions = [
        ClassificationPrediction(
            id="append",
            action="append_existing",
            bucket_id="api",
            confidence=0.92,
        ),
        ClassificationPrediction(
            id="ambiguous",
            action="ask_user",
            confidence=0.42,
            should_ask_user=True,
        ),
        ClassificationPrediction(
            id="create",
            action="create_new",
            confidence=0.70,
        ),
    ]

    metrics = evaluate_classification(cases, predictions)

    assert metrics.action_accuracy == 1.0
    assert metrics.existing_bucket_accuracy == 0.0
    assert metrics.auto_archive_accuracy == 0.5
    assert metrics.ask_user_recall == 1.0
    assert metrics.severe_mismerge_count == 1
    assert metrics.confidence_bands["high"].accuracy == 0.0
    assert metrics.confidence_bands["low"].ask_user_rate == 1.0


def test_evaluation_rejects_missing_predictions():
    cases = load_classification_cases("tests/fixtures/classification_cases.json")
    with pytest.raises(ValueError, match="prediction ids mismatch"):
        evaluate_classification(cases, [])


def test_keyword_baseline_does_not_read_expected_labels():
    from app.evaluation import keyword_baseline_predictions

    cases = load_classification_cases("tests/fixtures/classification_cases.json")
    original = keyword_baseline_predictions(cases)
    changed_case = cases[0].model_copy(
        update={"expected_action": "ask_user", "should_ask_user": True}
    )
    changed = keyword_baseline_predictions([changed_case])

    assert changed[0].action == original[0].action
    assert changed[0].bucket_id == original[0].bucket_id
