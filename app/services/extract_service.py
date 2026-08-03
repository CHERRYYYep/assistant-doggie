"""LLM-backed structured extraction for one raw user input."""

from __future__ import annotations

from datetime import date
from typing import Callable

from pydantic import BaseModel

from app.llm import parse_with_schema
from app.prompts import EXTRACTION_SYSTEM_PROMPT, build_extraction_user_prompt
from app.schemas import ExtractionResult

SchemaParser = Callable[[str, str, type[BaseModel]], BaseModel]


def extract_info(
    text: str,
    *,
    bucket_type: str | None = None,
    current_date: date | None = None,
    parser: SchemaParser = parse_with_schema,
) -> ExtractionResult:
    """Extract faithful work-memory facts from one input using Structured Outputs."""

    cleaned = text.strip()
    if not cleaned:
        raise ValueError("text must not be empty")

    parsed = parser(
        EXTRACTION_SYSTEM_PROMPT,
        build_extraction_user_prompt(
            cleaned,
            current_date=current_date,
            bucket_type=bucket_type,
        ),
        ExtractionResult,
    )
    return ExtractionResult.model_validate(parsed)
