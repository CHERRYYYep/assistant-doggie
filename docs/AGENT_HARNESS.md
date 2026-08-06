# 单会话 Agent Harness

> 运行状态（2026-08-06）：Rust `work-memory-agent`、`CanonicalRuntime` 和 `work-memory-server` 构成当前唯一目标运行路径。Python Harness/Streamlit 版本已放弃为目标实现，仅保留历史或兼容参考；本阶段不新增 Python 实现测试。

## 1. 目标

当前应用不再只把输入分类并归档。`app/services/agent_service.py` 提供一个最小但真实可运行的 Agent Harness，使模型能够：

1. 像普通对话助手一样回答问题并给出解决方案；
2. 使用本地持久化的单一对话历史理解上下文；
3. 在需要长期记忆时读取、搜索或写入 Bucket；
4. 把工具调用限制在本应用明确注册的能力内。

整个应用始终只有一个对话时间线，不提供多会话切换。Python legacy UI 将用户消息、助手回答和工具执行记录保存到 `chat_messages`；Rust canonical runtime 保存到 `conversation_messages`，重启后仍可读取。

## 2. 一轮对话流程

```text
用户输入
  → 读取最近历史
  → 保存当前 user 消息
  → 自动加载最近活跃 Bucket 概览
  → 调用 Responses API 或 Chat Completions
  → 模型选择直接回答或请求工具
  → Harness 校验工具名与 JSON 参数
  → 应用侧执行受控工具并返回结果
  → 模型结合工具结果生成最终回答
  → 保存 assistant 消息
```

工具调用可以进行多轮，但默认最多 4 轮，避免无限循环。Python legacy Harness 的上下文默认包含最近 40 条可见对话消息和最多 8 个活跃 Bucket；Rust canonical runtime 同样默认加载 40 条历史，但分类/记忆上下文最多加载 20 个活跃 Bucket，并携带 UI 当前选中的 Bucket ID。数据库会继续保存更早历史，后续可增加摘要或上下文压缩。Bucket 内容作为低信任数据注入，不拥有系统指令权限。

## 3. 当前工具

| 工具 | 用途 | 是否写数据 |
| --- | --- | --- |
| `list_active_buckets` | 列出最近活跃 Bucket | 否 |
| `search_memory` | 用自然语言查询长期记忆，支持实体、主题、时间、状态和结构化筛选，返回 Entry 级结果 | 否 |
| `get_bucket_detail` | 读取 Bucket 的记录、Todo、证据、决策和时间线 | 否 |
| `archive_memory` | 通过现有分类、置信度和提取流程保存内容 | 可能 |
| `save_to_existing_bucket` | 用户明确目标后直接追加 | 是 |
| `create_bucket_and_save` | 用户明确同意后创建并保存 | 是 |

Bucket 是对话的默认记忆层。用户提供可长期复用的工作事实、目标、进展、故障证据、实验结果、会议结论、决策或 Todo 时，Harness 会主动调用写入工具，不要求用户先说“记住”。问候、纯临时闲聊、只有问题但没有新增事实的消息，以及助手尚未被用户确认的建议不会写入，避免记忆污染。

### 3.1 `search_memory` 查询结果

`search_memory` 的参数只有自然语言 `query`。Rust canonical 查询器会将“查询接口 A 最近两周的压测结果”解析为 `MemoryQuery`：`raw_text`、`terms`、`entity_terms`、`topic_terms`、`bucket_terms`、`time_range`、`statuses`、`structured_filters` 和 `limit`。执行时按 `Entry.created_at` 做时间筛选，结果是一条 Entry 一个命中，可同时涉及多个 Bucket；响应另外提供 Bucket 分组、去重后的 `evidence` 和确定性 `answer`。

当前 `semantic_score` 只是 lexical similarity 的字段名，实际是字符串包含和命中比例，不是 embedding；`answer` 是 runtime 生成的确定性摘要，不是 LLM 二次生成。工具 Harness 负责工具名、参数和输出边界，具体 canonical executor 应将 `AgentToolArguments::SearchMemory` 的 query 委托给同一查询服务，不应退回旧的 Bucket-only 搜索契约。

## 4. 安全边界

当前 Harness 是应用内受控工具 Harness，不是任意本机执行器：

- 不提供 Shell、文件修改、浏览器控制或任意 Python 执行；
- 未注册工具会返回 `unknown tool`，不会动态执行名称对应的代码；
- 写入记忆仍复用现有 Bucket 分类、确认和事务逻辑；低信息输入必须先得到 `needs_confirmation`，不能因为模型 confidence 高而静默写入；
- Python Harness 对确认写入工具增加确定性保护：同一轮如果 `archive_memory` 返回 `needs_confirmation`，不得继续执行 `save_to_existing_bucket` / `create_bucket_and_save`；当前用户轮次没有明确确认时也不能直接调用确认写入工具；
- 工具输出被视为数据，不允许覆盖系统指令；
- Python API Key 由 `.env` 配置；Rust server 只读取进程环境变量且不自动加载 `.env`。两条路径都不把 API Key 写入数据库或对话内容。

如果未来增加 Shell、MCP、浏览器或第三方服务，需要单独设计权限、审批、超时、审计和可撤销机制，不能直接把字符串命令交给模型执行。

## 5. Rust R4c/R4d canonical 边界

Rust 版本已经建立与 Python Harness 对齐的协议边界，并接入 canonical runtime/server：

- 复用 `async-openai` 的 Responses/Chat Completions wire 类型、`ureq` 的同步 HTTP transport，以及 `work-memory-contracts` 的严格六工具参数校验。
- 工具循环有固定 allow-list、JSON 参数拒绝、工具错误数据化和最大 tool round；memory context 以低信任 `user` 内容注入。
- `work-memory-agent` 提供工具定义、严格参数校验和 `AgentToolExecutor` 回调边界；`CanonicalRuntime` 负责历史、user/tool/assistant 消息持久化和 archive 闭环，`work-memory-server` 提供 HTTP/API/UI 入口。自然语言记忆查询的 canonical HTTP 入口是 `/api/memory/query`，具体 Agent executor 应复用同一 `CanonicalService::query_memory` / `query_memory_with_plan`。
- 完整 turn 不是一个覆盖所有步骤的原子事务：工具副作用可能在后续模型失败前提交，assistant 只在 Harness 成功后保存；redirect 安全、写操作幂等、provider 状态校验、正式运营资源/认证边界和失败恢复仍需补齐。工具 metadata、provider schema 与参数契约已集中到 `work-memory-contracts::AGENT_TOOL_DEFINITIONS`，并由 Responses/Chat parity 测试覆盖。

## 6. UI

Streamlit 只保留一个统一工作界面，作为 legacy UI；Rust canonical server 同时提供同源的内嵌 Web UI：

- 主区域是 ChatGPT 风格的单会话时间线，回答、读取记忆和写入记忆发生在同一条对话中；
- 独立侧边栏展示活跃 Bucket、搜索、详情和纠错，不受长期对话滚动影响；
- 不再提供第二个“手工归档”输入框，避免同一份信息存在两套入口和两套状态；
- 工具调用仍在对话时间线中折叠展示，用户可以看到本轮是否读取、创建或更新了 Bucket；Rust 内嵌 UI 另提供默认关闭的单轮“允许确认追加/新建”复选框；
- Rust 内嵌 UI 的语言查询面板调用 `GET /api/memory/query`，展示 query plan、Entry 命中、多个 Bucket、去重 evidence 和确定性 answer；旧 `/api/buckets/search` 仍用于兼容的 Bucket 级搜索。
- Todo 总览、文件工具、审批记录和设置等后续能力统一扩展到侧边栏。

legacy Streamlit 启动命令：

```bash
source .venv/bin/activate
streamlit run ui/streamlit_app.py
```

Rust canonical UI/API：

```bash
cargo run -p work-memory-server
```
