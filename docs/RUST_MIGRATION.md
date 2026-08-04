# Rust 渐进重构计划

> 状态日期：2026-08-04
> 当前阶段：R0 已完成——建立 Rust workspace，并迁移分类领域契约与确定性风险门控。生产运行路径仍是 Python。

## 1. 目标

最终让 Rust 负责领域模型、SQLite 持久化、分类与提取编排、归档事务、搜索、纠错、Agent Harness、HTTP API 和 Web UI，并在行为与数据兼容得到验证后删除 Python 运行时。

这不是一次性重写。迁移期间采用“绞杀者”方式，每次只切换一个可验证边界：

1. 先迁移无 I/O 的确定性规则。
2. 再建立 JSON 与 SQLite 兼容层。
3. 随后逐个迁移读服务和写事务。
4. 最后替换 Agent、API 和 UI，并移除 Python。

## 2. 不变量

重构过程中必须持续满足以下产品约束：

- 原始 Entry 不丢失，所有派生记录可以追溯到原文。
- 低置信度、多个相似候选或无效 Bucket ID 不得自动污染长期记忆。
- Bucket、Entry、结构化记录和分类审计的写入保持单事务语义。
- 纠错移动 Entry 时同步移动派生记录，并保留前后快照。
- 普通自动化测试不调用真实 LLM。
- 现有 `work_memory.db` 在明确迁移和备份前不得由不兼容 Schema 覆盖。

## 3. 迁移架构

当前生产路径：

```text
Streamlit UI -> Python Agent/Services -> SQLAlchemy -> SQLite
                           |
                           +-> OpenAI / compatible API
```

过渡期目标：

```text
Streamlit UI (临时)
        |
        +-> Python 适配层 (逐步收缩)
                    |
                    +-> Rust HTTP/API + Rust domain/services -> SQLite
                                      |
                                      +-> OpenAI / compatible API
```

最终路径：

```text
Rust-served Web UI -> Rust API/Agent/Services -> SQLite
                               |
                               +-> OpenAI / compatible API
```

迁移期间禁止让 Python 和 Rust 同时写同一份生产数据库。写路径切换前，应在隔离数据库上完成契约、事务和回归对比；切换时只保留一个写入所有者。

## 4. 阶段与验收门槛

### R0：Rust workspace 与确定性领域核心（已完成）

代码位置：`rust/work-memory-core/`

已迁移：

- `BucketType`、`BucketStatus`、`ClassificationAction`。
- `BucketView` 与 `ClassificationResult` 的核心校验和字符串归一化。
- 当前焦点优先、按最近活跃时间排序、去重和候选上限。
- 服务端候选 ID 校验。
- 多候选、置信度和低信息模糊指代门控。
- 空工作区允许有效 `create_new` 启动首个 Bucket 的规则。

验收命令：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pytest -q
```

限制：R0 尚未接入 Python 生产路径，也未实现 JSON 反序列化、数据库或 LLM 调用。

### R1：跨语言契约与固定样例一致性

- 为 Rust 领域类型增加严格 JSON adapter，拒绝未知字段。
- 迁移 `ExtractionResult`、`ArchiveResult` 和 Agent 工具参数/返回契约。
- 让 Python 与 Rust 读取同一批 `tests/fixtures/` 样例。
- 为规范化结果生成可比较的 JSON，建立差异测试。

验收：分类和提取固定样例在两种实现中产生相同的规范化结果；所有未知字段、非法枚举和不一致 action 均被拒绝。

### R2：SQLite 仓储与迁移机制

- Rust 只读打开现有 SQLite Schema，先实现 Bucket/Entry 查询。
- 建立带版本号的 migration 表、备份和恢复说明。
- 实现 Bucket、Entry、Todo、Evidence、TimelineEvent、Decision、ClassificationRecord、Correction、ChatMessage 仓储。
- 在临时数据库上验证外键、级联、索引和时间格式兼容。

验收：Rust 可以读取 Python 创建的数据库；对隔离副本执行升级和回滚演练；不得直接修改用户本地数据库做测试。

### R3：归档、搜索与纠错服务

- 迁移 Bucket CRUD、关键词搜索、详情聚合和滚动摘要。
- 迁移 `archive_user_input` 单事务闭环。
- 迁移确认追加、确认新建和 Entry 移动纠错。
- 使用同一输入和隔离数据库对比 Python/Rust 最终状态。

验收：正常、确认、失败回滚和纠错场景均达到数据库状态等价；Rust 成为这些写路径的唯一所有者后，才移除对应 Python 业务逻辑。

### R4：LLM adapter 与 Agent Harness

- 实现 Responses API 和兼容 Chat Completions adapter。
- 实现严格结构化输出、拒绝、截断、Schema 错误和有限重试。
- 迁移受控工具注册、调用审计、最近消息窗口和 Bucket 上下文注入。
- 复用分类与提取离线评估集，真实模型验证保持独立命令。

验收：mock 回归完全通过；真实模型报告保留站点、模型、Prompt 版本和完整结构化结果；密钥不会进入日志或 Git。

### R5：Rust API 与 UI 切换

- 提供本地 HTTP API、健康检查和清晰错误响应。
- Streamlit 先改为 API 客户端，停止直接导入 Python 服务。
- 实现由 Rust 服务的正式 Web UI，覆盖长期对话、Bucket 侧栏、确认和纠错。
- 增加端到端测试和数据导出入口。

验收：用户可见 MVP 流程不依赖 Python；UI 行为与当前版本等价或有文档化改进。

### R6：移除 Python 运行时

- 删除失去调用方的 Python 服务、SQLAlchemy 模型、Pydantic Schema 和 Streamlit UI。
- 将剩余固定样例与必要文档迁到 Rust 测试体系。
- 更新安装、运行、备份、恢复和发布文档。

最终验收：仓库的产品运行、测试和数据迁移不再要求 Python；历史 SQLite 数据经过备份后可被新版本安全读取或迁移。

## 5. 当前代码映射

| 能力 | 当前 Python 来源 | Rust 目标 | 状态 |
|---|---|---|---|
| 分类枚举与结果校验 | `app/schemas.py` | `work-memory-core::domain` | R0 已迁移核心部分 |
| 候选排序与风险门控 | `app/services/classify_service.py` | `work-memory-core::classification` | R0 已迁移 |
| JSON/Structured Outputs 契约 | `app/schemas.py`, `app/llm.py` | Rust adapter crate | R1 待办 |
| SQLite 模型与 Session | `app/models.py`, `app/db.py` | Rust persistence crate | R2 待办 |
| Bucket/Archive/Search/Correction | `app/services/` | Rust service crates | R3 待办 |
| Agent Harness | `app/services/agent_service.py` | Rust agent crate | R4 待办 |
| Streamlit | `ui/streamlit_app.py` | Rust-served Web UI | R5 待办 |

## 6. 目录约定

```text
Cargo.toml                         # Rust workspace
rust/work-memory-core/            # 无 I/O 的领域契约和确定性规则
rust/work-memory-contracts/       # R1 计划：JSON/API 契约
rust/work-memory-store/           # R2 计划：SQLite 与 migration
rust/work-memory-service/         # R3 计划：业务编排
rust/work-memory-agent/           # R4 计划：LLM 与工具 Harness
rust/work-memory-server/          # R5 计划：HTTP 与静态 UI
```

后续 crate 只有在进入对应阶段时才创建，避免提前搭建无人使用的骨架。

## 7. Git 与文档规则

- 每个阶段性提交只迁移一个清晰边界，并使用祈使句提交信息。
- 每次提交前同时运行受影响的 Rust 测试和现有 Python 回归。
- 行为、接口、Schema 或运行命令变化时，同步更新本文件、`README.md`、`ARCHITECTURE.md`、`DATA_MODEL.md` 或 `TEST_PLAN.md` 中受影响的部分。
- 未完成切换的能力必须明确标注“仅基础实现”或“未接入生产路径”，不能把代码存在误写成重构完成。
