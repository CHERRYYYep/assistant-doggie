# Rust Work Memory

一个面向个人工作的本地长期记忆 Agent。用户可以像使用聊天助手一样输入日志、想法、会议结论、实验记录或排障事实；Rust runtime 会完成理解、查询、归档和后续纠错。

```text
对话输入
  → 分类已有/新建 Bucket
  → 低信息安全门控
  → 结构化提取
  → Rust canonical SQLite 持久化
  → 返回可解释的归档结果
```

`work-memory-server` 是唯一应用入口，提供本地 HTTP API 和内嵌 Web UI。默认监听 `127.0.0.1:8787`，数据库默认使用 `rust-work-memory.db`。

## 当前能力

- **ChatGPT 风格单会话**：保存 user、assistant 和 tool 消息，重启后恢复对话历史。
- **自动归档**：安全地追加到已有 Bucket 或创建新 Bucket，并保留 Entry 原文和结构化 memory。
- **确认式归档**：不确定时返回推荐 Bucket、备选 Bucket、模型判断理由、创建新 Bucket 和“不保存”选项。
- **低信息保护**：输入只有模糊指代或状态短句时，即使模型给出高置信度，也优先询问用户。
- **可纠错**：归档结果提供修改 Bucket 的入口，也支持通过 API 移动 Entry、修改 Bucket 状态。
- **自然语言记忆查询**：支持 Bucket 名称、Entry 原文、summary、tag、entity、时间范围、状态和结构化字段筛选。
- **查询聚合**：关键词与结构化条件组合，按结果质量重排，去重 evidence，并可合并多个 Bucket 的结果。
- **历史数据导入**：`work-memory-store-admin` 以 Rust 实现只读校验和一次性导入，将旧 schema 导入新的 canonical 数据库。

## 快速开始

需要 Rust 1.85 或更新版本，以及一个支持 Structured Outputs 的模型端点。

```bash
cp .env.example .env
# 编辑 .env，至少填写 OPENAI_API_KEY 和 OPENAI_MODEL
cargo run -p work-memory-server
```

服务启动后打开 `http://127.0.0.1:8787/`。程序会自动读取当前工作目录的 `.env`；shell 环境变量优先。

检查代码与测试：

```bash
cargo fmt --all -- --check
cargo check --workspace --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
cargo test --workspace --offline
```

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RUST_DATABASE_PATH` | `rust-work-memory.db` | canonical SQLite 文件路径 |
| `RUST_SERVER_ADDRESS` | `127.0.0.1:8787` | HTTP 监听地址 |
| `OPENAI_SITE` | 无 | `official` 或自定义站点名称 |
| `OPENAI_BASE_URL` | 无 | 兼容端点的 API 根地址；官方站点可留空 |
| `OPENAI_API_MODE` | 无 | `responses` 或 `chat_completions` |
| `OPENAI_API_KEY` | 无 | 模型端点 API Key |
| `OPENAI_MODEL` | 无 | 分类、提取和回答使用的模型名 |
| `OPENAI_TIMEOUT_SECONDS` | `30` | 单次模型请求超时 |

不要把 API Key、本地数据库或构建产物提交到 Git。

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
| `POST` | `/api/buckets/status` | 设置 `active`、`paused` 或 `archived` |
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

## Workspace

| crate | 职责 |
|---|---|
| `work-memory-core` | 领域模型、分类结果、低信息和置信度门控 |
| `work-memory-contracts` | 严格 JSON 契约和模型输出校验 |
| `work-memory-agent` | 模型适配、HTTP transport 和工具 Harness |
| `work-memory-store` | canonical SQLite、事务、查询和历史导入 |
| `work-memory-service` | 归档、查询、纠错、状态和对话服务 |
| `work-memory-runtime` | 组合模型与服务，生成产品投影 |
| `work-memory-server` | HTTP 路由、内嵌 UI 和进程入口 |

更多说明见：

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/AGENT_HARNESS.md`](docs/AGENT_HARNESS.md)
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)
- [`docs/MVP_SPEC.md`](docs/MVP_SPEC.md)
- [`docs/SQLITE_MIGRATIONS.md`](docs/SQLITE_MIGRATIONS.md)
- [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md)
- [`docs/PROMPTS.md`](docs/PROMPTS.md)
