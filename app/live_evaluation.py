"""Optional real-model classification evaluation; ordinary Pytest never calls it."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from app.evaluation import (
    ClassificationPrediction,
    evaluate_classification,
    load_classification_cases,
)
from app.schemas import BucketView
from app.services.classify_service import classify_input


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run classification cases with the configured model"
    )
    parser.add_argument("--cases", default="tests/fixtures/classification_cases.json")
    parser.add_argument("--output", default="classification-live-predictions.json")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    cases = load_classification_cases(args.cases)
    selected = cases[: args.limit] if args.limit else cases
    predictions: list[ClassificationPrediction] = []
    reference_time = datetime(2026, 8, 3, tzinfo=timezone.utc)

    for index, case in enumerate(selected, start=1):
        buckets = [
            BucketView(
                id=bucket.id,
                title=bucket.title,
                type=bucket.type,
                status=bucket.status,
                summary=bucket.summary,
                last_active_at=reference_time,
            )
            for bucket in case.buckets
        ]
        result = classify_input(
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
            f"[{index}/{len(selected)}] {case.id}: "
            f"{result.action} ({result.confidence:.2f})"
        )

    output_path = Path(args.output)
    output_path.write_text(
        json.dumps(
            [item.model_dump() for item in predictions],
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    metrics = evaluate_classification(selected, predictions)
    print(metrics.model_dump_json(indent=2))
    print(f"predictions saved to {output_path}")


if __name__ == "__main__":
    main()
