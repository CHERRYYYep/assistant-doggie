# Doggie

一个面向个人工作的本地长期记忆 Agent。用户可以像使用聊天助手一样输入日志、想法、会议结论、实验记录或排障事实；Doggie engine 会完成理解、查询、归档和后续纠错。

```text
对话输入
  → 分类已有/新建 Bucket
  → 低信息安全门控
  → 结构化提取
  → Doggie canonical SQLite 持久化
  → 返回可解释的归档结果
```

`doggie-local-web` 是唯一应用入口，提供本地 HTTP API，并同源托管独立静态 Web UI 资源。默认监听 `127.0.0.1:8787`，数据库默认使用 `doggie.db`。

## 当前能力

- **ChatGPT 风格单会话**：保存 user、assistant 和 tool 消息，重启后恢复对话历史。
- **自动归档**：安全地追加到已有 Bucket 或创建新 Bucket，并保留 Entry 原文和结构化 memory。
- **确认式归档**：不确定时返回推荐 Bucket、备选 Bucket、模型判断理由、创建新 Bucket 和“不保存”选项。
- **低信息保护**：输入只有模糊指代或状态短句时，即使模型给出高置信度，也优先询问用户。
- **可纠错**：归档结果提供修改 Bucket 的入口，也支持通过 API 移动 Entry、修改 Bucket 状态。
- **自然语言记忆查询**：支持 Bucket 名称、Entry 原文、summary、tag、entity、时间范围、状态和结构化字段筛选。
- **查询聚合**：关键词与结构化条件组合，按结果质量重排，去重 evidence，并可合并多个 Bucket 的结果。

## 快速开始

需要 Node.js 24 或更新版本，以及一个支持严格结构化输出的 OpenAI 或 OpenAI-compatible 模型端点。

```bash
npm ci
cp .env.example .env
chmod 600 .env
# 编辑 .env，至少填写 OPENAI_API_KEY 和 OPENAI_MODEL
npm start
```

启动成功后终端会输出实际地址，默认是：

```text
http://127.0.0.1:8787/
```

程序自动读取**当前工作目录**的 `.env`，shell 环境变量优先。相对数据库路径也相对于当前工作目录解析；若要让 Web、Claude 和 Codex 的 MCP 共享记忆，推荐统一填写绝对路径：

```dotenv
DOGGIE_DATABASE_PATH=/home/cherry/assistant-doggie/doggie.db
```

本地 Web UI 源文件位于 `apps/doggie-local-web/frontend/`，由 TypeScript `node:http` + Hono server 同源提供。Node 24 在启动时剥离浏览器资源中的 TypeScript 类型，不需要 Vite、Webpack 或 JavaScript 构建产物。

检查代码与测试：

```bash
npm run check
```

当前 Web MVP 的 assistant 回复聚焦归档状态、确认和确定性记忆查询。带只读工具循环的完整模型回答以及 Claude/Codex 任务编排仍属于计划中的 T13，不在 T10b 提前实现。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DOGGIE_DATABASE_PATH` | `doggie.db` | canonical SQLite 文件路径；相对路径基于启动工作目录 |
| `DOGGIE_SERVER_ADDRESS` | `127.0.0.1:8787` | 只接受字面量 `127.0.0.1` 或 `[::1]` 的监听地址 |
| `RUST_DATABASE_PATH` / `RUST_SERVER_ADDRESS` | 无 | 旧变量名兼容读取；新配置请使用 `DOGGIE_*` |
| `OPENAI_SITE` | `official` | `official` 或自定义站点名称 |
| `OPENAI_BASE_URL` | 官方为 `https://api.openai.com/v1` | OpenAI-compatible API 根地址；官方站点留空 |
| `OPENAI_API_MODE` | `responses` | `responses` 或 `chat_completions` |
| `OPENAI_API_KEY` | 无 | 必填；模型端点 API Key |
| `OPENAI_MODEL` | 无 | 必填；分类和提取使用的模型名 |
| `OPENAI_TIMEOUT_SECONDS` | `30` | 单次模型 HTTP 请求超时，范围 1–300 秒 |

自定义远程 endpoint 必须使用 HTTPS；HTTP 只允许指向本机 loopback。`OPENAI_SITE=official` 时 `OPENAI_BASE_URL` 必须留空。`OPENAI_BASE_URL` 应填写 API 根地址（通常以 `/v1` 结尾），不要附加 `/responses` 或 `/chat/completions`。

不要把 API Key、本地数据库、日志或 `node_modules/` 提交到 Git。

## HTTP API

成功响应均为 JSON，请求中的文本字段不能为空。

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/chat` | 发送一轮对话；输入会先归档，再生成回答 |
| `GET` | `/api/chat/history?limit=40` | 读取对话历史 |
| `POST` | `/api/chat/confirm` | 提交确认后的追加、新建或不保存选择 |
| `POST` | `/api/archive` | 执行分类、提取和自动归档 |
| `POST` | `/api/archive/append` | 显式追加到已有 Bucket |
| `POST` | `/api/archive/create` | 显式创建 Bucket 并保存第一条 Entry |
| `GET` | `/api/buckets/active?limit=20` | 查看活跃 Bucket |
| `GET` | `/api/buckets/search?q=支付&limit=20` | 搜索 Bucket 和 Entry |
| `GET` | `/api/memory/query?q=接口%20A%20最近两周的压测结果&limit=20` | 自然语言查询记忆 |
| `POST` | `/api/memory/query` | 使用查询文本和显式筛选条件查询 |
| `GET` | `/api/buckets/:id` | 查看 Bucket、Entry 和 memory 详情 |
| `DELETE` | `/api/buckets/:id` | 删除 Bucket 及其 Entry/memory/tag，并记录纠错审计 |
| `POST` | `/api/buckets/status` | 设置 `active`、`paused`、`done` 或 `archived` |
| `POST` | `/api/corrections/move` | 移动 Entry 并记录纠错审计 |
| `GET` | `/health` | 健康检查 |

自动归档示例：

```bash
curl -s http://127.0.0.1:8787/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"支付回调从 10:20 开始失败，第三方返回 502。"}'
```

需要确认时，响应的 `archive_state` 为 `needs_confirmation`，客户端应完整呈现：

- `recommended_bucket_id` 和 `recommended_bucket`；
- `candidate_bucket_ids` 和 `candidate_buckets`；
- `reason` 与 `question`；
- 保存到推荐 Bucket、保存到其他 Bucket、创建新 Bucket、不保存；
- 归档完成后的目标 Bucket 和“修改 Bucket”入口。

查询示例：

```bash
curl -G http://127.0.0.1:8787/api/memory/query \
  --data-urlencode 'q=查询接口 A 最近两周的压测结果' \
  --data-urlencode 'limit=20'
```

系统会把查询拆成实体、主题、相对时间和可选状态/字段条件。结果以 Entry 为基本证据单元，因此同一问题可以跨多个 Bucket 返回，并在最终回答中标注来源。

## TypeScript 目录

| 路径 | 职责 |
|---|---|
| `src/main.ts` | TypeScript Web 生产入口、启动日志和信号关闭 |
| `src/runtime/` | `.env`/运行配置、composition root 和生命周期 |
| `src/domain/` | 领域模型、分类后处理和低信息安全门控 |
| `src/application/` | 归档、确认、查询、纠错和 Bucket 状态服务 |
| `src/storage/` | `node:sqlite` canonical schema、迁移、事务和查询 |
| `src/llm/` | endpoint、HTTP transport、结构化输出和 wire response |
| `src/http/` | Hono API、DTO、安全边界和 Node HTTP adapter |
| `src/mcp/` | Doggie MCP stdio server 和受控记忆工具 |
| `apps/doggie-local-web/frontend/` | 无 bundler 的浏览器 TypeScript UI |

Rust workspace 目前只作为冻结的迁移行为 oracle 保留，不是产品启动路径。

更多说明见：

- [`docs/TS_PROJECT_DECOMPOSITION_GUIDE.md`](docs/TS_PROJECT_DECOMPOSITION_GUIDE.md)：TypeScript 项目拆解和阅读路径
- [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md)：Claude/Codex MCP 接入
- [`docs/PLAN.md`](docs/PLAN.md)：阶段计划和当前状态
- [`docs/INVARIANTS.md`](docs/INVARIANTS.md)：可执行行为规格
- [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md)：测试与人工验收
