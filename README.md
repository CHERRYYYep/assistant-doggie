# Personal Work Memory Agent

一个面向个人工作的长期事务记忆 Agent。用户把日志、想法、会议结论、实验记录和排障证据输入系统后，Agent 会判断应追加到已有 `Bucket`、创建新 `Bucket`，还是先请求用户确认，并把原文与结构化结果保存为可追溯记忆。

> 当前仓库已完成本地单用户 Agent MVP：单一持久化对话、问题回答、受控工具 Harness、Bucket 分类与记忆、事务归档、纠错和 SQLite 搜索均已实现。

## 核心理念

- 一个长期对话，不要求用户在聊天与记忆工具之间手工切换上下文。
- 普通问题直接分析和回答；每轮默认加载活跃 Bucket 概览，并主动保存值得长期跟踪的工作事实。
- Bucket 表示持续存在的事务上下文，不是无限增长的聊天记录。
- 仅高置信度且候选唯一时自动归档；空工作区中有效的新建判断可直接创建首个 Bucket。
- 保存原始 Entry，并提取摘要、Todo、Evidence、Timeline 和 Decision。
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

Harness 的工具、上下文和安全边界见 [`docs/AGENT_HARNESS.md`](./docs/AGENT_HARNESS.md)。Rust 重构的边界、阶段、数据安全规则和当前完成度见 [`docs/RUST_MIGRATION.md`](./docs/RUST_MIGRATION.md)；离线 SQLite migration、备份与恢复操作见 [`docs/SQLITE_MIGRATIONS.md`](./docs/SQLITE_MIGRATIONS.md)。

## 技术栈与目录

- 当前生产运行时：Python、SQLite、SQLAlchemy、Pydantic、OpenAI API、Streamlit、Pytest。
- 渐进重构目标：Rust；领域核心位于 `rust/work-memory-core/`，严格 JSON 适配层位于 `rust/work-memory-contracts/`，SQLite 九表强类型只读仓储、离线 migration 安全层和隔离写 API 位于 `rust/work-memory-store/`，Bucket 查询/搜索、归档、纠错、基础变更、摘要缓存、独立提取保存、分类审计保存和聊天消息持久化编排位于 `rust/work-memory-service/`。R3c-R3i 已建立归档、纠错、基础变更、摘要、提取、分类审计和单条聊天消息的稳定服务边界。R4a 已创建 `rust/work-memory-agent/`，实现不依赖具体网络库的 Responses/兼容 Chat Completions Structured Outputs 请求、响应归一化和有限重试，并通过 fake transport 离线测试。所有 Rust 写服务仍只在隔离数据库验证；R4a 尚无真实 HTTP transport、API Key、timeout/proxy、Agent Harness、UI 或生产接线，生产写入继续由 Python 独占。
- `app/`：当前 Python 模型、Schema、Prompt、LLM 封装和业务服务。
- `ui/streamlit_app.py`：本地交互界面。
- `tests/`：单元、集成、UI 测试与固定评估样例。
- `docs/`：产品、架构、数据模型、测试和开发说明。

## 快速开始

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

Rust SQLite 离线检查、基线 migration 与恢复：

```bash
cargo run -p work-memory-store --bin work-memory-store-admin -- inspect DATABASE
cargo run -p work-memory-store --bin work-memory-store-admin -- migrate DATABASE BACKUP
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  restore DATABASE BACKUP SAFETY_BACKUP
```

执行 `migrate` 或 `restore` 前必须停止 Python 应用、Streamlit 和其他数据库连接；输出备份路径必须尚不存在。当前命令只登记 Schema version 或执行显式恢复，不代表 Rust 已接管业务写入。完整操作顺序和失败恢复边界见 [`docs/SQLITE_MIGRATIONS.md`](./docs/SQLITE_MIGRATIONS.md)。

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

MVP 暂不包含多用户、云同步、附件、向量检索和复杂 Agent 编排。`hypotheses` 与 `entities` 已能由 LLM 输出，但尚未持久化；滚动摘要是可重建缓存，原始 Entry 始终是事实来源。
