"""Database operations for buckets and their raw entries."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import Select, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_session
from app.models import (
    Bucket,
    BucketStatus,
    BucketType,
    Entry,
    utc_now,
)


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
