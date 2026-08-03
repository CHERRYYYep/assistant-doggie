# 单会话 Agent Harness

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
  → 调用 Responses API 或 Chat Completions
  → 模型选择直接回答或请求工具
  → Harness 校验工具名与 JSON 参数
  → 应用侧执行受控工具并返回结果
  → 模型结合工具结果生成最终回答
  → 保存 assistant 消息
```

工具调用可以进行多轮，但默认最多 4 轮，避免无限循环。模型上下文默认包含最近 40 条可见对话消息；数据库会继续保存更早历史，后续可增加摘要或上下文压缩。

## 3. 当前工具

| 工具 | 用途 | 是否写数据 |
| --- | --- | --- |
| `list_active_buckets` | 列出最近活跃 Bucket | 否 |
| `search_memory` | 按关键词搜索长期记忆 | 否 |
| `get_bucket_detail` | 读取 Bucket 的记录、Todo、证据、决策和时间线 | 否 |
| `archive_memory` | 通过现有分类、置信度和提取流程保存内容 | 可能 |
| `save_to_existing_bucket` | 用户明确目标后直接追加 | 是 |
| `create_bucket_and_save` | 用户明确同意后创建并保存 | 是 |

普通问题不会自动归档。系统 Prompt 要求仅在用户明确说“记住、保存、归档、记录”，或内容明显属于需要持续跟踪的工作状态时调用写入工具。

## 4. 安全边界

当前 Harness 是应用内受控工具 Harness，不是任意本机执行器：

- 不提供 Shell、文件修改、浏览器控制或任意 Python 执行；
- 未注册工具会返回 `unknown tool`，不会动态执行名称对应的代码；
- 写入记忆仍复用现有 Bucket 分类、确认和事务逻辑；
- 工具输出被视为数据，不允许覆盖系统指令；
- API Key 仍只从 `.env` 读取，不写入数据库或对话内容。

如果未来增加 Shell、MCP、浏览器或第三方服务，需要单独设计权限、审批、超时、审计和可撤销机制，不能直接把字符串命令交给模型执行。

## 5. UI

Streamlit 默认展示两个页签：

- **对话助手**：ChatGPT 风格的单会话界面，显示历史用户/助手消息，并折叠展示工具调用记录；
- **Bucket 记忆**：保留原来的手工归档、确认、详情查看和纠错能力。

启动命令：

```bash
source .venv/bin/activate
streamlit run ui/streamlit_app.py
```
