# T13：TypeScript Agent Harness 与只读 CLI 控制面

2026-11-03。本阶段沿用 Node 标准库、Zod、Hono 和现有 SQLite 队列，没有新增依赖。

## 两条不同的模型路径

**网页聊天**使用 `.env` 的 `OPENAI_*` 配置。分类/提取继续走严格结构化输出，回答阶段新增 `AgentHarness`：模型提出工具调用，服务端校验、执行检索并把结果作为数据回传，直到模型回答或达到轮数上限。Responses 与 Chat Completions 共用执行逻辑。

**Agent 任务**启动你本机已经安装的 Claude Code 或 Codex CLI。它们使用各自的登录或 API 凭证，不会自动复用网页的 `OPENAI_API_KEY`。网页的“创建提案”仅存待批准记录，点击“批准只读执行”才会进入后台队列。

这两条路径都不能替用户批准归档。普通 MCP 客户端仍有三个读取工具及只提案的 `propose_entry`；Doggie 启动的 CLI 子进程拿到的 MCP 则只有三个读取工具。

## 启动和配置

```bash
npm ci
cp .env.example .env   # 首次配置；已有 .env 不要覆盖
chmod 600 .env
command -v codex
command -v claude
```

编辑 `.env`，先填写网页需要的 `OPENAI_API_KEY`、`OPENAI_MODEL`，然后按需设置：

```dotenv
DOGGIE_DATABASE_PATH=/home/you/assistant-doggie/doggie.db
DOGGIE_AGENT_CODEX_COMMAND=/absolute/path/to/codex
DOGGIE_AGENT_CLAUDE_COMMAND=/absolute/path/to/claude
DOGGIE_AGENT_WORKSPACE_ROOTS='["/home/you/projects"]'
```

只填写已安装并配置好认证的 CLI。不设置命令时对应 backend 禁用；空目录白名单仍允许无目录任务。CLI 命令不接受 shell 脚本片段或参数拼接。修改配置、升级 CLI 后重启 `npm start`。

浏览器打开启动日志给出的地址，在侧栏操作：

1. 选择已启用的 CLI。代码阅读任务先登记 Git 仓库的绝对路径；可同时填写已有 Bucket ID 建立记忆锚点。
2. 选择工作区，或选择“无目录”处理会议、想法等任务。
3. 填写指令，创建提案。确认卡片显示原指令、工作区、CLI 和会话 ID。
4. 点击“批准只读执行”或“拒绝”；排队/运行中可以取消。
5. 查看最终文本。继续同一上下文时，填写任务上的会话 ID，并保持 CLI 和工作区一致。换目录或 Git 基线后新建会话。

页面关闭/SSE 断线只停止观察，后台任务继续。重新打开或刷新可恢复观察；提交响应不明时先刷新检查，不要反复提交。SSE 提供任务状态，最终结果完成后读取，并非逐 token 输出。

## 用 TypeScript 理解实现

| 文件 | 负责什么 | 关键实现 |
|---|---|---|
| `src/domain/agent.ts` | 外部数据契约 | 字符串联合表达 backend/status；Zod 严格对象在运行时拒绝未知字段 |
| `src/agent/harness.ts` | 模型工具循环 | `Map` 保存固定注册表，allow-list 只能收窄；所有写工具均被过滤 |
| `src/agent/workspace.ts` | 目录与 Git 基线 | `realpath`、路径相对关系、无 shell 的 `execFile`、内容摘要 |
| `src/storage/agents.ts` | 持久化批准和身份 | SQLite 事务将批准、队列入场、任务状态一同提交 |
| `src/agent/service.ts` | 串起用例 | 批准前/执行前重新检查目录，显式恢复绑定，失败不自动重跑 |
| `src/agent/process.ts` | CLI 进程边界 | 固定 argv、stdin 指令、有界 JSONL、进程组终止、最终文本/会话 ID 解析 |
| `src/runtime/local-web.ts` | 生产组装 | 组装 Harness、AgentService 和 T12 worker，按 payload 分派 |
| `web/assets/agents.ts` | 网页控制器 | 独立批准按钮、恢复观察、转义展示指令与输出 |

`readonly` 是编译期约束；Zod 和 SQL trigger 才能挡住运行时错误。`Promise` 表达等待外部工作，SQLite 的短事务保持同步；不会在事务中等模型或进程。

```text
创建提案
  → agent_sessions + pending_actions + agent_tasks（同一事务）
批准原指令
  → 校验不可变绑定、Git 基线、工作区/会话互斥
  → pending action approved + agent task queued + background task（同一事务）
T12 worker claim
  → 再校验目录和会话 → spawn CLI → 有界 JSONL → 最终结果和远端会话 ID
  → agent task / pending action 终态 → background task 终态 → SSE 通知
```

数据库 schema v5 新增三张 agent 表和 `buckets.workspace_id`。已有 TS v4 库启动时自动事务迁移；原对话、归档确认和排队任务保留。旧版本程序不能打开升级后的库；首次在真实数据上升级前自行做 SQLite 一致性备份。本次验收仅操作临时库。

Workspace 基线不可修改；重新登记变化后的同一路径生成新的 workspace ID。同一路径的不同基线仍互斥。Session 的 backend/workspace 绑定不可修改；CLI 的远端 ID 与内部 session ID 分开保存，恢复时使用确切远端 ID，不使用 `--last`。

## 有界执行

Harness：参数 32 KiB、工具结果 64 KiB、上下文请求 64 KiB、历史最多 100 条；默认 4 轮工具、每轮最多 16 次调用。历史可丢弃最早部分来适配预算，当前请求不被静默截断；仍超限则返回稳定错误。非法参数/未知工具作为数据返回模型，不执行。Responses 无状态请求保留经过字段筛选的 encrypted reasoning，且不让模型返回的 `role` 获得系统权限。

CLI：stdout 总计 1 MiB、单行 128 KiB、事件最多 8192、最终文本及 stderr 各 64 KiB；stderr 不存储。进程以独立进程组运行，取消/超时先 TERM，500ms 后 KILL，等待实际 close；T12 任务 deadline 为 120 秒。批准和执行各有 Git 检查。路径必须是白名单内的 Git 根目录，拒绝缺失路径、越界符号链接和不支持的子模块；快照受 Git 命令 64 KiB buffer、1000 个未跟踪文件/8 MiB 总大小约束，过大时拒绝登记。

非 coding 会话 cwd 固定在数据库旁的 `.doggie-agent-sessions/<session-id>/`，目录权限要求 0700，拒绝符号链接。为支持恢复会话，该目录保留并排除 Git 跟踪；停止服务且不再需要会话时可人工清理。

进程失败/取消后的 session 不继续复用，避免恢复不确定上下文。重启时 queued 任务继续，running 任务标记 interrupted，不自动重跑。终态落盘故障会停止 worker 和新任务入场，不能把已经返回的结果伪报为取消；需重启并人工检查。

2026-11-18 后端修缮后：正常 Agent/WorkItem GET 不触发全局恢复；queue 失败/取消同事务终结审批并更新 Agent/目标。启动恢复与执行器所有权在同一事务，pruning 前仍做异常恢复。Agent 成功与 queue 成功仍是两个提交，重启保留已提交 Agent 证据，不从 queue 成功臆造结果。完整故障与兼容边界见 [验收记录](BACKEND_REPAIR_ACCEPTANCE.md)。

## CLI 权限与兼容性

Claude 使用当前支持的 `--bare --restricted`、`--tools`、`--allowedTools`、`--permission-mode dontAsk` 和 `--strict-mcp-config`。新会话使用 `--session-id`，恢复使用 `--resume`，两者不同时传入。代码阅读只开放 Read/Grep/Glob/WebSearch；无目录只开放 WebSearch，均附加 Doggie 三个只读 MCP 工具。关闭 hooks、项目/个人 settings，并拒绝写文件、Bash 和子 Agent 工具。

Codex 使用 `exec --json --ignore-user-config --ignore-rules`，通过命令行 config 设置 read-only sandbox、never approval、禁用 hooks/plugins/apps/multi_agent 等能力，并替换 MCP 配置。无目录再关闭 shell 和 image 工具；恢复使用确切的 `exec … resume <remote-id> -`。搜索为 cached，不保证联网实时检索。

启动 CLI 前只读检查 `--help` 中必要参数，不支持这些接口时任务失败为 unavailable，不回退到更宽权限。官方参考：

- [Codex 非交互执行](https://developers.openai.com/codex/noninteractive/)
- [Codex CLI 参数](https://developers.openai.com/codex/cli/reference/)
- [Codex 配置](https://developers.openai.com/codex/config-reference/)
- [Codex 安全边界](https://developers.openai.com/codex/security/)

这是受控的本地只读 MVP，不是跨平台恶意代码沙箱。目录白名单限制任务的绑定和启动位置；Codex 的 read-only shell 可能读取工作区外、当前用户可读的文件。Git 检查不是阻止其他程序修改目录的文件系统锁。外部 CLI 的能力、隔离和服务端策略可能随版本变化，需要单独做真实环境 smoke。硬杀父进程/机器断电不能保证当场回收所有子进程，恢复策略只保证不自动重放已启动任务。

本阶段不开放 coding 写入、自动提交、部署、插件执行或定时调用。测试使用 fake model/runner 和本机假进程；未调用真实 Claude/Codex 模型，未验证用户账号、配额和实际服务可用性。

## HTTP 接口

全部沿用同源 loopback Host/Origin/JSON 安全检查。

| 方法 | 路径 | 数据 |
|---|---|---|
| GET | `/api/agent/capabilities` | 已配置 backend，permission=read_only |
| GET/POST | `/api/agent/workspaces` | 列出 / `{path,bucketId?}` 登记 |
| GET | `/api/agent/tasks`、`/api/agent/tasks/:id` | 任务状态、会话 ID、最终结果 |
| POST | `/api/agent/tasks` | `{backend,workspaceId:null或UUID,instruction,sessionId?}` |
| POST | `/api/agent/tasks/:id/approve` | `{instruction:原指令,confirmation_granted:true}`，返回 queueTask |
| POST | `/api/agent/tasks/:id/reject` | `{instruction:原指令}` |
| POST | `/api/agent/tasks/:id/cancel` | `{}` |
| GET | `/api/tasks/:queueId/events` | 复用 T12 SSE；这里使用 queue ID |

所有 POST 都拒绝未知字段。通用 `/api/tasks` 只接受聊天消息，不接受客户端直接注入 `agent_task_id` 绕过批准。
