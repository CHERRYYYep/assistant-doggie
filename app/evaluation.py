"""Classification evaluation fixtures, metrics, and command-line reporting."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas import BucketStatusValue, BucketTypeValue, ClassificationAction

ErrorCost = Literal["low", "medium", "high"]


class EvaluationBucket(BaseModel):
    """Minimal candidate Bucket stored in the human-labelled fixture."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str
    title: str
    type: BucketTypeValue
    status: BucketStatusValue = "active"
    summary: str = ""


class ClassificationCase(BaseModel):
    """Human-labelled routing truth for one input and candidate set."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str
    input: str
    current_focus_bucket_id: str | None = None
    buckets: list[EvaluationBucket] = Field(default_factory=list)
    expected_action: ClassificationAction
    expected_bucket_id: str | None = None
    should_ask_user: bool
    error_cost: ErrorCost

    @field_validator("id", "input")
    @classmethod
    def required_text(cls, value: str) -> str:
        if not value:
            raise ValueError("case id and input must not be empty")
        return value

    @model_validator(mode="after")
    def expected_fields_are_consistent(self):
        candidate_ids = {bucket.id for bucket in self.buckets}
        if self.current_focus_bucket_id not in candidate_ids | {None}:
            raise ValueError("current_focus_bucket_id must reference a candidate")
        if self.expected_action == "append_existing":
            if self.expected_bucket_id not in candidate_ids:
                raise ValueError("append_existing expected_bucket_id must be a candidate")
            if self.should_ask_user:
                raise ValueError("append_existing cannot expect a user question")
        elif self.expected_action == "ask_user" and not self.should_ask_user:
            raise ValueError("ask_user case must set should_ask_user=true")
        elif self.expected_action == "create_new" and self.expected_bucket_id is not None:
            raise ValueError("create_new must not define expected_bucket_id")
        return self


class ClassificationPrediction(BaseModel):
    """Normalized prediction consumed by the evaluator."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str
    action: ClassificationAction
    bucket_id: str | None = None
    confidence: float
    should_ask_user: bool = False

    @field_validator("confidence")
    @classmethod
    def confidence_is_probability(cls, value: float) -> float:
        if not 0 <= value <= 1:
            raise ValueError("confidence must be between 0 and 1")
        return value


class ConfidenceBandMetrics(BaseModel):
    count: int
    accuracy: float
    ask_user_rate: float


class ClassificationMetrics(BaseModel):
    total: int
    action_accuracy: float
    existing_bucket_accuracy: float
    auto_archive_accuracy: float
    ask_user_recall: float
    severe_mismerge_count: int
    confidence_bands: dict[str, ConfidenceBandMetrics]


def load_classification_cases(path: str | Path) -> list[ClassificationCase]:
    """Load and validate a human-labelled JSON fixture."""

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("classification fixture must be a JSON array")
    cases = [ClassificationCase.model_validate(item) for item in data]
    ids = [case.id for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("classification case ids must be unique")
    return cases


def load_predictions(path: str | Path) -> list[ClassificationPrediction]:
    """Load a prediction array or a versioned live-evaluation report."""

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("predictions")
    if not isinstance(data, list):
        raise ValueError(
            "prediction file must be a JSON array or contain a predictions array"
        )
    return [ClassificationPrediction.model_validate(item) for item in data]


def _correct(case: ClassificationCase, prediction: ClassificationPrediction) -> bool:
    if prediction.action != case.expected_action:
        return False
    if case.expected_action == "append_existing":
        return prediction.bucket_id == case.expected_bucket_id
    return prediction.should_ask_user == case.should_ask_user


def evaluate_classification(
    cases: list[ClassificationCase],
    predictions: list[ClassificationPrediction],
) -> ClassificationMetrics:
    """Calculate routing, safety, and confidence-band metrics."""

    if not cases:
        raise ValueError("at least one classification case is required")
    by_id = {prediction.id: prediction for prediction in predictions}
    if len(by_id) != len(predictions):
        raise ValueError("prediction ids must be unique")
    missing = [case.id for case in cases if case.id not in by_id]
    extra = sorted(set(by_id) - {case.id for case in cases})
    if missing or extra:
        raise ValueError(f"prediction ids mismatch; missing={missing}, extra={extra}")

    action_correct = 0
    append_total = 0
    append_correct = 0
    auto_total = 0
    auto_correct = 0
    ask_total = 0
    ask_correct = 0
    severe_mismerge_count = 0
    bands: dict[str, list[tuple[bool, bool]]] = defaultdict(list)

    for case in cases:
        prediction = by_id[case.id]
        is_correct = _correct(case, prediction)
        action_correct += prediction.action == case.expected_action

        if case.expected_action == "append_existing":
            append_total += 1
            append_correct += (
                prediction.action == "append_existing"
                and prediction.bucket_id == case.expected_bucket_id
            )

        if prediction.action != "ask_user":
            auto_total += 1
            auto_correct += is_correct

        if case.expected_action == "ask_user":
            ask_total += 1
            ask_correct += prediction.action == "ask_user" and prediction.should_ask_user

        wrong_append = prediction.action == "append_existing" and (
            case.expected_action != "append_existing"
            or prediction.bucket_id != case.expected_bucket_id
        )
        if case.error_cost == "high" and wrong_append:
            severe_mismerge_count += 1

        if prediction.confidence < 0.55:
            band = "low"
        elif prediction.confidence < 0.85:
            band = "medium"
        else:
            band = "high"
        bands[band].append((is_correct, prediction.action == "ask_user"))

    band_metrics = {}
    for name in ("low", "medium", "high"):
        values = bands.get(name, [])
        count = len(values)
        band_metrics[name] = ConfidenceBandMetrics(
            count=count,
            accuracy=sum(correct for correct, _ in values) / count if count else 0.0,
            ask_user_rate=sum(asked for _, asked in values) / count if count else 0.0,
        )

    total = len(cases)
    return ClassificationMetrics(
        total=total,
        action_accuracy=action_correct / total,
        existing_bucket_accuracy=append_correct / append_total if append_total else 0.0,
        auto_archive_accuracy=auto_correct / auto_total if auto_total else 0.0,
        ask_user_recall=ask_correct / ask_total if ask_total else 0.0,
        severe_mismerge_count=severe_mismerge_count,
        confidence_bands=band_metrics,
    )


def keyword_baseline_predictions(
    cases: list[ClassificationCase],
) -> list[ClassificationPrediction]:
    """Produce a transparent, non-LLM routing baseline for comparison.

    The heuristic intentionally uses only the input, focus, and candidate
    metadata. It never reads expected labels, so the fixture remains valid as
    evaluation truth.
    """

    explicit_new_markers = (
        "新开",
        "新建",
        "单独",
        "另开",
        "另一个",
        "另记",
        "开始写",
        "开始准备",
        "建立一个独立",
    )
    vague_markers = (
        "刚才那个",
        "继续刚才",
        "这个事情",
        "它现在",
        "这个结论",
        "上次",
        "那个问题",
        "接口问题",
        "支付相关",
    )
    continuation_markers = (
        "继续",
        "刚才",
        "这个",
        "那个",
        "补充",
        "更新",
        "已经",
        "现在",
        "恢复",
        "完成",
    )

    predictions: list[ClassificationPrediction] = []
    for case in cases:
        text = case.input
        candidate_ids = [bucket.id for bucket in case.buckets]

        if any(marker in text for marker in explicit_new_markers):
            action = "create_new"
            bucket_id = None
            confidence = 0.90
        elif not case.buckets:
            if any(marker in text for marker in vague_markers + continuation_markers):
                action = "ask_user"
                bucket_id = None
                confidence = 0.35
            else:
                action = "create_new"
                bucket_id = None
                confidence = 0.75
        else:
            scored: list[tuple[int, str]] = []
            for bucket in case.buckets:
                score = 0
                keywords = (
                    "支付",
                    "接口",
                    "压测",
                    "会议",
                    "评审",
                    "Agent",
                    "Pydantic",
                    "稳定性",
                    "数据库",
                )
                for token in keywords:
                    input_matches = token.casefold() in text.casefold()
                    bucket_text = bucket.title + bucket.summary
                    if input_matches and token.casefold() in bucket_text.casefold():
                        score += 2
                if bucket.id == case.current_focus_bucket_id and any(
                    marker in text for marker in continuation_markers
                ):
                    score += 3
                scored.append((score, bucket.id))
            scored.sort(reverse=True)
            best_score = scored[0][0]
            best_ids = [bucket_id for score, bucket_id in scored if score == best_score]

            is_vague = any(marker in text for marker in vague_markers)
            if best_score == 0 or len(best_ids) > 1 or is_vague:
                action = "ask_user"
                bucket_id = None
                confidence = 0.40
            else:
                action = "append_existing"
                bucket_id = best_ids[0]
                confidence = 0.88

        predictions.append(
            ClassificationPrediction(
                id=case.id,
                action=action,
                bucket_id=bucket_id,
                confidence=confidence,
                should_ask_user=action == "ask_user",
            )
        )
    return predictions


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Bucket classifications")
    parser.add_argument("predictions", nargs="?", help="JSON file containing model predictions")
    parser.add_argument(
        "--cases",
        default="tests/fixtures/classification_cases.json",
        help="human-labelled fixture path",
    )
    parser.add_argument(
        "--baseline",
        action="store_true",
        help="evaluate the transparent keyword baseline instead of a prediction file",
    )
    args = parser.parse_args()

    cases = load_classification_cases(args.cases)
    if args.baseline:
        predictions = keyword_baseline_predictions(cases)
    elif args.predictions:
        predictions = load_predictions(args.predictions)
    else:
        parser.error("provide predictions or use --baseline")
    metrics = evaluate_classification(cases, predictions)
    print(metrics.model_dump_json(indent=2))


if __name__ == "__main__":
    main()
