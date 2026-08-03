"""SQLAlchemy models for the work-memory database."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum as SqlEnum,
    Float,
    ForeignKey,
    Index,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp."""

    return datetime.now(timezone.utc)


def new_id() -> str:
    """Return a UUID string suitable for public object identifiers."""

    return str(uuid4())


class Base(DeclarativeBase):
    """Base class shared by all ORM models."""


class BucketType(str, Enum):
    IDEA = "idea"
    TASK = "task"
    INCIDENT = "incident"
    EXPERIMENT = "experiment"
    DECISION = "decision"
    MEETING = "meeting"
    KNOWLEDGE = "knowledge"
    DRAFT = "draft"


class BucketStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    DONE = "done"
    ARCHIVED = "archived"


class TodoStatus(str, Enum):
    OPEN = "open"
    DONE = "done"
    CANCELLED = "cancelled"


def enum_column(enum_type: type[Enum], name: str) -> SqlEnum:
    """Build a portable enum column that stores enum values as strings."""

    return SqlEnum(
        enum_type,
        name=name,
        native_enum=False,
        validate_strings=True,
        values_callable=lambda members: [member.value for member in members],
    )


class Bucket(Base):
    """A persistent work context such as an incident, meeting, or idea."""

    __tablename__ = "buckets"
    __table_args__ = (
        Index("ix_buckets_status_last_active_at", "status", "last_active_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[BucketType] = mapped_column(
        enum_column(BucketType, "bucket_type"), nullable=False, index=True
    )
    status: Mapped[BucketStatus] = mapped_column(
        enum_column(BucketStatus, "bucket_status"),
        nullable=False,
        default=BucketStatus.ACTIVE,
        index=True,
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now, index=True
    )
    last_active_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, index=True
    )

    entries: Mapped[list[Entry]] = relationship(
        back_populates="bucket",
        cascade="all, delete-orphan",
        foreign_keys="Entry.bucket_id",
        order_by="Entry.created_at",
    )
    todos: Mapped[list[Todo]] = relationship(
        back_populates="bucket", cascade="all, delete-orphan", order_by="Todo.created_at"
    )
    evidences: Mapped[list[Evidence]] = relationship(
        back_populates="bucket", cascade="all, delete-orphan", order_by="Evidence.created_at"
    )
    timeline_events: Mapped[list[TimelineEvent]] = relationship(
        back_populates="bucket",
        cascade="all, delete-orphan",
        order_by="TimelineEvent.created_at",
    )
    decisions: Mapped[list[Decision]] = relationship(
        back_populates="bucket", cascade="all, delete-orphan", order_by="Decision.created_at"
    )


class Entry(Base):
    """An immutable record of one raw user input."""

    __tablename__ = "entries"
    __table_args__ = (Index("ix_entries_bucket_created_at", "bucket_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    bucket_id: Mapped[str] = mapped_column(
        ForeignKey("buckets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(String(50), nullable=False, default="note")
    classification_confidence: Mapped[float | None] = mapped_column(Float)
    classification_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, index=True
    )
    moved_from_bucket_id: Mapped[str | None] = mapped_column(String(36))

    bucket: Mapped[Bucket] = relationship(
        back_populates="entries", foreign_keys=[bucket_id]
    )
    todos: Mapped[list[Todo]] = relationship(back_populates="entry")
    evidences: Mapped[list[Evidence]] = relationship(back_populates="entry")
    timeline_events: Mapped[list[TimelineEvent]] = relationship(back_populates="entry")
    decisions: Mapped[list[Decision]] = relationship(back_populates="entry")


class Todo(Base):
    """A task extracted from an entry or attached directly to a bucket."""

    __tablename__ = "todos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    bucket_id: Mapped[str] = mapped_column(
        ForeignKey("buckets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    entry_id: Mapped[str | None] = mapped_column(
        ForeignKey("entries.id", ondelete="SET NULL"), index=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[TodoStatus] = mapped_column(
        enum_column(TodoStatus, "todo_status"), nullable=False, default=TodoStatus.OPEN
    )
    due_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )

    bucket: Mapped[Bucket] = relationship(back_populates="todos")
    entry: Mapped[Entry | None] = relationship(back_populates="todos")


class Evidence(Base):
    """A log, metric, observation, or other supporting fact."""

    __tablename__ = "evidences"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    bucket_id: Mapped[str] = mapped_column(
        ForeignKey("buckets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    entry_id: Mapped[str | None] = mapped_column(
        ForeignKey("entries.id", ondelete="SET NULL"), index=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )

    bucket: Mapped[Bucket] = relationship(back_populates="evidences")
    entry: Mapped[Entry | None] = relationship(back_populates="evidences")


class TimelineEvent(Base):
    """A time-related event associated with a bucket."""

    __tablename__ = "timeline_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    bucket_id: Mapped[str] = mapped_column(
        ForeignKey("buckets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    entry_id: Mapped[str | None] = mapped_column(
        ForeignKey("entries.id", ondelete="SET NULL"), index=True
    )
    event_time: Mapped[str | None] = mapped_column(String(100))
    text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )

    bucket: Mapped[Bucket] = relationship(back_populates="timeline_events")
    entry: Mapped[Entry | None] = relationship(back_populates="timeline_events")


class Decision(Base):
    """A decision and its optional rationale."""

    __tablename__ = "decisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    bucket_id: Mapped[str] = mapped_column(
        ForeignKey("buckets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    entry_id: Mapped[str | None] = mapped_column(
        ForeignKey("entries.id", ondelete="SET NULL"), index=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )

    bucket: Mapped[Bucket] = relationship(back_populates="decisions")
    entry: Mapped[Entry | None] = relationship(back_populates="decisions")


class Correction(Base):
    """An audit record describing a user-requested correction."""

    __tablename__ = "corrections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    command_text: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    before_json: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)
    after_json: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class ClassificationRecord(Base):
    """Audit trail for every classification, including unarchived attempts."""

    __tablename__ = "classification_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    bucket_id: Mapped[str | None] = mapped_column(String(36), index=True)
    entry_id: Mapped[str | None] = mapped_column(
        ForeignKey("entries.id", ondelete="SET NULL"), index=True
    )
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    candidate_bucket_ids: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, default=list
    )
    current_focus_bucket_id: Mapped[str | None] = mapped_column(String(36))
    prompt_version: Mapped[str] = mapped_column(String(80), nullable=False)
    model_name: Mapped[str] = mapped_column(String(100), nullable=False)
    corrected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, index=True
    )
