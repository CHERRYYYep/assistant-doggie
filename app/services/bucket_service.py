"""Database operations for buckets and their raw entries."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Select, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_session
from app.models import (
    Bucket,
    BucketStatus,
    BucketType,
    Decision,
    Entry,
    Evidence,
    TimelineEvent,
    Todo,
    utc_now,
)
from app.schemas import ExtractionResult


@contextmanager
def _session_scope(session: Session | None = None) -> Iterator[Session]:
    """Use a caller-owned session or safely manage a short local session."""

    owns_session = session is None
    active_session = session or get_session()
    try:
        yield active_session
        if owns_session:
            active_session.commit()
    except Exception:
        if owns_session:
            active_session.rollback()
        raise
    finally:
        if owns_session:
            active_session.close()


def _clean_required_text(value: str, field_name: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field_name} must not be empty")
    return cleaned


def _coerce_bucket_type(value: BucketType | str) -> BucketType:
    try:
        return value if isinstance(value, BucketType) else BucketType(value)
    except ValueError as exc:
        allowed = ", ".join(member.value for member in BucketType)
        raise ValueError(f"bucket_type must be one of: {allowed}") from exc


def create_bucket(
    title: str,
    bucket_type: BucketType | str,
    summary: str = "",
    tags: Sequence[str] | None = None,
    *,
    session: Session | None = None,
) -> Bucket:
    """Create an active bucket and return the persisted model."""

    bucket = Bucket(
        title=_clean_required_text(title, "title"),
        type=_coerce_bucket_type(bucket_type),
        summary=summary.strip() if summary else "",
        tags=[tag.strip() for tag in (tags or []) if tag.strip()],
    )

    with _session_scope(session) as active_session:
        active_session.add(bucket)
        active_session.flush()
        active_session.refresh(bucket)

    return bucket


def list_active_buckets(
    limit: int = 20,
    *,
    session: Session | None = None,
) -> list[Bucket]:
    """Return recently active buckets, newest activity first."""

    if limit < 1:
        raise ValueError("limit must be at least 1")

    statement = (
        select(Bucket)
        .where(Bucket.status == BucketStatus.ACTIVE)
        .order_by(Bucket.last_active_at.desc(), Bucket.updated_at.desc())
        .limit(limit)
    )
    with _session_scope(session) as active_session:
        return list(active_session.scalars(statement).all())


def get_bucket(
    bucket_id: str,
    *,
    session: Session | None = None,
) -> Bucket | None:
    """Return one bucket by ID, or ``None`` when it does not exist."""

    with _session_scope(session) as active_session:
        return active_session.get(Bucket, bucket_id)


def append_entry(
    bucket_id: str,
    raw_text: str,
    summary: str | None = None,
    *,
    content_type: str = "note",
    classification_confidence: float | None = None,
    classification_reason: str | None = None,
    session: Session | None = None,
) -> Entry:
    """Append an immutable raw entry and mark its bucket as recently active."""

    raw_text = _clean_required_text(raw_text, "raw_text")
    content_type = _clean_required_text(content_type, "content_type")
    if classification_confidence is not None and not 0 <= classification_confidence <= 1:
        raise ValueError("classification_confidence must be between 0 and 1")

    with _session_scope(session) as active_session:
        bucket = active_session.get(Bucket, bucket_id)
        if bucket is None:
            raise LookupError(f"bucket not found: {bucket_id}")

        now = utc_now()
        entry = Entry(
            bucket_id=bucket.id,
            raw_text=raw_text,
            summary=summary.strip() if summary else None,
            content_type=content_type,
            classification_confidence=classification_confidence,
            classification_reason=(
                classification_reason.strip() if classification_reason else None
            ),
            created_at=now,
        )
        bucket.updated_at = now
        bucket.last_active_at = now
        active_session.add(entry)
        active_session.flush()
        active_session.refresh(entry)

    return entry


def get_bucket_detail(
    bucket_id: str,
    *,
    session: Session | None = None,
) -> Bucket | None:
    """Return a bucket with entries and all structured child records loaded."""

    statement: Select[tuple[Bucket]] = (
        select(Bucket)
        .where(Bucket.id == bucket_id)
        .options(
            selectinload(Bucket.entries),
            selectinload(Bucket.todos),
            selectinload(Bucket.evidences),
            selectinload(Bucket.timeline_events),
            selectinload(Bucket.decisions),
        )
    )
    with _session_scope(session) as active_session:
        return active_session.scalar(statement)


@dataclass
class SavedExtraction:
    """ORM records created from one validated extraction result."""

    todos: list[Todo]
    evidences: list[Evidence]
    timeline_events: list[TimelineEvent]
    decisions: list[Decision]


def _normalized_key(value: str) -> str:
    return " ".join(value.casefold().split())


def _merge_tags(existing: Sequence[str], incoming: Sequence[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for tag in [*existing, *incoming]:
        cleaned = tag.strip()
        key = cleaned.casefold()
        if cleaned and key not in seen:
            merged.append(cleaned)
            seen.add(key)
    return merged


def update_bucket_summary(
    bucket_id: str,
    entry_summary: str,
    *,
    session: Session | None = None,
    max_chars: int = 1200,
) -> str:
    """Merge a new entry summary into a bounded rolling Bucket summary.

    The raw Entry remains the source of truth. This deterministic MVP strategy
    preserves the first context fragment plus the newest non-duplicate facts;
    a later LLM summarizer can rebuild the cache from Entries.
    """

    fragment = _clean_required_text(entry_summary, "entry_summary")
    if max_chars < 100:
        raise ValueError("max_chars must be at least 100")

    with _session_scope(session) as active_session:
        bucket = active_session.get(Bucket, bucket_id)
        if bucket is None:
            raise LookupError(f"bucket not found: {bucket_id}")

        parts = [part.strip() for part in bucket.summary.split("\n") if part.strip()]
        keys = {_normalized_key(part) for part in parts}
        if _normalized_key(fragment) not in keys:
            parts.append(fragment)

        while len("\n".join(parts)) > max_chars and len(parts) > 2:
            parts.pop(1)
        summary = "\n".join(parts)
        if len(summary) > max_chars:
            summary = summary[: max_chars - 1].rstrip() + "…"

        bucket.summary = summary
        bucket.updated_at = utc_now()
        active_session.flush()
        return summary


def rebuild_bucket_summary(
    bucket_id: str,
    *,
    session: Session | None = None,
    max_entries: int = 8,
    max_chars: int = 1200,
) -> str:
    """Rebuild the rolling summary from the Bucket's surviving Entry summaries."""

    if max_entries < 1:
        raise ValueError("max_entries must be at least 1")

    with _session_scope(session) as active_session:
        bucket = active_session.get(Bucket, bucket_id)
        if bucket is None:
            raise LookupError(f"bucket not found: {bucket_id}")
        summaries = list(
            active_session.scalars(
                select(Entry.summary)
                .where(Entry.bucket_id == bucket_id, Entry.summary.is_not(None))
                .order_by(Entry.created_at.desc())
                .limit(max_entries)
            ).all()
        )
        fragments = list(reversed([item.strip() for item in summaries if item and item.strip()]))
        summary = "\n".join(dict.fromkeys(fragments))
        if len(summary) > max_chars:
            summary = summary[: max_chars - 1].rstrip() + "…"
        bucket.summary = summary
        bucket.updated_at = utc_now()
        active_session.flush()
        return summary


def save_extraction(
    bucket_id: str,
    entry_id: str,
    extraction: ExtractionResult,
    *,
    session: Session | None = None,
) -> SavedExtraction:
    """Persist validated facts and preserve their source Entry relationship."""

    with _session_scope(session) as active_session:
        bucket = active_session.get(Bucket, bucket_id)
        if bucket is None:
            raise LookupError(f"bucket not found: {bucket_id}")
        entry = active_session.get(Entry, entry_id)
        if entry is None or entry.bucket_id != bucket_id:
            raise LookupError("entry does not belong to the target bucket")

        existing_todos = {
            _normalized_key(text)
            for text in active_session.scalars(
                select(Todo.text).where(Todo.bucket_id == bucket_id)
            )
        }
        existing_evidence = {
            _normalized_key(text)
            for text in active_session.scalars(
                select(Evidence.text).where(Evidence.bucket_id == bucket_id)
            )
        }
        existing_decisions = {
            _normalized_key(text)
            for text in active_session.scalars(
                select(Decision.text).where(Decision.bucket_id == bucket_id)
            )
        }
        existing_timeline = {
            (event_time, _normalized_key(text))
            for event_time, text in active_session.execute(
                select(TimelineEvent.event_time, TimelineEvent.text).where(
                    TimelineEvent.bucket_id == bucket_id
                )
            )
        }

        todos = [
            Todo(bucket_id=bucket_id, entry_id=entry_id, text=text)
            for text in extraction.todos
            if _normalized_key(text) not in existing_todos
        ]
        evidences = [
            Evidence(
                bucket_id=bucket_id,
                entry_id=entry_id,
                text=text,
                source="llm-extracted",
            )
            for text in extraction.evidences
            if _normalized_key(text) not in existing_evidence
        ]
        decisions = [
            Decision(bucket_id=bucket_id, entry_id=entry_id, text=text)
            for text in extraction.decisions
            if _normalized_key(text) not in existing_decisions
        ]
        timeline_events = [
            TimelineEvent(
                bucket_id=bucket_id,
                entry_id=entry_id,
                event_time=event.event_time,
                text=event.text,
            )
            for event in extraction.timeline_events
            if (event.event_time, _normalized_key(event.text)) not in existing_timeline
        ]

        active_session.add_all([*todos, *evidences, *timeline_events, *decisions])
        entry.summary = extraction.summary
        bucket.tags = _merge_tags(bucket.tags, extraction.tags)
        update_bucket_summary(
            bucket_id,
            extraction.summary,
            session=active_session,
        )
        active_session.flush()

        return SavedExtraction(
            todos=todos,
            evidences=evidences,
            timeline_events=timeline_events,
            decisions=decisions,
        )
