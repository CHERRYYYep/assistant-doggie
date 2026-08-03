from types import SimpleNamespace

import pytest

from app.llm import LLMResponseError, parse_with_schema
from app.schemas import ExtractionResult


class FakeResponses:
    def __init__(self, responses):
        self._responses = iter(responses)
        self.calls = 0

    def parse(self, **kwargs):
        self.calls += 1
        return next(self._responses)


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

    with pytest.raises(LLMResponseError, match="refused"):
        parse_with_schema(
            "system",
            "user",
            ExtractionResult,
            client=FakeClient([response]),
            model="test-model",
            max_retries=0,
        )
