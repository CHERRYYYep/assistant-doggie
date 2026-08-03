"""Minimal, auditable correction operations for misplaced Entries."""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.db import get_session
from app.models import (
    Bucket,
    ClassificationRecord,
    Correction,
    Decision,
    Entry,
    Evidence,
    TimelineEvent,
    Todo,
    utc_now,
)
from app.services.bucket_service import rebuild_bucket_summary


@contextmanager
def _session_scope(session: Session | None = None) -> Iterator[Session]:
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


def _entry_snapshot(entry: Entry) -> dict[str, object]:
    return {
        "entry_id": entry.id,
        "bucket_id": entry.bucket_id,
        "todo_ids": [item.id for item in entry.todos],
        "evidence_ids": [item.id for item in entry.evidences],
        "timeline_event_ids": [item.id for item in entry.timeline_events],
        "decision_ids": [item.id for item in entry.decisions],
    }


def move_entry(
    entry_id: str,
    target_bucket_id: str,
    command_text: str,
    *,
    session: Session | None = None,
) -> Correction:
    """Move an Entry and every derived record, then store before/after snapshots."""

    command = command_text.strip()
    if not command:
        raise ValueError("command_text must not be empty")

    with _session_scope(session) as active_session:
        statement = (
            select(Entry)
            .where(Entry.id == entry_id)
            .options(
                selectinload(Entry.todos),
                selectinload(Entry.evidences),
                selectinload(Entry.timeline_events),
                selectinload(Entry.decisions),
            )
        )
        entry = active_session.scalar(statement)
        if entry is None:
            raise LookupError(f"entry not found: {entry_id}")
        target = active_session.get(Bucket, target_bucket_id)
        if target is None:
            raise LookupError(f"bucket not found: {target_bucket_id}")
        source_bucket_id = entry.bucket_id
        if source_bucket_id == target_bucket_id:
            raise ValueError("entry already belongs to the target bucket")

        before = _entry_snapshot(entry)
        entry.bucket_id = target_bucket_id
        entry.moved_from_bucket_id = source_bucket_id
        for item in [*entry.todos, *entry.evidences, *entry.timeline_events, *entry.decisions]:
            item.bucket_id = target_bucket_id

        now = utc_now()
        source = active_session.get(Bucket, source_bucket_id)
        if source is not None:
            source.updated_at = now
            source.last_active_at = now
        target.updated_at = now
        target.last_active_at = now
        active_session.flush()

        after = _entry_snapshot(entry)
        correction = Correction(
            command_text=command,
            action="move_entry",
            target_type="entry",
            target_id=entry.id,
            before_json=before,
            after_json=after,
        )
        active_session.add(correction)

        records = active_session.scalars(
            select(ClassificationRecord).where(ClassificationRecord.entry_id == entry.id)
        )
        for record in records:
            record.corrected = True

        if source is not None:
            rebuild_bucket_summary(source.id, session=active_session)
        rebuild_bucket_summary(target.id, session=active_session)
        active_session.flush()
        return correction


def _target_title_from_command(command_text: str) -> str | None:
    matches = re.findall(
        r"(?:移到|放到)\s*(.+?)(?:里|中|[，,。]|$)",
        command_text.strip(),
    )
    if not matches:
        return None
    # Correction sentences often contain both “不要放到 A” and “放到 B”;
    # the final destination expression is the intended target.
    title = matches[-1].strip(" ，,：:")
    return title or None


def _resolve_target_bucket(
    command_text: str,
    session: Session,
) -> Bucket:
    title = _target_title_from_command(command_text)
    if not title:
        raise ValueError("无法从纠错命令中识别目标 Bucket，请显式选择目标")

    buckets = list(
        session.scalars(
            select(Bucket).where(Bucket.title.contains(title, autoescape=True))
        ).all()
    )
    exact = [bucket for bucket in buckets if bucket.title == title]
    if len(exact) == 1:
        return exact[0]
    if len(buckets) == 1:
        return buckets[0]
    if not buckets:
        raise LookupError(f"没有找到标题包含“{title}”的 Bucket")
    raise ValueError(f"存在多个标题包含“{title}”的 Bucket，请显式选择目标")


def move_latest_entry(
    command_text: str,
    *,
    target_bucket_id: str | None = None,
    session: Session | None = None,
) -> Correction:
    """Move the latest Entry, resolving the destination from ID or command text."""

    with _session_scope(session) as active_session:
        entry = active_session.scalar(
            select(Entry).order_by(Entry.created_at.desc()).limit(1)
        )
        if entry is None:
            raise LookupError("no entry is available to correct")
        target_id = target_bucket_id
        if target_id is None:
            target_id = _resolve_target_bucket(command_text, active_session).id
        return move_entry(
            entry.id,
            target_id,
            command_text,
            session=active_session,
        )
