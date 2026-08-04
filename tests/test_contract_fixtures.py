"""Shared golden tests for Python and Rust JSON boundary contracts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from app.schemas import (
    AgentTurnResult,
    ArchiveResult,
    BucketSearchResult,
    BucketSummaryResult,
    BucketView,
    ChatMessageView,
    ClassificationResult,
    ExtractionResult,
)
from app.services.agent_service import validate_agent_tool_arguments

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "contract_cases.json"
CONTRACT_CASES = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

SCHEMAS: dict[str, type[BaseModel]] = {
    "classification": ClassificationResult,
    "extraction": ExtractionResult,
    "bucket_summary": BucketSummaryResult,
    "archive": ArchiveResult,
    "bucket_view": BucketView,
    "chat_message": ChatMessageView,
    "agent_turn": AgentTurnResult,
    "bucket_search": BucketSearchResult,
}


def _cases(kind: str) -> list[Any]:
    return [
        pytest.param(contract, case, id=f"{contract}:{case['id']}")
        for contract, suite in CONTRACT_CASES.items()
        for case in suite[kind]
    ]


def _validate(contract: str, case: dict[str, Any]) -> dict[str, Any]:
    if contract == "agent_tool_arguments":
        return validate_agent_tool_arguments(case["tool"], case["input"])
    return SCHEMAS[contract].model_validate(case["input"]).model_dump(mode="json")


@pytest.mark.parametrize("contract,case", _cases("valid"))
def test_valid_contract_fixture_matches_normalized_json(
    contract: str,
    case: dict[str, Any],
) -> None:
    assert _validate(contract, case) == case["expected"]


@pytest.mark.parametrize("contract,case", _cases("invalid"))
def test_invalid_contract_fixture_is_rejected(
    contract: str,
    case: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        _validate(contract, case)
