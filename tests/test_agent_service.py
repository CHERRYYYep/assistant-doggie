from types import SimpleNamespace

import pytest

from app import db
from app.db import init_db
from app.llm import LLMEndpointConfig
from app.services.agent_service import (
    build_default_memory_context,
    execute_agent_tool,
    list_chat_messages,
    run_agent_turn,
)
from app.services.bucket_service import create_bucket


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
    first_input = client.responses.calls[0]["input"]
    assert first_input[1]["role"] == "user"
    assert "当前还没有活跃 Bucket" in first_input[1]["content"]
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
    assert "默认 Bucket 记忆概览" in input_items[1]["content"]
    conversation_messages = input_items[2:]
    assert [item["role"] for item in conversation_messages] == [
        "user",
        "assistant",
        "user",
    ]
    assert conversation_messages[1]["content"] == "项目代号是樱桃。"


def test_default_memory_context_contains_active_bucket_overview(database_url):
    bucket = create_bucket(
        "支付回调故障",
        "incident",
        summary="第三方回调持续返回 502。",
        tags=["支付", "502"],
    )

    context = build_default_memory_context(current_focus_bucket_id=bucket.id)

    assert bucket.id in context
    assert "支付回调故障" in context
    assert "第三方回调持续返回 502" in context
    assert '"is_current_focus": true' in context


def test_unknown_harness_tool_cannot_execute_arbitrary_code(database_url):
    result = execute_agent_tool("run_shell", {"command": "rm -rf /"})

    assert result["ok"] is False
    assert result["error"] == "unknown tool: run_shell"


def test_registered_tool_rejects_unknown_arguments():
    result = execute_agent_tool("search_memory", {"query": "支付", "limit": 10})

    assert result["ok"] is False
    assert result["error"].startswith("ValidationError:")
    assert "Extra inputs are not permitted" in result["error"]


def test_registered_tool_rejects_missing_required_arguments():
    result = execute_agent_tool("get_bucket_detail", {})

    assert result["ok"] is False
    assert result["error"].startswith("ValidationError:")
    assert "Field required" in result["error"]


def test_registered_tool_normalizes_arguments_before_execution(monkeypatch):
    executed = []

    def fake_tool_payload(name, arguments):
        executed.append((name, arguments))
        return {"ok": True}

    monkeypatch.setattr(
        "app.services.agent_service._tool_payload",
        fake_tool_payload,
    )

    result = execute_agent_tool(
        "save_to_existing_bucket",
        {"bucket_id": " bucket-1 ", "text": " 故障恢复。 "},
    )

    assert result == {"ok": True}
    assert executed == [
        (
            "save_to_existing_bucket",
            {"bucket_id": "bucket-1", "text": "故障恢复。"},
        )
    ]


def test_harness_blocks_same_turn_write_after_archive_needs_confirmation(database_url):
    archive_call = SimpleNamespace(
        type="function_call",
        name="archive_memory",
        call_id="archive-call",
        arguments='{"text":"压测结果更新了"}',
    )
    save_call = SimpleNamespace(
        type="function_call",
        name="save_to_existing_bucket",
        call_id="save-call",
        arguments='{"bucket_id":"bucket-1","text":"压测结果更新了"}',
    )
    client = FakeResponsesClient(
        [
            SimpleNamespace(
                status="completed",
                output=[archive_call, save_call],
                output_text="",
            ),
            SimpleNamespace(
                status="completed",
                output=[],
                output_text="信息不够明确，我先请你确认保存位置。",
            ),
        ]
    )
    executed = []

    def tool_executor(name, arguments):
        executed.append((name, arguments))
        if name == "archive_memory":
            return {
                "ok": True,
                "archive": {
                    "status": "needs_confirmation",
                    "action": "ask_user",
                },
            }
        return {"ok": True, "archive": {"status": "archived"}}

    result = run_agent_turn(
        "压测结果更新了",
        client=client,
        model="test-model",
        endpoint=LLMEndpointConfig(
            site="test",
            base_url="https://example.test/v1",
            api_mode="responses",
        ),
        tool_executor=tool_executor,
    )

    assert result.assistant_message.content.startswith("信息不够明确")
    assert executed == [("archive_memory", {"text": "压测结果更新了"})]
    blocked_output = result.tool_messages[1].details["output"]
    assert blocked_output["ok"] is False
    assert "requires user confirmation" in blocked_output["error"]


def test_harness_requires_explicit_user_confirmation_for_direct_write(database_url):
    save_call = SimpleNamespace(
        type="function_call",
        name="save_to_existing_bucket",
        call_id="save-call",
        arguments='{"bucket_id":"bucket-1","text":"QPS 达到 1200。"}',
    )
    client = FakeResponsesClient(
        [
            SimpleNamespace(status="completed", output=[save_call], output_text=""),
            SimpleNamespace(
                status="completed",
                output=[],
                output_text="请先确认要保存到哪个 Bucket。",
            ),
        ]
    )
    executed = []

    def tool_executor(name, arguments):
        executed.append((name, arguments))
        return {"ok": True}

    result = run_agent_turn(
        "压测结果更新了",
        client=client,
        model="test-model",
        endpoint=LLMEndpointConfig(
            site="test",
            base_url="https://example.test/v1",
            api_mode="responses",
        ),
        tool_executor=tool_executor,
    )

    assert result.assistant_message.content.startswith("请先确认")
    assert executed == []
    assert result.tool_messages[0].details["output"]["ok"] is False


def test_harness_allows_write_after_explicit_user_confirmation(database_url):
    save_call = SimpleNamespace(
        type="function_call",
        name="save_to_existing_bucket",
        call_id="save-call",
        arguments='{"bucket_id":"bucket-1","text":"QPS 达到 1200。"}',
    )
    client = FakeResponsesClient(
        [
            SimpleNamespace(status="completed", output=[save_call], output_text=""),
            SimpleNamespace(
                status="completed",
                output=[],
                output_text="已按你的确认保存到接口 A 压测。",
            ),
        ]
    )
    executed = []

    def tool_executor(name, arguments):
        executed.append((name, arguments))
        return {"ok": True, "archive": {"status": "archived"}}

    run_agent_turn(
        "确认保存到接口 A 压测",
        client=client,
        model="test-model",
        endpoint=LLMEndpointConfig(
            site="test",
            base_url="https://example.test/v1",
            api_mode="responses",
        ),
        tool_executor=tool_executor,
    )

    assert executed == [
        (
            "save_to_existing_bucket",
            {"bucket_id": "bucket-1", "text": "QPS 达到 1200。"},
        )
    ]
