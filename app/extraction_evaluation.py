"""Deterministic checks for structured extraction quality and hallucination risk."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas import BucketTypeValue, ExtractionResult

_NUMBER_PATTERN = re.compile(r"\d+(?:\.\d+)?%?")


class ExtractionCase(BaseModel):
    """Human-authored expectations for one extraction input."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str
    input: str
    bucket_type: BucketTypeValue
    expected_summary_terms: list[str] = Field(default_factory=list)
    expected_todo_terms: list[str] = Field(default_factory=list)
    expected_evidence_terms: list[str] = Field(default_factory=list)
    expected_timeline_terms: list[str] = Field(default_factory=list)
    expected_decision_terms: list[str] = Field(default_factory=list)
    forbidden_terms: list[str] = Field(default_factory=list)

    @field_validator("id", "input")
    @classmethod
    def required_text(cls, value: str) -> str:
        if not value:
            raise ValueError("case id and input must not be empty")
        return value


class ExtractionPrediction(BaseModel):
    """One structured extraction paired with its fixture ID."""

    model_config = ConfigDict(extra="forbid")

    id: str
    result: ExtractionResult


class ExtractionCaseCheck(BaseModel):
    """Detailed deterministic findings that support manual review."""

    id: str
    missing_summary_terms: list[str]
    missing_todo_terms: list[str]
    missing_evidence_terms: list[str]
    missing_timeline_terms: list[str]
    missing_decision_terms: list[str]
    forbidden_term_matches: list[str]
    novel_numeric_claims: list[str]


class ExtractionMetrics(BaseModel):
    """Aggregate recall and high-risk fabrication indicators."""

    total: int
    summary_term_recall: float
    todo_term_recall: float
    evidence_term_recall: float
    timeline_term_recall: float
    decision_term_recall: float
    forbidden_term_violation_count: int
    novel_numeric_claim_count: int
    case_checks: list[ExtractionCaseCheck]


def _normalize(value: str) -> str:
    return "".join(value.casefold().split())


def _missing_terms(expected: list[str], values: list[str]) -> list[str]:
    haystack = _normalize("\n".join(values))
    return [term for term in expected if _normalize(term) not in haystack]


def _result_text(result: ExtractionResult) -> list[str]:
    timeline = [
        " ".join(part for part in (event.event_time, event.text) if part)
        for event in result.timeline_events
    ]
    return [
        result.summary,
        *result.todos,
        *result.evidences,
        *timeline,
        *result.decisions,
        *result.hypotheses,
        *result.entities,
        *result.tags,
    ]


def _numeric_claims(value: str) -> set[str]:
    # Treat ``85`` and ``85%`` as the same source number for this coarse risk
    # check. The evaluator flags source-absent numbers; it does not decide
    # whether changing a unit or percentage meaning is semantically faithful.
    return {match.removesuffix("%") for match in _NUMBER_PATTERN.findall(value)}


def load_extraction_cases(path: str | Path) -> list[ExtractionCase]:
    """Load a unique, human-authored extraction fixture."""

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("extraction fixture must be a JSON array")
    cases = [ExtractionCase.model_validate(item) for item in data]
    ids = [case.id for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("extraction case ids must be unique")
    return cases


def load_extraction_predictions(path: str | Path) -> list[ExtractionPrediction]:
    """Load a prediction array or a versioned live-evaluation report."""

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("predictions")
    if not isinstance(data, list):
        raise ValueError(
            "prediction file must be a JSON array or contain a predictions array"
        )
    return [ExtractionPrediction.model_validate(item) for item in data]


def _recall(total_terms: int, missing_terms: int) -> float:
    return (total_terms - missing_terms) / total_terms if total_terms else 1.0


def evaluate_extractions(
    cases: list[ExtractionCase],
    predictions: list[ExtractionPrediction],
) -> ExtractionMetrics:
    """Check required facts and flag forbidden or source-absent numeric claims.

    These checks deliberately do not produce a single "quality score". Semantic
    faithfulness and subtle hallucinations still require human review of the
    saved raw output.
    """

    if not cases:
        raise ValueError("at least one extraction case is required")
    by_id = {prediction.id: prediction for prediction in predictions}
    if len(by_id) != len(predictions):
        raise ValueError("prediction ids must be unique")
    expected_ids = {case.id for case in cases}
    if set(by_id) != expected_ids:
        raise ValueError("prediction ids mismatch extraction case ids")

    field_totals = {
        "summary": 0,
        "todo": 0,
        "evidence": 0,
        "timeline": 0,
        "decision": 0,
    }
    field_missing = dict.fromkeys(field_totals, 0)
    checks: list[ExtractionCaseCheck] = []

    for case in cases:
        result = by_id[case.id].result
        timeline_values = [
            " ".join(part for part in (event.event_time, event.text) if part)
            for event in result.timeline_events
        ]
        missing = {
            "summary": _missing_terms(
                case.expected_summary_terms,
                [result.summary],
            ),
            "todo": _missing_terms(case.expected_todo_terms, result.todos),
            "evidence": _missing_terms(
                case.expected_evidence_terms,
                result.evidences,
            ),
            "timeline": _missing_terms(
                case.expected_timeline_terms,
                timeline_values,
            ),
            "decision": _missing_terms(
                case.expected_decision_terms,
                result.decisions,
            ),
        }
        expected_by_field = {
            "summary": case.expected_summary_terms,
            "todo": case.expected_todo_terms,
            "evidence": case.expected_evidence_terms,
            "timeline": case.expected_timeline_terms,
            "decision": case.expected_decision_terms,
        }
        for field, expected in expected_by_field.items():
            field_totals[field] += len(expected)
            field_missing[field] += len(missing[field])

        output_text = "\n".join(_result_text(result))
        normalized_output = _normalize(output_text)
        forbidden_matches = [
            term
            for term in case.forbidden_terms
            if _normalize(term) in normalized_output
        ]
        novel_numbers = sorted(
            _numeric_claims(output_text) - _numeric_claims(case.input)
        )
        checks.append(
            ExtractionCaseCheck(
                id=case.id,
                missing_summary_terms=missing["summary"],
                missing_todo_terms=missing["todo"],
                missing_evidence_terms=missing["evidence"],
                missing_timeline_terms=missing["timeline"],
                missing_decision_terms=missing["decision"],
                forbidden_term_matches=forbidden_matches,
                novel_numeric_claims=novel_numbers,
            )
        )

    return ExtractionMetrics(
        total=len(cases),
        summary_term_recall=_recall(
            field_totals["summary"], field_missing["summary"]
        ),
        todo_term_recall=_recall(field_totals["todo"], field_missing["todo"]),
        evidence_term_recall=_recall(
            field_totals["evidence"], field_missing["evidence"]
        ),
        timeline_term_recall=_recall(
            field_totals["timeline"], field_missing["timeline"]
        ),
        decision_term_recall=_recall(
            field_totals["decision"], field_missing["decision"]
        ),
        forbidden_term_violation_count=sum(
            len(check.forbidden_term_matches) for check in checks
        ),
        novel_numeric_claim_count=sum(
            len(check.novel_numeric_claims) for check in checks
        ),
        case_checks=checks,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate extraction predictions")
    parser.add_argument("predictions", help="JSON predictions or live report")
    parser.add_argument(
        "--cases",
        default="tests/fixtures/extraction_cases.json",
    )
    args = parser.parse_args()

    metrics = evaluate_extractions(
        load_extraction_cases(args.cases),
        load_extraction_predictions(args.predictions),
    )
    print(metrics.model_dump_json(indent=2))


if __name__ == "__main__":
    main()
