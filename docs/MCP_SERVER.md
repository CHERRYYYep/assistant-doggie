# Doggie MCP Server

Doggie 的 TypeScript MCP server 让 Claude Code、Codex 或其他 MCP 客户端读取本地长期记忆，并提交需要用户批准的新记录。

## 安全模型

第一版只暴露四个工具：

| 工具 | 类型 | 行为 |
|---|---|---|
| `list_active_buckets` | 只读 | 列出最近活跃的 Bucket |
| `search_memory` | 只读 | 自然语言搜索 Entry、Bucket 和 evidence |
| `get_bucket_detail` | 只读 | 读取指定 Bucket 的完整详情 |
| `propose_entry` | 待确认写入 | 只创建 `needs_confirmation` attempt，不创建正式 Entry |

MCP server **不暴露**直接归档、新建 Bucket、直接追加 Entry、移动或删除等写工具。

`propose_entry` 的流程是：

```text
MCP 客户端提交事实
  → Doggie 创建 pending archive attempt
  → Doggie 写入一张可持久化的确认卡片
  → 用户在本地 Web UI 中确认目标 Bucket / 新建 / 不保存
  → 确认后才产生正式 Entry 和 memory
```

因此，MCP 客户端不能绕过现有归档确认门控。

## 安装依赖

```bash
npm install
```

项目使用官方 TypeScript MCP SDK：

- `@modelcontextprotocol/server`：生产 stdio server；
- `@modelcontextprotocol/client`：仅用于内存协议集成测试。

## 本地启动

```bash
npm run mcp
```

也可以直接运行：

```bash
/home/cherry/assistant-doggie/bin/doggie-mcp
```

MCP 使用标准输入/输出传输。标准输出只用于 MCP JSON-RPC；错误日志写到标准错误。

## 数据库路径

按以下优先级选择数据库：

1. `DOGGIE_DATABASE_PATH`；
2. 兼容变量 `RUST_DATABASE_PATH`；
3. 仓库根目录的 `doggie.db`。

如果 Web UI 使用了自定义数据库路径，MCP 进程也必须指向同一个文件。建议 Web 的 `.env` 和 MCP 客户端注册都使用绝对路径：

```dotenv
DOGGIE_DATABASE_PATH=/home/cherry/assistant-doggie/doggie.db
```

Web 启动：

```bash
npm start
```

手工启动 MCP：

```bash
DOGGIE_DATABASE_PATH=/home/cherry/assistant-doggie/doggie.db npm run mcp
```

SQLite 已配置 WAL 和 `busy_timeout`，允许本地 Web 与 MCP 进程共享同一 canonical database。

## 注册到 Claude Code

使用仓库内的绝对路径：

```bash
claude mcp add doggie -s user -- /home/cherry/assistant-doggie/bin/doggie-mcp
```

如果需要指定其他数据库，可以把 `env` 作为 stdio 命令：

```bash
claude mcp add doggie -s user \
  -e DOGGIE_DATABASE_PATH=/home/cherry/assistant-doggie/doggie.db \
  -- /home/cherry/assistant-doggie/bin/doggie-mcp
```

注册后可使用 Claude CLI 自带的 MCP 查看命令确认 `doggie` 已加载，并检查四个工具是否可见。

## 注册到 Codex

```bash
codex mcp add doggie \
  --env DOGGIE_DATABASE_PATH=/home/cherry/assistant-doggie/doggie.db \
  -- /home/cherry/assistant-doggie/bin/doggie-mcp
```

验证：

```bash
codex mcp list
codex mcp get doggie --json
```

## 资源上限

MCP 边界包含：

- stdio 单条消息最大 64 KiB；
- 查询最多 500 字符；
- Bucket ID 最多 200 字符；
- proposal 文本最多 16,000 字符；
- 工具结构化结果最大 64 KiB；
- 所有输入 schema 都拒绝未知字段；
- 未注册工具由 MCP server 拒绝，不进行动态执行。

工具输出通过 MCP `content` 和 `structuredContent` 返回，是协议数据，不是可执行命令。

## UI 确认

调用 `propose_entry` 后，刷新 Doggie Web UI 的聊天历史即可看到确认卡片。卡片继续复用现有 `/api/chat/confirm` 流程，支持：

1. 保存到推荐 Bucket；
2. 保存到其他 Bucket；
3. 创建新 Bucket；
4. 不保存。

如果 proposal 指定 `bucket_id`，它只成为推荐候选；服务端仍会验证 Bucket 存在且处于 active 状态，用户仍必须确认。

## 验证

```bash
npm run check
```

T10 的测试覆盖：

- 官方 MCP SDK 的 `tools/list`；
- 官方 SDK 内存 transport 的 `tools/call`；
- 未注册直接写工具被拒绝；
- 未知字段在 executor 前被拒绝；
- 三个读取工具不产生写入；
- `propose_entry` 只创建 pending attempt；
- proposal 能生成 Web UI 可恢复的确认卡片；
- 参数与输出资源上限。


## T13：由 Doggie 启动 CLI 时的只读子服务

普通 Claude/Codex 直接接入 MCP 的四工具合同不变。通过 Doggie 网页创建并批准 Agent 任务时，服务端另以 `DOGGIE_MCP_READ_ONLY=1` 启动 MCP 子进程，仅注册 `list_active_buckets`、`search_memory`、`get_bucket_detail`，不注册 `propose_entry`。CLI 工具配置也只允许这三个名字，形成两层限制。

网页模型 `OPENAI_*` 与 CLI 的认证分开配置。完整使用步骤与只读权限范围见 [AGENT_CONTROL.md](AGENT_CONTROL.md)。
