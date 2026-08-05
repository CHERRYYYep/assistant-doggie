# 架构决策记录

## ADR-001：MVP 使用 SQLite

状态：接受

原因：

- 新手友好。
- 本地运行简单。
- 不需要部署数据库。
- 足够验证单用户 MVP。

后续条件：

- 多用户。
- 大量数据。
- 需要云同步。

满足以上条件再迁移 PostgreSQL。

## ADR-002：MVP 使用 Streamlit

状态：接受

原因：

- 快速做出输入框和详情页。
- 不需要前端工程复杂度。
- 适合产品验证。

后续条件：

- 需要正式 Web App。
- 需要更复杂交互。
- 需要移动端适配。

满足以上条件再考虑 React/Next.js。

## ADR-003：第一版不引入多 Agent 框架

状态：接受

原因：

- MVP 流程可以用普通函数完成。
- 多 Agent 增加调试难度。
- 产品逻辑还没稳定。

后续条件：

- 出现多个专业 agent。
- 需要复杂状态机。
- 需要人工审批。
- 需要长期运行任务。

## ADR-004：分类和提取使用 Structured Outputs

状态：接受

原因：

- 业务代码需要稳定 JSON。
- 可以减少解析失败和字段缺失。
- Pydantic schema 适合 Python 项目。

## ADR-005：原始输入不可丢失

状态：接受

原因：

- LLM 总结和提取可能出错。
- 用户事后需要查原文。
- 纠错和重算依赖原始输入。

## ADR-006：使用绞杀者模式渐进迁移到 Rust

状态：接受（2026-08-04）

决定：

- 最终由 Rust 承担领域逻辑、持久化、Agent 编排、API 和 UI。
- 先迁移无 I/O 的确定性规则，再迁移 JSON 契约、SQLite、业务事务、LLM Harness 和 UI。
- Python 与 Rust 在迁移期共享行为契约和固定测试样例，但不同时写同一份生产数据库。
- 每个边界只有在隔离环境中完成行为和数据兼容验证后才切换所有权。

原因：

- 当前 Python MVP 已有 69 个自动化测试和可工作的数据闭环，一次性重写会失去可靠的行为参照。
- 分类门控等纯规则最适合先迁移，可以尽早建立 Rust 工程、类型和测试规范。
- SQLite 写事务、LLM 接口与 UI 耦合更高，需要在契约稳定后逐步替换。

后果：

- 一段时间内仓库会同时包含 Python 和 Rust。
- 必须维护跨实现一致性测试，并明确每项能力的当前所有者。
- 迁移计划、阶段状态和最终删除条件记录在 `RUST_MIGRATION.md`。

## ADR-007：R4b HTTP transport 复用 `ureq`

状态：接受（2026-08-05）

决定：

- R4b 使用社区 crate `ureq` `3.3.0`，不自写 HTTP、TLS、连接池或代理协议实现。
- `work-memory-agent` 继续保持同步 `StructuredOutputTransport` trait，因此使用 `ureq::Agent`，不为一个同步边界引入 Tokio 或异步 runtime。
- 启用 `json` 与 `socks-proxy` feature；默认使用 `ureq` 的 rustls TLS 和 gzip 能力。
- `Agent::config_builder()` 继承 `Config::default()` 的代理环境解析：按 `ALL_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY` 及小写 alias 查找，并由 `NO_PROXY` 决定 loopback/主机绕过；`socks://` 由 crate 作为 SOCKS5 处理，不在进程环境中改写字符串。
- API Key 只存在于 transport 私有字段；`Debug` 主动脱敏，HTTP 错误映射为固定消息，不把请求 URL、响应 body 或 Authorization 值写进错误。
- 真实 HTTP transport 仍是独立边界，不读取生产数据库、不接入 Agent/UI，也不让 Python/Rust 并发写生产 SQLite。

候选比较：

- `reqwest` 的 blocking API 同样成熟，但会额外引入 blocking runtime 相关的配置和依赖；当前 trait 已经是同步调用，`ureq` 的 `Agent`/`ConfigBuilder`/proxy/timeout API 更贴合最小迁移边界。
- 自写 `TcpStream`、TLS、HTTP 状态/重定向和 proxy 逻辑被明确排除，因为这些能力已有成熟社区实现且安全风险高。

验收：

- 本地 mock HTTP server 验证 POST、Bearer header、JSON body、200、401、429、500、非法 JSON 和 timeout。
- 单元测试验证 Python 既有 `socks://` 规范化语义对应 `ureq::ProxyProtocol::Socks5`。
- 普通测试只使用 loopback mock server 或 fake transport；不读取真实 API Key，不调用真实模型。

选型来源：

- [`ureq 3.3.0 API documentation`](https://docs.rs/ureq/3.3.0/ureq/)
- [`ureq 3.3.0 source and feature list`](https://github.com/algesten/ureq/tree/3.3.0)
- [`reqwest blocking client documentation`](https://docs.rs/reqwest/latest/reqwest/blocking/)

## ADR-008：标准 UUID 与 URL 语法复用社区 crate

状态：接受（2026-08-05）

决定：

- `work-memory-store` 使用社区 `uuid` crate 的 `Uuid::new_v4()` 生成新记录 ID，不再通过 SQLite `randomblob(16)` 手动设置版本位、变体位和字符串格式。
- `work-memory-agent` 使用社区 `url` crate 的 `Url::parse`、host、port、credentials、query 和 fragment 解析能力，不再手写 URL authority 与 IPv6/端口语法解析。
- 项目仍保留自己的业务策略：official/custom site 选择、远程 custom URL 必须 HTTPS、loopback 才允许 HTTP、禁止 credentials/query/fragment，以及保留原有 Base URL 尾斜杠规范化。
- `uuid` 和 `url` 只替代标准格式/语法解析，不改变 SQLite 事务、跨语言 fixture 或 endpoint 安全策略。

原因：

- UUID v4 和 URL 语法属于已有稳定标准，手工实现会重复承担边界条件和安全风险。
- 业务层仍需要 Python 兼容和安全门控，因此只替换底层标准能力，不引入 ORM 或更重的 Agent 框架。

验收：

- Rust 写路径继续通过 UUID v4 格式测试和 Python/Rust 最终语义 fixture 对比。
- endpoint fixture 继续逐值验证 official/custom、IPv6、credentials、query、fragment 和不安全远程 HTTP 行为。
- `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、Rust workspace tests 和 Python 回归测试通过。


## ADR-009：R4c 继续使用受控应用内 Agent Harness

状态：接受（2026-08-05）

决定：

- Rust R4c 不引入通用 Agent framework；继续使用应用内的 allow-list、严格参数契约、有限工具轮数和显式执行器边界。
- Responses/Chat Completions 的 wire 类型复用 `async-openai`，HTTP/TLS/proxy 复用 `ureq`，JSON/契约复用 `serde`/`serde_json`；Harness 只保留产品特有的工具 continuation、记忆上下文分层、风险错误和事务接线策略。
- `schemars` 不直接替换当前手工维护的 strict schema，因为 Rust 生成的 `$ref`、nullable、required/default 和描述字段未被证明与 Python/Pydantic/OpenAI canonical schema 逐值一致。
- `thiserror`、`clap`、`wiremock`/`httpmock` 作为后续样板和测试整理候选，当前不阻塞 R4c，也不以增加依赖为目标进行重写。

原因：

- 工具 allow-list、工具错误作为数据、记忆上下文不具备 system 权限、确认/风险门控和未来完整 turn 事务都是本产品安全策略，不是通用 crate 可以安全替代的底层能力。
- 当前 Rust workspace 已使用社区 crate 覆盖 HTTP、TLS、代理、URL、UUID、SQLite、JSON、时间、Unicode casefold 和 OpenAI wire；没有发现第二套生产 HTTP/SQLite/URL/UUID 基础设施。
- 手工 schema、migration safety 和 Agent loop 代码分别承担跨语言兼容、Python legacy schema adoption/备份恢复、以及产品安全边界，不属于无理由重复实现。

生产前审查项：

- redirect 必须限制 host/scheme，不能让 prompt 或 memory context 被跳转到未授权目标。
- Harness 需要补齐 tool call/上下文/输出资源上限、重复 call ID 和写操作幂等保护。
- Responses/Chat 的 status、choice、role、function-call 完成态和 retry 分类需要更严格的协议测试。
- 工具 schema 与 `AgentToolArguments` 应收敛为单一 metadata 来源，避免内部 drift。
