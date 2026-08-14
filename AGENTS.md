# AGENTS.md instructions for /home/cherry/assistant-doggie

## 仓库指南

本仓库是一个 Rust 个人工作记忆 Agent。所有产品运行、测试和开发路径都位于 Cargo workspace：

- `crates/doggie-domain/`：领域值、Bucket/Entry 模型、分类安全门控和确定性文本规则。
- `crates/doggie-application/`：归档、自然语言记忆查询、纠错、状态和对话持久化服务。
- `crates/doggie-protocol/`：模型结构化输出契约、JSON Schema、HTTP/工具 DTO 和边界校验。
- `crates/doggie-storage-sqlite/`：Doggie canonical SQLite schema、事务、查询、归档写入和只读历史库导入工具。
- `crates/doggie-llm/`：模型端点配置、Responses/Chat Completions 适配、HTTP transport 和 response 归一化。
- `crates/doggie-agent-runtime/`：受控工具 Harness、工具轮次/参数/输出限制和对话上下文组装。
- `crates/doggie-engine/`：稳定 facade，组装模型、应用服务和安全门控。
- `apps/doggie-local-web/`：当前唯一入口；本地 HTTP API、ChatGPT 风格内嵌 Web UI 和进程入口。
- `docs/`：当前架构、数据模型、API 行为、迁移边界和测试方案。

旧版运行时、旧测试和旧界面不属于本分支。历史数据库兼容能力只允许以 Rust 实现保留，不得重新引入其他语言的生产路径或测试依赖。

## 构建、测试与本地开发

需要 Rust 1.85 或更新版本：

```bash
cp .env.example .env
# 编辑 .env，填写模型端点和 OPENAI_API_KEY
cargo run -p doggie-local-web
```

常用检查命令：

```bash
cargo fmt --all -- --check
cargo check --workspace --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
cargo test --workspace --offline
```

如需在线解析新依赖，可去掉 `--offline`。本地数据库、`.env`、`target/` 和日志均不应提交。

## 编码风格与命名规范

遵循 rustfmt、Clippy 和 Rust 2024 edition 约定。公共 API 使用明确的类型和错误类型，模块、函数和变量使用 `snake_case`，类型和 trait 使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。服务层保持职责单一，不把业务逻辑塞进 HTTP/UI 字符串模板。跨层变化应优先更新领域契约和服务接口，再更新 route projection。

对用户可见的归档流程必须保留：

- `ask_user` 安全门控；
- 推荐 Bucket、备选 Bucket、判断理由、创建新 Bucket 和不保存选项；
- 归档后的 Bucket 修改入口；
- Entry 原文、结构化 memory、审计记录和可重放的确认绑定。

低信息输入宁愿多询问一次，也不能静默写入不确定的 Bucket。

## 测试要求

使用 Cargo workspace 测试。普通测试必须使用 fake model/transport 和临时 SQLite 文件，不调用真实模型或真实用户数据库。重点覆盖：

- core 的分类、低信息门控和查询计划解析；
- contracts 的严格字段和边界校验；
- store/service 的事务回滚、重开数据库、搜索、筛选、结果聚合和纠错；
- runtime/server 的自动归档、确认分支、聊天历史和 HTTP 错误映射。

修改 archive、confirmation、query 或 schema 后，按照 `docs/TEST_PLAN.md` 做对应回归。不要通过删除失败测试来绕过行为回归；如果删除过时测试，需在变更说明中写明它原来依赖的旧运行时已经从本分支移除。

## Agent 协作与执行规范

- **有求有应**：先确认任务目标和约束；存在关键歧义时说明假设，不擅自扩大范围。
- **有据可查**：修改前先阅读相关代码和文档，结论基于仓库现状，不虚构命令、接口或测试结果。
- **有行有果**：实施修改后运行与改动直接相关的检查；不能运行时明确说明原因和影响。
- **有错必报**：遇到失败、风险或兼容性问题如实报告，不隐藏错误，不以绕过测试代替修复。
- **有始有终**：最终说明修改了哪些文件、实现了什么、执行了哪些验证，以及仍存在的风险或后续事项。
- **最小改动**：只修改完成任务所需内容，保留用户已有改动，不提交密钥、本地数据库或构建产物。
- **阶段提交**：完成一个小的阶段性任务后主动创建 Git 提交；提交信息使用简短、祈使句式，例如 `Remove legacy runtime`。

## Multi-agent workflow

For large read-heavy tasks, use subagents in parallel.

- Use an explorer for codebase mapping.
- Use a reviewer for correctness and security checks.
- Use a test analyst for test coverage and failure analysis.
- Keep concurrent code edits to a minimum.
- Prefer one worker to modify files after the investigation is complete.
- The main thread must reconcile conflicting findings before implementation.
