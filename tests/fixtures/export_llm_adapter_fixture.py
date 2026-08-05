"""Export Python LLM endpoint and strict-schema behavior for Rust parity tests."""

from __future__ import annotations

import json
from typing import Any

from openai.lib._pydantic import to_strict_json_schema

from app.llm import configured_endpoint
from app.schemas import BucketSummaryResult, ClassificationResult, ExtractionResult


def endpoint_result(**kwargs: str | None) -> dict[str, Any]:
    """Return one explicit endpoint resolution result without reading secrets."""

    try:
        endpoint = configured_endpoint(
            explicit_site=kwargs.get("site"),
            explicit_base_url=kwargs.get("base_url"),
            explicit_api_mode=kwargs.get("api_mode"),
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "site": endpoint.site,
        "base_url": endpoint.base_url,
        "api_mode": endpoint.api_mode,
        "is_official": endpoint.is_official,
    }


def export_fixture() -> dict[str, Any]:
    """Return deterministic endpoint cases and OpenAI strict JSON Schemas."""

    return {
        "endpoints": {
            "official": endpoint_result(
                site="official",
                base_url="https://ignored.example/v1",
                api_mode="responses",
            ),
            "relay_chat": endpoint_result(
                site="my-relay",
                base_url="https://relay.example.com/openai/v1/",
                api_mode="chat",
            ),
            "implicit_custom": endpoint_result(
                site="",
                base_url="https://gateway.example/v1/",
                api_mode="response",
            ),
            "local_http": endpoint_result(
                site="local-gateway",
                base_url="http://127.0.0.1:8000/v1",
                api_mode="responses",
            ),
            "missing_custom_url": endpoint_result(
                site="relay",
                base_url="",
                api_mode="responses",
            ),
            "insecure_remote": endpoint_result(
                site="relay",
                base_url="http://relay.example.com/v1",
                api_mode="responses",
            ),
            "invalid_mode": endpoint_result(
                site="official",
                base_url=None,
                api_mode="legacy",
            ),
            "credentials": endpoint_result(
                site="relay",
                base_url="https://user:secret@relay.example/v1",
                api_mode="responses",
            ),
            "query": endpoint_result(
                site="relay",
                base_url="https://relay.example/v1?tenant=a",
                api_mode="responses",
            ),
            "fragment": endpoint_result(
                site="relay",
                base_url="https://relay.example/v1#section",
                api_mode="responses",
            ),
            "invalid_url": endpoint_result(
                site="relay",
                base_url="relay.example/v1",
                api_mode="responses",
            ),
            "local_ipv6": endpoint_result(
                site="local-gateway",
                base_url="http://[::1]:8000/v1",
                api_mode="responses",
            ),
        },
        "schemas": {
            "ClassificationResult": to_strict_json_schema(ClassificationResult),
            "ExtractionResult": to_strict_json_schema(ExtractionResult),
            "BucketSummaryResult": to_strict_json_schema(BucketSummaryResult),
        },
    }


def main() -> None:
    print(json.dumps(export_fixture(), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
