"""Optional real-model extraction evaluation with reproducible artifacts."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from datetime import date, datetime, timezone
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from app.extraction_evaluation import (
    ExtractionCase,
    ExtractionMetrics,
    ExtractionPrediction,
    evaluate_extractions,
    load_extraction_cases,
)
from app.llm import LLMApiMode, configured_endpoint, configured_model
from app.prompts import EXTRACTION_PROMPT_VERSION
from app.schemas import ExtractionResult
from app.services.extract_service import extract_info

Extractor = Callable[..., ExtractionResult]


class LiveExtractionReport(BaseModel):
    """Versioned artifact for factual and manual extraction review."""

    model_config = ConfigDict(extra="forbid")

    generated_at: datetime
    reference_date: date
    model_name: str
    api_site: str
    api_base_url: str
    api_mode: LLMApiMode
    prompt_version: str
    cases_path: str
    case_count: int
    predictions: list[ExtractionPrediction]
    metrics: ExtractionMetrics


def run_live_extraction(
    cases: Sequence[ExtractionCase],
    *,
    extractor: Extractor = extract_info,
    model_name: str | None = None,
    cases_path: str = "tests/fixtures/extraction_cases.json",
    reference_date: date | None = None,
    generated_at: datetime | None = None,
) -> LiveExtractionReport:
    """Run extraction cases and retain raw structured output for review."""

    if not cases:
        raise ValueError("at least one extraction case is required")

    active_model = configured_model(model_name)
    active_endpoint = configured_endpoint()
    active_date = reference_date or date.today()
    active_time = generated_at or datetime.now(timezone.utc)
    predictions: list[ExtractionPrediction] = []

    for index, case in enumerate(cases, start=1):
        result = extractor(
            case.input,
            bucket_type=case.bucket_type,
            current_date=active_date,
        )
        predictions.append(ExtractionPrediction(id=case.id, result=result))
        print(f"[{index}/{len(cases)}] {case.id}: {result.summary}")

    return LiveExtractionReport(
        generated_at=active_time,
        reference_date=active_date,
        model_name=active_model,
        api_site=active_endpoint.site,
        api_base_url=active_endpoint.base_url,
        api_mode=active_endpoint.api_mode,
        prompt_version=EXTRACTION_PROMPT_VERSION,
        cases_path=cases_path,
        case_count=len(cases),
        predictions=predictions,
        metrics=evaluate_extractions(list(cases), predictions),
    )


def write_live_extraction_report(
    report: LiveExtractionReport,
    output_path: str | Path,
) -> Path:
    """Write the full report so a human can inspect possible hallucinations."""

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run extraction cases with the configured model"
    )
    parser.add_argument("--cases", default="tests/fixtures/extraction_cases.json")
    parser.add_argument("--output", default="extraction-live-report.json")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--reference-date", type=date.fromisoformat, default=date.today())
    args = parser.parse_args()

    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")

    cases = load_extraction_cases(args.cases)
    selected = cases[: args.limit] if args.limit else cases
    report = run_live_extraction(
        selected,
        cases_path=args.cases,
        reference_date=args.reference_date,
    )
    output_path = write_live_extraction_report(report, args.output)
    print(report.metrics.model_dump_json(indent=2))
    print("Manual review is still required for semantic faithfulness.")
    print(f"report saved to {output_path}")


if __name__ == "__main__":
    main()
