from types import SimpleNamespace

import pytest

from app.llm import LLMConfigurationError, LLMResponseError, _default_client, parse_with_schema
from app.schemas import ExtractionResult


class FakeResponses:
    def __init__(self, responses):
        self._responses = iter(responses)
        self.calls = 0

    def parse(self, **kwargs):
        self.calls += 1
        response = next(self._responses)
        if isinstance(response, Exception):
            raise response
        return response


class FakeClient:
    def __init__(self, responses):
        self.responses = FakeResponses(responses)


def test_parse_with_schema_returns_validated_pydantic_model():
    client = FakeClient(
        [SimpleNamespace(status="completed", output=[], output_parsed={"summary": "完成"})]
    )

    result = parse_with_schema(
        "system",
        "user",
        ExtractionResult,
        client=client,
        model="test-model",
    )

    assert result == ExtractionResult(summary="完成")


def test_parse_with_schema_retries_incomplete_response():
    client = FakeClient(
        [
            SimpleNamespace(
                status="incomplete",
                incomplete_details=SimpleNamespace(reason="max_output_tokens"),
                output=[],
            ),
            SimpleNamespace(status="completed", output=[], output_parsed={"summary": "重试成功"}),
        ]
    )

    result = parse_with_schema(
        "system",
        "user",
        ExtractionResult,
        client=client,
        model="test-model",
        max_retries=1,
    )

    assert result.summary == "重试成功"
    assert client.responses.calls == 2


def test_parse_with_schema_reports_refusal():
    response = SimpleNamespace(
        status="completed",
        output=[
            SimpleNamespace(
                content=[SimpleNamespace(type="refusal", refusal="cannot process")]
            )
        ],
        output_parsed=None,
    )

    client = FakeClient([response])
    with pytest.raises(LLMResponseError, match="refused"):
        parse_with_schema(
            "system",
            "user",
            ExtractionResult,
            client=client,
            model="test-model",
            max_retries=2,
        )

    assert client.responses.calls == 1


class FakeHTTPError(RuntimeError):
    def __init__(self, status_code: int):
        self.status_code = status_code
        super().__init__(f"HTTP {status_code}")


def test_parse_with_schema_does_not_retry_non_transient_client_error():
    client = FakeClient([FakeHTTPError(401)])

    with pytest.raises(LLMResponseError, match=r"after 1 attempt.*HTTP 401"):
        parse_with_schema(
            "system",
            "user",
            ExtractionResult,
            client=client,
            model="test-model",
            max_retries=2,
        )

    assert client.responses.calls == 1


def test_parse_with_schema_retries_rate_limit_error():
    client = FakeClient(
        [
            FakeHTTPError(429),
            SimpleNamespace(
                status="completed",
                output=[],
                output_parsed={"summary": "限流后成功"},
            ),
        ]
    )

    result = parse_with_schema(
        "system",
        "user",
        ExtractionResult,
        client=client,
        model="test-model",
        max_retries=1,
    )

    assert result.summary == "限流后成功"
    assert client.responses.calls == 2


def test_default_client_reports_initialization_configuration_error(monkeypatch):
    import openai

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    def fail_to_initialize():
        raise ValueError("unsupported proxy scheme")

    monkeypatch.setattr(openai, "OpenAI", fail_to_initialize)

    with pytest.raises(LLMConfigurationError, match="proxy configuration"):
        _default_client()
