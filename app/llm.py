"""OpenAI Structured Outputs wrapper used by application services."""

from __future__ import annotations

import os
import time
from typing import Any, TypeVar

from dotenv import load_dotenv
from pydantic import BaseModel

SchemaT = TypeVar("SchemaT", bound=BaseModel)


class LLMError(RuntimeError):
    """Base error for model invocation failures."""


class LLMConfigurationError(LLMError):
    """Raised when required API configuration is missing."""


class LLMResponseError(LLMError):
    """Raised when a model response cannot be safely consumed."""


def configured_model(explicit_model: str | None = None) -> str:
    """Return the configured OpenAI model name."""

    load_dotenv()
    model = explicit_model or os.getenv("OPENAI_MODEL")
    if not model:
        raise LLMConfigurationError("OPENAI_MODEL is not configured")
    return model


def _default_client() -> Any:
    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        raise LLMConfigurationError("OPENAI_API_KEY is not configured")

    try:
        from openai import OpenAI

        return OpenAI()
    except Exception as exc:
        raise LLMConfigurationError(
            "OpenAI client initialization failed; check API and proxy configuration: "
            f"{exc}"
        ) from exc


def _refusal_text(response: Any) -> str | None:
    for item in getattr(response, "output", []) or []:
        for content in getattr(item, "content", []) or []:
            if getattr(content, "type", None) == "refusal":
                return getattr(content, "refusal", None) or "request refused"
    return None


def _is_retryable(exc: Exception) -> bool:
    """Return whether another model call could reasonably succeed.

    Authentication, permission, malformed-request, missing-resource, and schema
    contract HTTP errors require a configuration or code change. Retrying them
    immediately wastes latency and API quota. Timeouts, connection errors, rate
    limits, server errors, incomplete output, and local validation failures may
    be transient and remain eligible for the small retry budget.
    """

    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int):
        if status_code in {408, 409, 429} or status_code >= 500:
            return True
        if 400 <= status_code < 500:
            return False

    if isinstance(exc, LLMResponseError) and "refused" in str(exc).casefold():
        return False

    return True


def parse_with_schema(
    system_prompt: str,
    user_prompt: str,
    schema: type[SchemaT],
    *,
    client: Any | None = None,
    model: str | None = None,
    max_retries: int = 1,
    retry_delay_seconds: float = 0.0,
) -> SchemaT:
    """Call the Responses API and validate its Structured Output.

    The wrapper centralizes configuration, incomplete/refusal handling, schema
    validation, and a small retry budget. Services may inject a fake client in
    unit tests, so ordinary tests never require a real API call.
    """

    if not system_prompt.strip() or not user_prompt.strip():
        raise ValueError("system_prompt and user_prompt must not be empty")
    if max_retries < 0:
        raise ValueError("max_retries must be at least 0")

    active_model = configured_model(model)
    active_client = client or _default_client()
    last_error: Exception | None = None
    attempts_made = 0

    for attempt in range(max_retries + 1):
        attempts_made = attempt + 1
        try:
            response = active_client.responses.parse(
                model=active_model,
                input=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                text_format=schema,
            )

            status = getattr(response, "status", "completed")
            if status == "incomplete":
                details = getattr(response, "incomplete_details", None)
                reason = getattr(details, "reason", "unknown")
                raise LLMResponseError(f"model response incomplete: {reason}")

            refusal = _refusal_text(response)
            if refusal:
                raise LLMResponseError(f"model refused request: {refusal}")

            parsed = getattr(response, "output_parsed", None)
            if parsed is None:
                raise LLMResponseError("model response did not contain parsed output")
            if isinstance(parsed, schema):
                return parsed
            return schema.model_validate(parsed)
        except LLMConfigurationError:
            raise
        except Exception as exc:
            last_error = exc
            if attempt >= max_retries or not _is_retryable(exc):
                break
            if retry_delay_seconds > 0:
                time.sleep(retry_delay_seconds)

    raise LLMResponseError(
        f"structured model call failed after {attempts_made} attempt(s): {last_error}"
    ) from last_error
