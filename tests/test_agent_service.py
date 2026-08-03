from types import SimpleNamespace

import pytest

from app import db
from app.db import init_db
from app.llm import LLMEndpointConfig
from app.services.agent_service import (
    execute_agent_tool,
    list_chat_messages,
    run_agent_turn,
)


@pytest.fixture
def database_url(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'agent.db'}"
    monkeypatch.setenv("DATABASE_URL", url)
    db._create_engine.cache_clear()
    init_db(url)
    return url


class FakeResponses:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return next(self.responses)


class FakeResponsesClient:
    def __init__(self, responses):
        self.responses = FakeResponses(responses)


class FakeChatCompletions:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return next(self.responses)


class FakeChatClient:
    def __init__(self, responses):
        self.chat = SimpleNamespace(completions=FakeChatCompletions(responses))


def test_responses_harness_executes_tool_and_persists_single_conversation(database_url):
    tool_call = SimpleNamespace(
        type="function_call",
        name="search_memory",
        call_id="call-1",
        arguments='{"query":"支付"}',
    )
    client = FakeResponsesClient(
        [
            SimpleNamespace(status="completed", output=[tool_call], output_text=""),
            SimpleNamespace(
                status="completed",
                output=[],
                output_text="根据历史记录，建议先检查第三方支付回调日志。",
            ),
        ]
    )
    executed = []

    def tool_executor(name, arguments):
        executed.append((name, arguments))
        return {"ok": True, "results": [{"title": "支付故障"}]}

    result = run_agent_turn(
        "之前的支付问题现在应该怎么排查？",
        client=client,
        model="test-model",
        endpoint=LLMEndpointConfig(
            site="test",
            base_url="https://example.test/v1",
            api_mode="responses",
        ),
        tool_executor=tool_executor,
    )

    assert result.assistant_message.content.startswith("根据历史记录")
    assert executed == [("search_memory", {"query": "支付"})]
    assert len(client.responses.calls) == 2
    second_input = client.responses.calls[1]["input"]
    assert any(item.get("type") == "function_call_output" for item in second_input if isinstance(item, dict))
    assert [message.role for message in list_chat_messages()] == [
        "user",
        "tool",
        "assistant",
    ]


def test_chat_completions_harness_executes_tool_loop(database_url):
    tool_call = SimpleNamespace(
        id="chat-call-1",
        function=SimpleNamespace(name="list_active_buckets", arguments="{}"),
    )
    client = FakeChatClient(
        [
            SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content=None,
                            refusal=None,
                            tool_calls=[tool_call],
                        )
                    )
                ]
            ),
            SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content="目前没有活跃 Bucket，可以先直接提问或要求我记住一条工作记录。",
                            refusal=None,
                            tool_calls=[],
                        )
                    )
                ]
            ),
        ]
    )
    executed = []

    def tool_executor(name, arguments):
        executed.append((name, arguments))
        return {"ok": True, "buckets": []}

    result = run_agent_turn(
        "现在有哪些工作记忆？",
        client=client,
        model="test-model",
        endpoint=LLMEndpointConfig(
            site="test",
            base_url="https://example.test/v1",
            api_mode="chat_completions",
        ),
        tool_executor=tool_executor,
    )

    assert result.assistant_message.content.startswith("目前没有活跃")
    assert executed == [("list_active_buckets", {})]
    assert len(client.chat.completions.calls) == 2
    second_messages = client.chat.completions.calls[1]["messages"]
    assert second_messages[-2]["role"] == "assistant"
    assert second_messages[-1] == {
        "role": "tool",
        "tool_call_id": "chat-call-1",
        "content": '{"ok": true, "buckets": []}',
    }
    assert [message.role for message in list_chat_messages()] == [
        "user",
        "tool",
        "assistant",
    ]


def test_harness_reuses_persisted_dialogue_history(database_url):
    first_client = FakeResponsesClient(
        [SimpleNamespace(status="completed", output=[], output_text="项目代号是樱桃。")]
    )
    endpoint = LLMEndpointConfig(
        site="test",
        base_url="https://example.test/v1",
        api_mode="responses",
    )
    run_agent_turn(
        "记住我们正在讨论的项目代号是樱桃。",
        client=first_client,
        model="test-model",
        endpoint=endpoint,
    )

    second_client = FakeResponsesClient(
        [SimpleNamespace(status="completed", output=[], output_text="项目代号是樱桃。")]
    )
    run_agent_turn(
        "项目代号是什么？",
        client=second_client,
        model="test-model",
        endpoint=endpoint,
    )

    input_items = second_client.responses.calls[0]["input"]
    visible_messages = [
        item for item in input_items if isinstance(item, dict) and item.get("role") != "system"
    ]
    assert [item["role"] for item in visible_messages] == [
        "user",
        "assistant",
        "user",
    ]
    assert visible_messages[1]["content"] == "项目代号是樱桃。"


def test_unknown_harness_tool_cannot_execute_arbitrary_code(database_url):
    result = execute_agent_tool("run_shell", {"command": "rm -rf /"})

    assert result["ok"] is False
    assert result["error"] == "unknown tool: run_shell"
