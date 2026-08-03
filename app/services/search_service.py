"""SQLite-compatible keyword search across Bucket and Entry memory."""

from __future__ import annotations

from sqlalchemy import Text, cast, or_, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_session
from app.models import Bucket, Entry
from app.schemas import BucketSearchResult


def _contains(value: str, query: str) -> bool:
    return query.casefold() in value.casefold()


def search_buckets(
    query: str,
    *,
    limit: int = 20,
    session: Session | None = None,
) -> list[BucketSearchResult]:
    """Search titles, summaries, JSON tags, and raw Entry text."""

    cleaned = query.strip()
    if not cleaned:
        raise ValueError("query must not be empty")
    if limit < 1:
        raise ValueError("limit must be at least 1")

    owns_session = session is None
    active_session = session or get_session()
    try:
        statement = (
            select(Bucket)
            .outerjoin(Entry, Entry.bucket_id == Bucket.id)
            .where(
                or_(
                    Bucket.title.contains(cleaned, autoescape=True),
                    Bucket.summary.contains(cleaned, autoescape=True),
                    cast(Bucket.tags, Text).contains(cleaned, autoescape=True),
                    Entry.raw_text.contains(cleaned, autoescape=True),
                )
            )
            .options(selectinload(Bucket.entries))
            .distinct()
            .limit(max(limit * 5, 50))
        )
        buckets = list(active_session.scalars(statement).unique().all())

        results: list[BucketSearchResult] = []
        for bucket in buckets:
            matching_entries = [
                entry for entry in bucket.entries if _contains(entry.raw_text, cleaned)
            ]
            score = 0
            if bucket.title.casefold() == cleaned.casefold():
                score += 100
            elif _contains(bucket.title, cleaned):
                score += 50
            if any(_contains(tag, cleaned) for tag in bucket.tags):
                score += 30
            if _contains(bucket.summary, cleaned):
                score += 20
            score += min(len(matching_entries), 10) * 5
            results.append(
                BucketSearchResult(
                    bucket_id=bucket.id,
                    title=bucket.title,
                    bucket_type=bucket.type.value,
                    status=bucket.status.value,
                    summary=bucket.summary,
                    tags=bucket.tags,
                    last_active_at=bucket.last_active_at,
                    matched_entry_count=len(matching_entries),
                    score=score,
                )
            )

        return sorted(
            results,
            key=lambda result: (result.score, result.last_active_at),
            reverse=True,
        )[:limit]
    finally:
        if owns_session:
            active_session.close()
