"""Presentation helpers that keep UI formatting out of business services."""

from __future__ import annotations

from app.models import Bucket
from app.schemas import ArchiveResult


def archive_result_view(result: ArchiveResult) -> dict[str, object]:
    """Return a stable mapping suitable for Streamlit or an HTTP API."""

    data = result.model_dump(mode="json")
    extraction = result.extraction
    data["todos"] = extraction.todos if extraction else []
    data["evidences"] = extraction.evidences if extraction else []
    data["timeline_events"] = (
        [item.model_dump() for item in extraction.timeline_events] if extraction else []
    )
    data["decisions"] = extraction.decisions if extraction else []
    return data


def bucket_detail_view(bucket: Bucket) -> dict[str, object]:
    """Convert an eagerly-loaded Bucket into a user-facing detail structure."""

    return {
        "id": bucket.id,
        "title": bucket.title,
        "type": bucket.type.value,
        "status": bucket.status.value,
        "summary": bucket.summary,
        "tags": bucket.tags,
        "last_active_at": bucket.last_active_at.isoformat(),
        "todos": [
            {"id": item.id, "text": item.text, "status": item.status.value}
            for item in bucket.todos
        ],
        "evidences": [
            {"id": item.id, "text": item.text, "source": item.source}
            for item in bucket.evidences
        ],
        "timeline_events": [
            {"id": item.id, "event_time": item.event_time, "text": item.text}
            for item in bucket.timeline_events
        ],
        "decisions": [
            {"id": item.id, "text": item.text, "reason": item.reason}
            for item in bucket.decisions
        ],
        "entries": [
            {
                "id": item.id,
                "raw_text": item.raw_text,
                "summary": item.summary,
                "created_at": item.created_at.isoformat(),
            }
            for item in bucket.entries
        ],
    }
