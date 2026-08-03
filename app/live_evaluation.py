"""Optional real-model classification evaluation; ordinary Pytest never calls it."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from app.evaluation import (
    ClassificationCase,
    ClassificationMetrics,
    ClassificationPrediction,
    evaluate_classification,
    load_classification_cases,
)
from app.llm import configured_model
from app.prompts import CLASSIFICATION_PROMPT_VERSION
from app.schemas import BucketView, ClassificationResult
from app.services.classify_service import classify_input

Classifier = Callable[..., ClassificationResult]


class LiveClassificationReport(BaseModel):
    """Versioned artifact produced by a real-model classification run."""

    model_config = ConfigDict(extra="forbid")

    generated_at: datetime
    model_name: str
    prompt_version: str
    cases_path: str
    case_count: int
    predictions: list[ClassificationPrediction]
    metrics: ClassificationMetrics


def run_live_classification(
    cases: Sequence[ClassificationCase],
    *,
    classifier: Classifier = classify_input,
    model_name: str | None = None,
    cases_path: str = "tests/fixtures/classification_cases.json",
    generated_at: datetime | None = None,
) -> LiveClassificationReport:
    """Run selected cases and retain enough metadata for reproducibility."""

    if not cases:
        raise ValueError("at least one classification case is required")

    active_model = configured_model(model_name)
    active_time = generated_at or datetime.now(timezone.utc)
    predictions: list[ClassificationPrediction] = []

    for index, case in enumerate(cases, start=1):
        buckets = [
            BucketView(
                id=bucket.id,
                title=bucket.title,
                type=bucket.type,
                status=bucket.status,
                summary=bucket.summary,
                last_active_at=active_time,
            )
            for bucket in case.buckets
        ]
        result = classifier(
            case.input,
            buckets,
            current_focus_bucket_id=case.current_focus_bucket_id,
        )
        predictions.append(
            ClassificationPrediction(
                id=case.id,
                action=result.action,
                bucket_id=result.bucket_id,
                confidence=result.confidence,
                should_ask_user=result.should_ask_user,
            )
        )
        print(
            f"[{index}/{len(cases)}] {case.id}: "
            f"{result.action} ({result.confidence:.2f})"
        )

    return LiveClassificationReport(
        generated_at=active_time,
        model_name=active_model,
        prompt_version=CLASSIFICATION_PROMPT_VERSION,
        cases_path=cases_path,
        case_count=len(cases),
        predictions=predictions,
        metrics=evaluate_classification(list(cases), predictions),
    )


def write_live_classification_report(
    report: LiveClassificationReport,
    output_path: str | Path,
) -> Path:
    """Write a versioned JSON artifact and create its parent directory."""

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run classification cases with the configured model"
    )
    parser.add_argument("--cases", default="tests/fixtures/classification_cases.json")
    parser.add_argument("--output", default="classification-live-report.json")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")

    cases = load_classification_cases(args.cases)
    selected = cases[: args.limit] if args.limit else cases
    report = run_live_classification(
        selected,
        cases_path=args.cases,
    )
    output_path = write_live_classification_report(report, args.output)
    print(report.metrics.model_dump_json(indent=2))
    print(f"report saved to {output_path}")


if __name__ == "__main__":
    main()
