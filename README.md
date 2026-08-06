# Rust Work Memory MVP

一个面向个人工作的本地长期事务记忆 Agent。用户输入日志、想法、会议结论、实验记录或排障事实后，Rust runtime 会完成：

```text
输入文本 → 分类已有/新建 Bucket → 结构化提取 → SQLite 持久化 → 返回归档结果 → 查看 Bucket
```

`work-memory-server` 是唯一的应用入口，提供本地 HTTP API 和内嵌 Web UI。默认只监听 `127.0.0.1`，数据库默认写入 `rust-work-memory.db`。

## MVP 行为

- `append_existing`：把内容追加到一个明确匹配的活跃 Bucket。
- `create_new`：为新事务创建 Bucket，并保存第一条 Entry。
- `ask_user`：分类不够安全时只保存归档尝试，不创建正式 Entry。
- 自动归档要求候选唯一且 `confidence >= 0.85`。
- `0.55 <= confidence < 0.85` 或存在多个候选时请求确认；低于 `0.55` 也不会自动写入。
- 空工作区中的新 Bucket 仍需通过相同的置信度门控；高置信度才会直接创建。
- 每条正式 Entry 保存原文，并可保存 `summary`、`todo`、`evidence`、`timeline`、`decision`、`hypothesis`、`entity` 和 `tag` memory item。
- 归档尝试、分类原因、候选 Bucket、模型名和 Prompt 版本写入审计记录。
- 支持显式确认追加、显式确认新建、移动 Entry 和更新 Bucket 状态。

## 快速开始

需要 Rust 1.85 或更新版本，以及一个支持 Structured Outputs 的模型端点。

```bash
cp .env.example .env
# 编辑 .env，至少填写 OPENAI_API_KEY 和 OPENAI_MODEL
set -a; source .env; set +a
cargo run -p work-memory-server
```

服务启动后打开 `http://127.0.0.1:8787/`。`.env` 不会被程序自动加载；也可以直接在 shell 中导出变量。

检查代码与测试：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RUST_DATABASE_PATH` | `rust-work-memory.db` | Rust SQLite 文件路径 |
| `RUST_SERVER_ADDRESS` | `127.0.0.1:8787` | HTTP 监听地址 |
| `OPENAI_SITE` | 无 | `official` 或自定义站点名称 |
| `OPENAI_BASE_URL` | 无 | 兼容端点的 API 根地址；官方站点可留空 |
| `OPENAI_API_MODE` | 无 | `responses` 或 `chat_completions` |
| `OPENAI_API_KEY` | 无 | 模型端点 API Key |
| `OPENAI_MODEL` | 无 | 分类和提取使用的模型名 |
| `OPENAI_TIMEOUT_SECONDS` | `30` | 单次模型请求超时 |

实际可用的站点、模型和接口模式由 `work-memory-agent` 的端点配置决定。不要把 API Key 或本地数据库提交到 Git。

## HTTP API

所有成功响应都是 JSON。请求体中的文本字段不能为空。

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/archive` | 分类、提取并自动归档；可选 `focus_bucket_id` |
| `POST` | `/api/archive/append` | 显式确认后追加到已有 Bucket |
| `POST` | `/api/archive/create` | 显式确认后创建 Bucket 并保存第一条 Entry |
| `GET` | `/api/buckets/active?limit=20` | 查看活跃 Bucket |
| `GET` | `/api/buckets/search?q=支付&limit=20` | 搜索 Bucket 和 Entry |
| `GET` | `/api/buckets/:id` | 查看 Bucket、Entry 和 memory 详情 |
| `POST` | `/api/buckets/status` | 设置 `active`、`paused` 或 `archived` 状态 |
| `POST` | `/api/corrections/move` | 将 Entry 移动到目标 Bucket 并记录纠错审计 |
| `GET` | `/health` | 健康检查 |

自动归档：

```bash
curl -s http://127.0.0.1:8787/api/archive \
  -H 'content-type: application/json' \
  -d '{"text":"支付回调从 10:20 开始失败，第三方返回 502。"}'
```

需要确认时，响应 `archive_state` 为 `needs_confirmation`，并返回 `question`、`candidate_bucket_ids`；如果分类动作是新建，还会返回 `bucket_title` 和 `bucket_type`。确认追加示例：

```bash
curl -s http://127.0.0.1:8787/api/archive/append \
  -H 'content-type: application/json' \
  -d '{"bucket_id":"BUCKET_ID","text":"备用通道已恢复。","confirmation_granted":true}'
```

确认新建示例：

```bash
curl -s http://127.0.0.1:8787/api/archive/create \
  -H 'content-type: application/json' \
  -d '{"title":"支付回调故障","bucket_type":"incident","text":"第三方返回 502。","confirmation_granted":true}'
```

`confirmation_granted` 必须是 JSON 布尔值 `true`。它只表示本次请求的用户确认，不是网络认证；服务应只在受信任的本机或已配置认证的反向代理后使用。

## 项目结构

- `rust/work-memory-core/`：Bucket、分类、置信度门控和提取领域规则。
- `rust/work-memory-contracts/`：模型 Structured Outputs 的 JSON Schema 和解析契约。
- `rust/work-memory-store/`：Rust-owned SQLite schema、事务和读写投影。
- `rust/work-memory-service/`：canonical service facade，统一 Bucket 查询、归档、纠错和状态变更。
- `rust/work-memory-runtime/`：模型调用、分类门控、提取和归档闭环。
- `rust/work-memory-server/`：HTTP 路由、错误映射和内嵌 Web UI。
- `rust/*/tests/`：Rust 单元与集成测试。
- `docs/`：MVP 规格、架构和验证说明。

## 设计边界

这是一个单进程、单用户、本地 MVP：默认无认证、无多租户、无云同步、无附件和无向量检索。HTTP server 使用简单的单连接处理模型，不能直接暴露到公网。原始 Entry 是事实来源，结构化 memory 是可追溯的派生数据；当分类不确定时，系统宁可等待确认，也不自动制造错误归档。

更多细节见：

- [`docs/MVP_SPEC.md`](docs/MVP_SPEC.md)：用户流程、门控规则和 API 验收标准。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：组件、数据流、事务和安全边界。
- [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md)：测试策略与回归场景。
