"""Pydantic contracts for classification and information extraction."""

from __future__ import annotations

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

BucketTypeValue = Literal[
    "idea",
    "task",
    "incident",
    "experiment",
    "decision",
    "meeting",
    "knowledge",
    "draft",
]
ClassificationAction = Literal["append_existing", "create_new", "ask_user"]


class OutputSchema(BaseModel):
    """Shared configuration for model-generated application contracts."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
    )


class ClassificationResult(OutputSchema):
    """The routing decision for one user input."""

    action: ClassificationAction = Field(
        description="Append to an existing bucket, create one, or ask the user."
    )
    bucket_id: str | None = Field(
        default=None,
        description="Existing bucket ID when action is append_existing.",
    )
    bucket_type: BucketTypeValue | None = Field(
        default=None,
        description="Selected type for a new bucket or the matched bucket type.",
    )
    title: str | None = Field(
        default=None,
        description="Concise new bucket title when action is create_new.",
    )
    confidence: float = Field(
        description="Confidence score between 0 and 1."
    )
    reason: str = Field(
        description="Short evidence-based explanation for the routing decision."
    )
    should_ask_user: bool = Field(
        default=False,
        description="Whether user confirmation is required before persistence.",
    )
    question: str | None = Field(
        default=None,
        description="Clarifying question when action is ask_user.",
    )
    candidate_bucket_ids: list[str] = Field(
        default_factory=list,
        description="Likely bucket IDs to present when asking the user.",
    )

    @field_validator("bucket_id", "title", "question", mode="before")
    @classmethod
    def empty_optional_text_becomes_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("reason")
    @classmethod
    def reason_must_not_be_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("reason must not be empty")
        return value

    @field_validator("confidence")
    @classmethod
    def confidence_must_be_probability(cls, value: float) -> float:
        if not 0 <= value <= 1:
            raise ValueError("confidence must be between 0 and 1")
        return value

    @field_validator("candidate_bucket_ids", mode="before")
    @classmethod
    def normalize_candidate_ids(cls, value: object) -> object:
        return _normalize_string_list(value)

    @model_validator(mode="after")
    def action_fields_must_be_consistent(self) -> Self:
        if self.action == "append_existing":
            if self.bucket_id is None:
                raise ValueError("append_existing requires bucket_id")
            if self.should_ask_user or self.question is not None:
                raise ValueError("append_existing cannot request user confirmation")

        elif self.action == "create_new":
            if self.bucket_id is not None:
                raise ValueError("create_new must not include bucket_id")
            if self.bucket_type is None or self.title is None:
                raise ValueError("create_new requires bucket_type and title")
            if self.should_ask_user or self.question is not None:
                raise ValueError("create_new cannot request user confirmation")

        elif self.action == "ask_user":
            if not self.should_ask_user:
                raise ValueError("ask_user requires should_ask_user=true")
            if self.question is None:
                raise ValueError("ask_user requires question")

        return self


class TimelineEventExtract(OutputSchema):
    """A time expression and event extracted from the raw input."""

    event_time: str | None = Field(
        default=None,
        description="Original time expression, or null when no time is stated.",
    )
    text: str = Field(description="What happened at that time.")

    @field_validator("event_time", mode="before")
    @classmethod
    def empty_time_becomes_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("text")
    @classmethod
    def text_must_not_be_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("timeline event text must not be empty")
        return value


class ExtractionResult(OutputSchema):
    """Structured work-memory facts extracted from one raw entry."""

    summary: str = Field(description="Faithful one-sentence summary of the input.")
    todos: list[str] = Field(
        default_factory=list,
        description="Concrete actions that still need to be completed.",
    )
    evidences: list[str] = Field(
        default_factory=list,
        description="Logs, metrics, observations, test results, or user feedback.",
    )
    timeline_events: list[TimelineEventExtract] = Field(
        default_factory=list,
        description="Events with their original time expressions when available.",
    )
    decisions: list[str] = Field(
        default_factory=list,
        description="Decisions or actions already taken.",
    )
    hypotheses: list[str] = Field(
        default_factory=list,
        description="Unverified explanations or claims that still need validation.",
    )
    entities: list[str] = Field(
        default_factory=list,
        description="Important systems, APIs, customers, projects, or components.",
    )
    tags: list[str] = Field(
        default_factory=list,
        description="Short labels useful for keyword search.",
    )

    @field_validator("summary")
    @classmethod
    def summary_must_not_be_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("summary must not be empty")
        return value

    @field_validator(
        "todos",
        "evidences",
        "decisions",
        "hypotheses",
        "entities",
        "tags",
        mode="before",
    )
    @classmethod
    def normalize_extracted_text_lists(cls, value: object) -> object:
        return _normalize_string_list(value)


def _normalize_string_list(value: object) -> object:
    """Trim, remove empty values, and de-duplicate string lists in order."""

    if value is None:
        return []
    if not isinstance(value, list):
        return value

    normalized: list[object] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            normalized.append(item)
            continue

        cleaned = item.strip()
        if cleaned and cleaned not in seen:
            normalized.append(cleaned)
            seen.add(cleaned)

    return normalized
