"""Pydantic contracts for classification and information extraction."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Self

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


BucketStatusValue = Literal["active", "paused", "done", "archived"]
ArchiveStatus = Literal["archived", "needs_confirmation"]


class BucketView(OutputSchema):
    """Bounded Bucket context exposed to the classifier."""

    id: str
    title: str
    type: BucketTypeValue
    status: BucketStatusValue
    summary: str = ""
    tags: list[str] = Field(default_factory=list)
    last_active_at: datetime

    @field_validator("id", "title")
    @classmethod
    def required_bucket_text(cls, value: str) -> str:
        if not value:
            raise ValueError("bucket id and title must not be empty")
        return value

    @field_validator("tags", mode="before")
    @classmethod
    def normalize_bucket_tags(cls, value: object) -> object:
        return _normalize_string_list(value)


class BucketSummaryResult(OutputSchema):
    """A compact rolling summary for a long-lived Bucket."""

    summary: str

    @field_validator("summary")
    @classmethod
    def summary_must_have_content(cls, value: str) -> str:
        if not value:
            raise ValueError("summary must not be empty")
        return value


class ArchiveResult(OutputSchema):
    """User-facing result of one archive attempt."""

    status: ArchiveStatus
    action: ClassificationAction
    bucket_id: str | None = None
    bucket_title: str | None = None
    bucket_type: BucketTypeValue | None = None
    entry_id: str | None = None
    confidence: float
    reason: str
    question: str | None = None
    candidate_bucket_ids: list[str] = Field(default_factory=list)
    extraction: ExtractionResult | None = None

    @field_validator("confidence")
    @classmethod
    def archive_confidence_is_probability(cls, value: float) -> float:
        if not 0 <= value <= 1:
            raise ValueError("confidence must be between 0 and 1")
        return value


ChatRoleValue = Literal["user", "assistant", "tool"]


class ChatMessageView(OutputSchema):
    """Persisted message shown in the single conversation timeline."""

    id: str
    role: ChatRoleValue
    content: str
    tool_name: str | None = None
    tool_call_id: str | None = None
    details: dict[str, Any] | list[Any] | None = None
    created_at: datetime


class AgentTurnResult(OutputSchema):
    """Final assistant answer and the bounded tool activity for one turn."""

    assistant_message: ChatMessageView
    tool_messages: list[ChatMessageView] = Field(default_factory=list)


class BucketSearchResult(OutputSchema):
    """Compact search result for one matching Bucket."""

    bucket_id: str
    title: str
    bucket_type: BucketTypeValue
    status: BucketStatusValue
    summary: str
    tags: list[str] = Field(default_factory=list)
    last_active_at: datetime
    matched_entry_count: int = 0
    score: int = 0


class ListActiveBucketsArguments(OutputSchema):
    """Arguments for listing recent active Buckets."""


class SearchMemoryArguments(OutputSchema):
    """Arguments for keyword memory search."""

    query: str


class GetBucketDetailArguments(OutputSchema):
    """Arguments for loading one Bucket detail."""

    bucket_id: str


class ArchiveMemoryArguments(OutputSchema):
    """Arguments for risk-gated automatic memory archival."""

    text: str


class SaveToExistingBucketArguments(OutputSchema):
    """Arguments for a user-confirmed append."""

    bucket_id: str
    text: str


class CreateBucketAndSaveArguments(OutputSchema):
    """Arguments for a user-confirmed Bucket creation and append."""

    title: str
    bucket_type: BucketTypeValue
    text: str
