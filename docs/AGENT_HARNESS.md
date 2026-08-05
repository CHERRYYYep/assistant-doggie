# 单会话 Agent Harness

> 运行状态（2026-08-05）：下文描述的 Python Harness 仍是当前生产实现。Rust `work-memory-agent` 的 R4c Harness 只是未接入 service/store、SQLite、API 或 UI 的工作区草稿，不能视为生产切换。

## 1. 目标

当前应用不再只把输入分类并归档。`app/services/agent_service.py` 提供一个最小但真实可运行的 Agent Harness，使模型能够：

1. 像普通对话助手一样回答问题并给出解决方案；
2. 使用本地持久化的单一对话历史理解上下文；
3. 在需要长期记忆时读取、搜索或写入 Bucket；
4. 把工具调用限制在本应用明确注册的能力内。

整个应用始终只有一个对话时间线，不提供多会话切换。用户消息、助手回答和工具执行记录都保存在 `chat_messages` 表中，重启 Streamlit 后仍可读取。

## 2. 一轮对话流程

```text
用户输入
  → 保存 user 消息
  → 读取最近的 user/assistant 历史
  → 自动加载最近活跃 Bucket 概览
  → 调用 Responses API 或 Chat Completions
  → 模型选择直接回答或请求工具
  → Harness 校验工具名与 JSON 参数
  → 应用侧执行受控工具并返回结果
  → 模型结合工具结果生成最终回答
  → 保存 assistant 消息
```

工具调用可以进行多轮，但默认最多 4 轮，避免无限循环。模型上下文默认包含最近 40 条可见对话消息、最多 8 个活跃 Bucket 的摘要概览，以及 UI 当前选中的 Bucket ID；数据库会继续保存更早历史，后续可增加摘要或上下文压缩。Bucket 内容作为低信任数据注入，不拥有系统指令权限。

## 3. 当前工具

| 工具 | 用途 | 是否写数据 |
| --- | --- | --- |
| `list_active_buckets` | 列出最近活跃 Bucket | 否 |
| `search_memory` | 按关键词搜索长期记忆 | 否 |
| `get_bucket_detail` | 读取 Bucket 的记录、Todo、证据、决策和时间线 | 否 |
| `archive_memory` | 通过现有分类、置信度和提取流程保存内容 | 可能 |
| `save_to_existing_bucket` | 用户明确目标后直接追加 | 是 |
| `create_bucket_and_save` | 用户明确同意后创建并保存 | 是 |

Bucket 是对话的默认记忆层。用户提供可长期复用的工作事实、目标、进展、故障证据、实验结果、会议结论、决策或 Todo 时，Harness 会主动调用写入工具，不要求用户先说“记住”。问候、纯临时闲聊、只有问题但没有新增事实的消息，以及助手尚未被用户确认的建议不会写入，避免记忆污染。

## 4. 安全边界

当前 Harness 是应用内受控工具 Harness，不是任意本机执行器：

- 不提供 Shell、文件修改、浏览器控制或任意 Python 执行；
- 未注册工具会返回 `unknown tool`，不会动态执行名称对应的代码；
- 写入记忆仍复用现有 Bucket 分类、确认和事务逻辑；
- 工具输出被视为数据，不允许覆盖系统指令；
- API Key 仍只从 `.env` 读取，不写入数据库或对话内容。

如果未来增加 Shell、MCP、浏览器或第三方服务，需要单独设计权限、审批、超时、审计和可撤销机制，不能直接把字符串命令交给模型执行。

## 5. Rust R4c 草稿边界

Rust 版本已经建立与 Python Harness 对齐的协议边界，但暂不替代下文的生产实现：

- 复用 `async-openai` 的 Responses/Chat Completions wire 类型、`ureq` 的同步 HTTP transport，以及 `work-memory-contracts` 的严格六工具参数校验。
- 工具循环有固定 allow-list、JSON 参数拒绝、工具错误数据化和最大 tool round；memory context 以低信任 `user` 内容注入。
- `AgentToolExecutor` 由调用方注入，尚未绑定 `work-memory-service` / `work-memory-store`，也没有完整 turn 原子事务、工具审计或聊天消息持久化接线。
- 生产前还要处理 redirect 安全、tool call/上下文资源预算、写操作幂等、provider 状态校验、重试分类，以及工具 metadata 与参数合同的单一来源。

## 6. UI

Streamlit 只保留一个统一工作界面：

- 主区域是 ChatGPT 风格的单会话时间线，回答、读取记忆和写入记忆发生在同一条对话中；
- 独立侧边栏展示活跃 Bucket、搜索、详情和纠错，不受长期对话滚动影响；
- 不再提供第二个“手工归档”输入框，避免同一份信息存在两套入口和两套状态；
- 工具调用仍在对话时间线中折叠展示，用户可以看到本轮是否读取、创建或更新了 Bucket；
- Todo 总览、文件工具、审批记录和设置等后续能力统一扩展到侧边栏。

启动命令：

```bash
source .venv/bin/activate
streamlit run ui/streamlit_app.py
```
