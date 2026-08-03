"""Transactional orchestration for classification, extraction, and persistence."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Bucket, Entry
from app.schemas import ArchiveResult, ClassificationResult, ExtractionResult
from app.services.bucket_service import (
    append_entry,
    create_bucket,
    list_active_buckets,
    save_extraction,
)
from app.services.classify_service import classify_input, save_classification_record
from app.services.extract_service import extract_info

Classifier = Callable[..., ClassificationResult]
Extractor = Callable[..., ExtractionResult]


def _archive_classified_input(
    text: str,
    classification: ClassificationResult,
    *,
    extractor: Extractor,
    session: Session,
) -> tuple[Bucket, Entry, ExtractionResult]:
    if classification.action not in {"append_existing", "create_new"}:
        raise ValueError("only automatic classification actions can be persisted")

    extraction = extractor(text, bucket_type=classification.bucket_type)
    if classification.action == "create_new":
        bucket = create_bucket(
            classification.title or extraction.summary,
            classification.bucket_type or "knowledge",
            tags=extraction.tags,
            session=session,
        )
    else:
        bucket = session.get(Bucket, classification.bucket_id)
        if bucket is None:
            raise LookupError(f"bucket not found: {classification.bucket_id}")

    entry = append_entry(
        bucket.id,
        text,
        extraction.summary,
        classification_confidence=classification.confidence,
        classification_reason=classification.reason,
        session=session,
    )
    save_extraction(bucket.id, entry.id, extraction, session=session)
    return bucket, entry, extraction


def archive_user_input(
    text: str,
    *,
    current_focus_bucket_id: str | None = None,
    classifier: Classifier = classify_input,
    extractor: Extractor = extract_info,
    session: Session | None = None,
    model_name: str | None = None,
) -> ArchiveResult:
    """Run the complete MVP archive flow without persisting uncertain input."""

    cleaned = text.strip()
    if not cleaned:
        raise ValueError("text must not be empty")

    owns_session = session is None
    active_session = session or get_session()
    try:
        candidates = list_active_buckets(session=active_session)
        classification = classifier(
            cleaned,
            candidates,
            current_focus_bucket_id=current_focus_bucket_id,
        )
        classification_record = save_classification_record(
            cleaned,
            classification,
            current_focus_bucket_id=current_focus_bucket_id,
            session=active_session,
            model_name=model_name,
            candidate_bucket_ids=[bucket.id for bucket in candidates],
        )

        if classification.action == "ask_user":
            if owns_session:
                active_session.commit()
            return ArchiveResult(
                status="needs_confirmation",
                action="ask_user",
                bucket_type=classification.bucket_type,
                confidence=classification.confidence,
                reason=classification.reason,
                question=classification.question,
                candidate_bucket_ids=classification.candidate_bucket_ids,
            )

        bucket, entry, extraction = _archive_classified_input(
            cleaned,
            classification,
            extractor=extractor,
            session=active_session,
        )
        classification_record.bucket_id = bucket.id
        classification_record.entry_id = entry.id
        active_session.flush()
        if owns_session:
            active_session.commit()

        return ArchiveResult(
            status="archived",
            action=classification.action,
            bucket_id=bucket.id,
            bucket_title=bucket.title,
            bucket_type=bucket.type.value,
            entry_id=entry.id,
            confidence=classification.confidence,
            reason=classification.reason,
            extraction=extraction,
        )
    except Exception:
        if owns_session:
            active_session.rollback()
        raise
    finally:
        if owns_session:
            active_session.close()


def archive_confirmed_input(
    text: str,
    target_bucket_id: str,
    *,
    confidence: float = 1.0,
    reason: str = "用户明确确认目标 Bucket。",
    extractor: Extractor = extract_info,
    session: Session | None = None,
    model_name: str | None = None,
) -> ArchiveResult:
    """Persist an input after explicit user confirmation of an existing Bucket."""

    cleaned = text.strip()
    if not cleaned:
        raise ValueError("text must not be empty")

    owns_session = session is None
    active_session = session or get_session()
    try:
        bucket = active_session.get(Bucket, target_bucket_id)
        if bucket is None:
            raise LookupError(f"bucket not found: {target_bucket_id}")
        classification = ClassificationResult(
            action="append_existing",
            bucket_id=bucket.id,
            bucket_type=bucket.type.value,
            confidence=confidence,
            reason=reason,
        )
        record = save_classification_record(
            cleaned,
            classification,
            current_focus_bucket_id=target_bucket_id,
            session=active_session,
            model_name=model_name,
            candidate_bucket_ids=[bucket.id],
        )
        bucket, entry, extraction = _archive_classified_input(
            cleaned,
            classification,
            extractor=extractor,
            session=active_session,
        )
        record.bucket_id = bucket.id
        record.entry_id = entry.id
        active_session.flush()
        if owns_session:
            active_session.commit()
        return ArchiveResult(
            status="archived",
            action="append_existing",
            bucket_id=bucket.id,
            bucket_title=bucket.title,
            bucket_type=bucket.type.value,
            entry_id=entry.id,
            confidence=confidence,
            reason=reason,
            extraction=extraction,
        )
    except Exception:
        if owns_session:
            active_session.rollback()
        raise
    finally:
        if owns_session:
            active_session.close()


def archive_confirmed_new_input(
    text: str,
    title: str,
    bucket_type: str,
    *,
    confidence: float = 1.0,
    reason: str = "用户明确确认创建新 Bucket。",
    extractor: Extractor = extract_info,
    session: Session | None = None,
    model_name: str | None = None,
) -> ArchiveResult:
    """Create and archive into a new Bucket after explicit user confirmation."""

    cleaned = text.strip()
    if not cleaned:
        raise ValueError("text must not be empty")
    classification = ClassificationResult(
        action="create_new",
        bucket_type=bucket_type,
        title=title,
        confidence=confidence,
        reason=reason,
    )

    owns_session = session is None
    active_session = session or get_session()
    try:
        record = save_classification_record(
            cleaned,
            classification,
            current_focus_bucket_id=None,
            session=active_session,
            model_name=model_name,
            candidate_bucket_ids=[],
        )
        bucket, entry, extraction = _archive_classified_input(
            cleaned,
            classification,
            extractor=extractor,
            session=active_session,
        )
        record.bucket_id = bucket.id
        record.entry_id = entry.id
        active_session.flush()
        if owns_session:
            active_session.commit()
        return ArchiveResult(
            status="archived",
            action="create_new",
            bucket_id=bucket.id,
            bucket_title=bucket.title,
            bucket_type=bucket.type.value,
            entry_id=entry.id,
            confidence=confidence,
            reason=reason,
            extraction=extraction,
        )
    except Exception:
        if owns_session:
            active_session.rollback()
        raise
    finally:
        if owns_session:
            active_session.close()
