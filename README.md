# Personal Work Memory Agent

一个面向个人工作的长期事务记忆 Agent。用户把日志、想法、会议结论、实验记录和排障证据输入系统后，Agent 会判断应追加到已有 `Bucket`、创建新 `Bucket`，还是先请求用户确认，并把原文与结构化结果保存为可追溯记忆。

> 当前仓库同时保留 Python legacy 应用用于兼容回归和一次性语义导入；新的 canonical 运行入口是 Rust runtime/server，长期生产写入只应进入 Rust canonical SQLite。

## 核心理念

- 一个长期对话，不要求用户在聊天与记忆工具之间手工切换上下文。
- 普通问题直接分析和回答；每轮默认加载活跃 Bucket 概览，并主动保存值得长期跟踪的工作事实。
- Bucket 表示持续存在的事务上下文，不是无限增长的聊天记录。
- 仅高置信度且候选唯一时自动归档；空工作区中有效的新建判断可直接创建首个 Bucket。
- 保存原始 Entry，并提取摘要、Todo、Evidence、Timeline、Decision、Hypothesis、Entity 和 Tag；旧 Python 数据库导入时只能恢复其中已经落盘的四类 legacy 结构化表。
- 所有派生信息可追溯到原文，误归档可移动并保留纠错记录。
- `confidence` 是待校准的风险信号，不等于真实正确概率。

## MVP 能力

1. 在唯一的长期对话中持久化用户消息、助手回答和工具执行记录。
2. 使用 OpenAI Responses API 或兼容的 Chat Completions 生成问题解决方案。
3. 通过受控 Agent Harness 列出、搜索、读取和写入 Bucket 记忆。
4. 从当前焦点和活跃 Bucket 中构造有限候选，并使用 Structured Outputs 分类和提取。
5. 校验模型返回的 Bucket ID，并应用可配置置信度门控。
6. 在同一事务中保存 Bucket、Entry、结构化记录和分类审计。
7. 支持确认追加、确认新建和移动最近 Entry；首次无 Bucket 时始终提供可编辑的新建入口。
8. Streamlit 主区域专注长期对话，Bucket 记忆放在可展开的独立侧边栏，不再提供重复的手工归档页签。

Rust canonical runtime 已把同一套对话、工具、分类、提取、归档和聊天持久化接到 Rust-owned SQLite；`work-memory-server` 提供默认只绑定 loopback 的本地 HTTP API 与内嵌 Web UI。Agent Harness 会限制工具轮数、工具调用数、参数/输出/历史大小，并要求显式确认后才执行确认追加或确认新建。

Harness 的工具、上下文和安全边界见 [`docs/AGENT_HARNESS.md`](./docs/AGENT_HARNESS.md)。Rust 重构的边界、阶段、数据安全规则和当前完成度见 [`docs/RUST_MIGRATION.md`](./docs/RUST_MIGRATION.md)；离线 SQLite migration、备份与恢复操作见 [`docs/SQLITE_MIGRATIONS.md`](./docs/SQLITE_MIGRATIONS.md)。

## 技术栈与目录

- Python、SQLAlchemy、Pydantic 和 Streamlit 仍保留在仓库中，用于 legacy 兼容回归、离线导入和旧 UI 维护；它们不是 Rust canonical DB 的长期生产写路径。新部署应使用 `work-memory-server` 作为 Rust canonical runtime/server 入口。
- Rust 目标运行时的领域核心位于 `rust/work-memory-core/`，严格 JSON 适配层位于 `rust/work-memory-contracts/`。`rust/work-memory-store/` 同时包含旧 Python 九表的只读/兼容管理边界，以及新的 Rust canonical SQLite、一次性 `import-legacy` 语义导入和受控写 API；`rust/work-memory-service/` 是 canonical service facade，`rust/work-memory-runtime/` 组合模型、Harness 和完整 turn，`rust/work-memory-server/` 提供 HTTP/API/UI 入口。legacy Rust service/store API 仅用于迁移和兼容回归，不属于 canonical 长期生产写路径。
- `app/`：当前 Python 模型、Schema、Prompt、LLM 封装和业务服务。
- `ui/streamlit_app.py`：本地交互界面。
- `tests/`：单元、集成、UI 测试与固定评估样例。
- `docs/`：产品、架构、数据模型、测试和开发说明。

## 快速开始（Python legacy 应用）

以下命令启动仓库中保留的 Python/Streamlit legacy 应用，用于兼容回归和旧 UI；新部署或已完成 canonical cutover 的部署应使用下方 `work-memory-server` 入口。

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 在 .env 中选择 API 站点，并填写该站点的 Key 与模型
python -m app.main
streamlit run ui/streamlit_app.py
```

API 站点通过 `.env` 选择。官方 OpenAI 使用：

```text
OPENAI_SITE=official
OPENAI_API_MODE=responses
OPENAI_API_KEY=你的官方Key
OPENAI_MODEL=该站点可用的模型
```

OpenAI 兼容中转站使用：

```text
OPENAI_SITE=my-relay
OPENAI_BASE_URL=https://relay.example.com/v1
OPENAI_API_MODE=responses
OPENAI_API_KEY=中转站签发的Key
OPENAI_MODEL=中转站支持的模型名
```

如果中转站没有实现 `/responses`，将 `OPENAI_API_MODE` 改为 `chat_completions`。`OPENAI_BASE_URL` 应填写 API 根路径（通常以 `/v1` 结尾），不要填写具体的 `/responses` 或 `/chat/completions` 路径。修改配置后重启应用。

### Rust canonical server

已有 Python 数据时，先按上面的 `import-legacy` 流程创建并核验 Rust canonical DB，再启动 Rust 入口；全新部署可直接初始化一个空的 Rust canonical DB。现有 Python 部署只有在完成备份、冻结、导入、counts/内容核验和健康检查后，才能切换生产写入所有权。

```bash
export RUST_CANONICAL_DB=/path/to/rust-work-memory.db
export RUST_SERVER_ADDRESS=127.0.0.1:8787
cargo run -p work-memory-server
```

`RUST_CANONICAL_DB` 默认是 `rust-work-memory.db`，`RUST_SERVER_ADDRESS` 默认是 `127.0.0.1:8787`。`work-memory-server` 只读取进程环境变量，不会自动加载 `.env`；需要时先 `set -a; source .env; set +a`，再启动 Rust 进程。Python 的 `DATABASE_URL` 以及 Python 专用的置信度环境变量不会配置 Rust canonical DB；`RUST_CANONICAL_DB` 不得指向 legacy Python 数据库。Rust server 还使用以下 LLM 配置：

| 变量 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | LLM transport 使用的密钥；必填，不会写入日志或错误文本 |
| `OPENAI_MODEL` | Agent 与 Structured Outputs 使用的模型名；必填 |
| `OPENAI_SITE` | `official` 或自定义站点名；默认 `official` |
| `OPENAI_BASE_URL` | 自定义站点的 API 根 URL；自定义站点必填，通常以 `/v1` 结尾 |
| `OPENAI_API_MODE` | `responses` 或 `chat_completions`；默认 `responses` |
| `OPENAI_TIMEOUT_SECONDS` | 同步 LLM HTTP timeout 秒数；默认 30 |

启动后可访问 `GET /health`、`GET /api/buckets/active`、`GET /api/buckets/search?q=...`、`GET /api/buckets/:id`、`POST /api/chat`、`POST /api/corrections/move` 和 `POST /api/buckets/status`；`/` 返回内嵌 Web UI，UI 的确认复选框和 API 的 `confirmation_granted` 都按单轮生效且默认 false，只有显式确认才允许 Agent 执行确认追加或确认新建；低置信度/歧义归档只记录 `archive_attempt`，不创建 Entry。若 Agent 或 LLM 在工具执行后失败，server 返回错误且不会伪造成功的 assistant 消息；已经发生的 canonical 工具副作用和当前 user message 仍可能已提交，需通过审计和数据库检查确认，调用方不能盲目重试失败请求。

这是单用户 MVP server：默认只监听 loopback，使用标准库单请求/单连接 HTTP 实现，无认证、授权、用户/租户隔离、TLS、CSRF/origin 保护、限流、并发写入协调或请求幂等。`confirmation_granted` 只是请求字段而非安全控制；任何能访问监听地址的调用方都可以读取记忆、移动 Entry、修改 Bucket 状态并请求确认写入，不应直接暴露到公网。部署到受信任的本机或前置认证反向代理前，应补齐认证、TLS、限流、请求幂等和可观测性。

运行 Python 自动化测试、Rust workspace 测试和透明规则分类基线：

```bash
pytest -q
cargo test --workspace --locked
python -m app.evaluation --baseline
```

Rust 格式与静态检查：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Rust SQLite 检查、一次性语义导入与 legacy 恢复：

```bash
# 旧 Python 数据库：检查、登记兼容基线或恢复
cargo run -p work-memory-store --bin work-memory-store-admin -- inspect PYTHON_DB
cargo run -p work-memory-store --bin work-memory-store-admin -- migrate PYTHON_DB LEGACY_BACKUP
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  restore PYTHON_DB LEGACY_BACKUP LEGACY_SAFETY_BACKUP

# 新 Rust canonical 数据库：必须使用全新/空目标
cargo run -p work-memory-store --bin work-memory-store-admin -- init RUST_DB
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  import-legacy PYTHON_DB RUST_DB
cargo run -p work-memory-store --bin work-memory-store-admin -- inspect-rust RUST_DB
```

`migrate`/`restore` 只服务于旧 Python 九表的兼容检查、版本登记和恢复，不是 canonical 数据迁移；真正的切换操作是 `import-legacy`。导入前必须停止 Python 应用、Streamlit 和其他数据库连接，备份旧数据库并确认 source/target 路径不同。导入器只读 source，target 必须是新建或空的 canonical schema；失败时可以留下空的 DDL shell，但不会留下部分 canonical 业务 rows，不能向已有业务 rows 的 target 追加第二次导入。验证 counts、原文、结构化记忆、审计和聊天后，才能把 Rust server 指向 Rust DB。切换后 Rust canonical DB 是唯一生产写入目标，旧 Python DB 作为冻结历史源/备份保留；legacy Python schema service 以及 legacy Rust service/store API 只用于迁移和兼容回归。完整操作顺序和失败恢复边界见 [`docs/SQLITE_MIGRATIONS.md`](./docs/SQLITE_MIGRATIONS.md)。

少量真实模型分类与提取评估会产生 API 调用：

```bash
python -m app.live_evaluation \
  --limit 3 \
  --output /tmp/classification-live-report.json
python -m app.live_extraction_evaluation \
  --limit 3 \
  --reference-date 2026-08-03 \
  --output /tmp/extraction-live-report.json
```

报告会保留 API 站点、Base URL、接口模式、模型名、Prompt 版本、生成时间、完整结构化输出和指标。分类报告可重新交给 `app.evaluation` 计算指标；提取报告可交给 `app.extraction_evaluation` 检查必需事实遗漏、禁用事实和原文中不存在的数字。自动检查只是人工语义审查的辅助，不能独立证明提取没有幻觉。

## 文档阅读顺序

1. [`docs/AGENT_HARNESS.md`](./docs/AGENT_HARNESS.md)：单会话、上下文、工具循环与安全边界。
2. [`docs/PRODUCT_DOCUMENT_AND_COMPLETION_PLAN.md`](./docs/PRODUCT_DOCUMENT_AND_COMPLETION_PLAN.md)：综合产品文档与后续完成规划。
3. [`docs/PRD.md`](./docs/PRD.md)：产品目标与边界。
4. [`docs/MVP_SPEC.md`](./docs/MVP_SPEC.md)：MVP 功能定义。
5. [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md)：数据如何持久化。
6. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)：当前服务和数据流。
7. [`docs/RUST_MIGRATION.md`](./docs/RUST_MIGRATION.md)：Rust 渐进重构阶段、边界与验收门槛。
8. [`docs/SQLITE_MIGRATIONS.md`](./docs/SQLITE_MIGRATIONS.md)：离线 Schema 检查、升级备份和恢复流程。
9. [`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md)：逐日开发步骤。
10. [`docs/DAYS_4_TO_10_IMPLEMENTATION.md`](./docs/DAYS_4_TO_10_IMPLEMENTATION.md)：本阶段实现、原因和限制。
11. [`docs/LONG_TERM_BUCKET_MEMORY.md`](./docs/LONG_TERM_BUCKET_MEMORY.md)：长期 Bucket 记忆设计。
12. [`docs/TEST_PLAN.md`](./docs/TEST_PLAN.md)：验收策略。
13. [`docs/ROADMAP.md`](./docs/ROADMAP.md)：后续路线。

## 当前边界

MVP 暂不包含多用户、云同步、附件、向量检索和复杂 Agent 编排。Rust canonical store 可持久化 `todo`、`evidence`、`timeline`、`decision`、`hypothesis`、`entity` 和 `tag` 七类 memory item；旧 Python 数据库只有前四类 legacy 表，因此一次性导入无法恢复历史上从未落盘的 hypothesis/entity。滚动摘要是可重建缓存，原始 Entry 始终是事实来源。Rust server 目前仍是单用户、loopback 默认、无认证的本地入口。
