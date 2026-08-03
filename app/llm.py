"""OpenAI-compatible Structured Outputs wrapper used by application services."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Literal, TypeVar
from urllib.parse import urlparse

from dotenv import load_dotenv
from pydantic import BaseModel

SchemaT = TypeVar("SchemaT", bound=BaseModel)
LLMApiMode = Literal["responses", "chat_completions"]

OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1"
_API_MODE_ALIASES: dict[str, LLMApiMode] = {
    "responses": "responses",
    "response": "responses",
    "chat": "chat_completions",
    "chat_completions": "chat_completions",
    "chat-completions": "chat_completions",
}


class LLMError(RuntimeError):
    """Base error for model invocation failures."""


class LLMConfigurationError(LLMError):
    """Raised when required API configuration is missing or unsafe."""


class LLMResponseError(LLMError):
    """Raised when a model response cannot be safely consumed."""


@dataclass(frozen=True)
class LLMEndpointConfig:
    """Non-secret endpoint settings for one official or compatible API site."""

    site: str
    base_url: str
    api_mode: LLMApiMode

    @property
    def is_official(self) -> bool:
        return self.site.casefold() == "official"


def configured_model(explicit_model: str | None = None) -> str:
    """Return the configured model name used by the selected API site."""

    load_dotenv()
    model = (explicit_model or os.getenv("OPENAI_MODEL") or "").strip()
    if not model:
        raise LLMConfigurationError("OPENAI_MODEL is not configured")
    return model


def _normalize_api_mode(value: str | None) -> LLMApiMode:
    normalized = (value or "responses").strip().casefold()
    mode = _API_MODE_ALIASES.get(normalized)
    if mode is None:
        allowed = ", ".join(sorted(set(_API_MODE_ALIASES.values())))
        raise LLMConfigurationError(f"OPENAI_API_MODE must be one of: {allowed}")
    return mode


def _normalize_base_url(value: str) -> str:
    cleaned = value.strip().rstrip("/")
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise LLMConfigurationError(
            "OPENAI_BASE_URL must be an absolute http(s) URL, usually ending in /v1"
        )
    if parsed.username or parsed.password:
        raise LLMConfigurationError("OPENAI_BASE_URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise LLMConfigurationError("OPENAI_BASE_URL must not contain query or fragment")

    hostname = (parsed.hostname or "").casefold()
    is_local = hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not is_local:
        raise LLMConfigurationError(
            "custom API sites must use HTTPS; HTTP is allowed only for localhost"
        )
    return cleaned


def configured_endpoint(
    explicit_site: str | None = None,
    explicit_base_url: str | None = None,
    explicit_api_mode: str | None = None,
) -> LLMEndpointConfig:
    """Resolve the selected official or OpenAI-compatible API endpoint.

    ``OPENAI_SITE=official`` always uses the official API URL. Any other site
    name requires ``OPENAI_BASE_URL``. For backward compatibility, setting a
    base URL without a site name automatically selects the ``custom`` site.
    """

    load_dotenv()
    env_site = os.getenv("OPENAI_SITE")
    env_base_url = os.getenv("OPENAI_BASE_URL")
    requested_base_url = explicit_base_url if explicit_base_url is not None else env_base_url
    requested_site = explicit_site if explicit_site is not None else env_site

    if requested_site is None or not requested_site.strip():
        site = "custom" if requested_base_url and requested_base_url.strip() else "official"
    else:
        site = requested_site.strip()

    if len(site) > 100 or any(character in site for character in "\r\n"):
        raise LLMConfigurationError("OPENAI_SITE must be a short single-line name")

    api_mode = _normalize_api_mode(
        explicit_api_mode if explicit_api_mode is not None else os.getenv("OPENAI_API_MODE")
    )
    if site.casefold() == "official":
        return LLMEndpointConfig(
            site="official",
            base_url=OFFICIAL_OPENAI_BASE_URL,
            api_mode=api_mode,
        )

    if not requested_base_url or not requested_base_url.strip():
        raise LLMConfigurationError(
            "OPENAI_BASE_URL is required when OPENAI_SITE is not official"
        )
    return LLMEndpointConfig(
        site=site,
        base_url=_normalize_base_url(requested_base_url),
        api_mode=api_mode,
    )


def _default_client(endpoint: LLMEndpointConfig | None = None) -> Any:
    load_dotenv()
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise LLMConfigurationError("OPENAI_API_KEY is not configured")

    active_endpoint = endpoint or configured_endpoint()
    try:
        from openai import OpenAI

        return OpenAI(api_key=api_key, base_url=active_endpoint.base_url)
    except Exception as exc:
        raise LLMConfigurationError(
            "OpenAI-compatible client initialization failed; check the selected "
            f"site, base URL, API key, and proxy configuration: {exc}"
        ) from exc


def _responses_refusal_text(response: Any) -> str | None:
    for item in getattr(response, "output", []) or []:
        for content in getattr(item, "content", []) or []:
            if getattr(content, "type", None) == "refusal":
                return getattr(content, "refusal", None) or "request refused"
    return None


def _parse_responses_api(
    client: Any,
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    schema: type[SchemaT],
) -> SchemaT:
    response = client.responses.parse(
        model=model,
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

    refusal = _responses_refusal_text(response)
    if refusal:
        raise LLMResponseError(f"model refused request: {refusal}")

    parsed = getattr(response, "output_parsed", None)
    if parsed is None:
        raise LLMResponseError("model response did not contain parsed output")
    if isinstance(parsed, schema):
        return parsed
    return schema.model_validate(parsed)


def _parse_chat_completions_api(
    client: Any,
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    schema: type[SchemaT],
) -> SchemaT:
    response = client.chat.completions.parse(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        response_format=schema,
    )
    choices = getattr(response, "choices", []) or []
    if not choices:
        raise LLMResponseError("chat completion did not contain a choice")

    choice = choices[0]
    finish_reason = getattr(choice, "finish_reason", None)
    if finish_reason == "length":
        raise LLMResponseError("model response incomplete: length")
    if finish_reason == "content_filter":
        raise LLMResponseError("model response blocked by content filter")

    message = getattr(choice, "message", None)
    if message is None:
        raise LLMResponseError("chat completion did not contain a message")
    refusal = getattr(message, "refusal", None)
    if refusal:
        raise LLMResponseError(f"model refused request: {refusal}")

    parsed = getattr(message, "parsed", None)
    if parsed is None:
        raise LLMResponseError("chat completion did not contain parsed output")
    if isinstance(parsed, schema):
        return parsed
    return schema.model_validate(parsed)


def _is_retryable(exc: Exception) -> bool:
    """Return whether another model call could reasonably succeed."""

    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int):
        if status_code in {408, 409, 429} or status_code >= 500:
            return True
        if 400 <= status_code < 500:
            return False

    message = str(exc).casefold()
    if isinstance(exc, LLMResponseError) and (
        "refused" in message or "content filter" in message
    ):
        return False
    return True


def parse_with_schema(
    system_prompt: str,
    user_prompt: str,
    schema: type[SchemaT],
    *,
    client: Any | None = None,
    model: str | None = None,
    endpoint: LLMEndpointConfig | None = None,
    api_mode: str | None = None,
    max_retries: int = 1,
    retry_delay_seconds: float = 0.0,
) -> SchemaT:
    """Call the selected OpenAI-compatible API and validate Structured Output.

    ``responses`` uses ``client.responses.parse``. ``chat_completions`` uses
    ``client.chat.completions.parse`` for compatible relay sites that do not
    implement the Responses API. Services may inject a fake client in tests, so
    ordinary Pytest runs never require a real API call.
    """

    if not system_prompt.strip() or not user_prompt.strip():
        raise ValueError("system_prompt and user_prompt must not be empty")
    if max_retries < 0:
        raise ValueError("max_retries must be at least 0")

    active_model = configured_model(model)
    active_endpoint = endpoint or configured_endpoint(explicit_api_mode=api_mode)
    active_client = client or _default_client(active_endpoint)
    last_error: Exception | None = None
    attempts_made = 0

    for attempt in range(max_retries + 1):
        attempts_made = attempt + 1
        try:
            if active_endpoint.api_mode == "chat_completions":
                return _parse_chat_completions_api(
                    active_client,
                    model=active_model,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    schema=schema,
                )
            return _parse_responses_api(
                active_client,
                model=active_model,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                schema=schema,
            )
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
