from types import SimpleNamespace

import pytest

from app.llm import (
    OFFICIAL_OPENAI_BASE_URL,
    LLMConfigurationError,
    LLMEndpointConfig,
    LLMResponseError,
    _default_client,
    configured_endpoint,
    parse_with_schema,
)
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

    def fail_to_initialize(**_kwargs):
        raise ValueError("unsupported proxy scheme")

    monkeypatch.setattr(openai, "OpenAI", fail_to_initialize)

    with pytest.raises(LLMConfigurationError, match="proxy configuration"):
        _default_client()


class FakeChatCompletions:
    def __init__(self, responses):
        self._responses = iter(responses)
        self.calls = []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        response = next(self._responses)
        if isinstance(response, Exception):
            raise response
        return response


class FakeChatClient:
    def __init__(self, responses):
        self.chat = SimpleNamespace(completions=FakeChatCompletions(responses))


def test_configured_endpoint_selects_official_site_deterministically():
    endpoint = configured_endpoint(
        explicit_site="official",
        explicit_base_url="https://ignored.example/v1",
        explicit_api_mode="responses",
    )

    assert endpoint == LLMEndpointConfig(
        site="official",
        base_url=OFFICIAL_OPENAI_BASE_URL,
        api_mode="responses",
    )
    assert endpoint.is_official is True


def test_configured_endpoint_accepts_named_compatible_site_and_chat_alias():
    endpoint = configured_endpoint(
        explicit_site="my-relay",
        explicit_base_url="https://relay.example.com/openai/v1/",
        explicit_api_mode="chat",
    )

    assert endpoint.site == "my-relay"
    assert endpoint.base_url == "https://relay.example.com/openai/v1"
    assert endpoint.api_mode == "chat_completions"
    assert endpoint.is_official is False


def test_configured_endpoint_rejects_missing_or_insecure_custom_url():
    with pytest.raises(LLMConfigurationError, match="OPENAI_BASE_URL is required"):
        configured_endpoint(explicit_site="relay", explicit_base_url="")

    with pytest.raises(LLMConfigurationError, match="must use HTTPS"):
        configured_endpoint(
            explicit_site="relay",
            explicit_base_url="http://relay.example.com/v1",
        )


def test_configured_endpoint_allows_local_http_gateway():
    endpoint = configured_endpoint(
        explicit_site="local-gateway",
        explicit_base_url="http://127.0.0.1:8000/v1",
    )

    assert endpoint.base_url == "http://127.0.0.1:8000/v1"


def test_default_client_passes_selected_site_url_and_key(monkeypatch):
    import openai

    captured = {}
    sentinel = object()

    def fake_openai(**kwargs):
        captured.update(kwargs)
        return sentinel

    monkeypatch.setenv("OPENAI_API_KEY", "relay-key")
    monkeypatch.setattr(openai, "OpenAI", fake_openai)
    endpoint = LLMEndpointConfig(
        site="relay",
        base_url="https://relay.example.com/v1",
        api_mode="responses",
    )

    client = _default_client(endpoint)

    assert client is sentinel
    assert captured == {
        "api_key": "relay-key",
        "base_url": "https://relay.example.com/v1",
    }


def test_parse_with_schema_supports_chat_completions_compatible_site():
    response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                finish_reason="stop",
                message=SimpleNamespace(
                    refusal=None,
                    parsed={"summary": "中转站提取成功"},
                ),
            )
        ]
    )
    client = FakeChatClient([response])
    endpoint = LLMEndpointConfig(
        site="relay",
        base_url="https://relay.example.com/v1",
        api_mode="chat_completions",
    )

    result = parse_with_schema(
        "system",
        "user",
        ExtractionResult,
        client=client,
        model="relay-model",
        endpoint=endpoint,
    )

    assert result.summary == "中转站提取成功"
    call = client.chat.completions.calls[0]
    assert call["model"] == "relay-model"
    assert call["response_format"] is ExtractionResult
    assert [message["role"] for message in call["messages"]] == ["system", "user"]
