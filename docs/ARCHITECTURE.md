# 系统架构设计

> Rust 迁移状态（2026-08-04）：当前生产路径仍是本文件描述的 Python 单体；Rust 已具备确定性领域核心、严格 JSON 契约、九张业务表的强类型只读 SQLite 仓储、九表离线 migration/备份恢复安全层、仅面向隔离数据库的可写连接与原子事务基础，以及 append/create/ask_user 的强类型归档聚合写 API、事务性 Entry 移动纠错 API 与强类型 ChatMessage 追加 API。这些 API 尚未接入 Python Agent 或生产数据库，生产运行时仍由 Python 独占写入。渐进切换边界和最终 Rust 架构见 [`RUST_MIGRATION.md`](./RUST_MIGRATION.md)，数据库运维边界见 [`SQLITE_MIGRATIONS.md`](./SQLITE_MIGRATIONS.md)。

## 1. 总体架构

MVP 使用可测试的单体服务架构：

```text
Streamlit UI
    ├─ agent_service ── llm.py ── Responses API / Chat Completions
    │      ├─ 对话历史 ───────────────────────────→ SQLite
    │      └─ 受控工具 ──→ search/bucket/archive services
    └─ archive_service
           ├─ classify_service ── llm.py
           ├─ extract_service  ── llm.py
           └─ bucket_service ─────────────────────→ SQLite

correction_service ──→ SQLite
search_service     ──→ SQLite
view_service       ──→ Streamlit 展示数据
```

普通 Python 函数足以表达当前流程，比提前引入复杂 Agent 框架更容易调试、测试和回滚。只有出现多角色协作、长流程状态机或复杂工具审批后，才需要考虑进一步编排。

当前的 `agent_service` 是一个单 Agent、显式工具注册的轻量 Harness，而不是多 Agent 框架。它持久化唯一对话的消息，每轮自动加载最多 8 个活跃 Bucket 的摘要概览，再把最近对话交给模型，并执行 `list/search/get/archive/confirmed save` 等受控工具。模型没有任意本机代码执行权限。

## 2. 对话与默认记忆流程

```text
1. 保存用户消息
2. 读取最近 40 条 user/assistant 历史
3. 自动读取最近 8 个活跃 Bucket 的标题、摘要、标签和 ID
4. 模型直接回答，或主动读取更详细的 Bucket 记忆
5. 如果输入包含长期工作事实，模型默认调用归档工具
6. 归档仍经过分类、置信度门控、确认和事务保存
7. 保存工具审计记录与最终 assistant 回答
8. UI 同屏刷新主对话和独立 Bucket 侧边栏
```

“默认记忆”不等于“保存所有消息”。纯问题、问候和未确认的助手建议不会落库；实际项目状态、进展、证据、结论和 Todo 才进入 Bucket。这样既减少用户手工操作，也避免把聊天噪声当成长期事实。

## 3. 普通归档流程

```text
1. 校验用户输入
2. 读取活跃 Bucket，并把当前焦点排在候选首位
3. classify_service 请求严格的 ClassificationResult
4. 服务端验证模型引用的 Bucket ID
5. 应用置信度与多候选门控；无候选且模型给出有效 create_new 时允许启动首个 Bucket
6. 写 classification_records 审计
7. ask_user：停止，不创建正式 Entry
8. append/create：extract_service 请求 ExtractionResult
9. 同一事务创建或追加 Entry，并写 Todo/Evidence/Timeline/Decision
10. 更新标签、滚动摘要和最近活跃时间
11. 返回 ArchiveResult
```

`archive_service` 自己创建 Session 时负责提交、回滚和关闭；调用方传入 Session 时，最终事务控制权属于调用方。

Streamlit 不再维护第二套手工归档输入状态。归档需要确认时，Agent 会在同一对话中说明候选或建议的新 Bucket；用户下一条消息确认后，Harness 调用 `save_to_existing_bucket` 或 `create_bucket_and_save` 完成操作。空工作区中的有效工作事实仍可通过 `archive_memory` 自动创建首个 Bucket。

## 4. 服务职责

### `llm.py`

统一 OpenAI 配置与 Structured Outputs 调用，处理响应不完整、拒绝、Schema 校验失败和有限重试。业务服务不直接创建 OpenAI Client。

### `classify_service`

构造有限候选，输出 `append_existing`、`create_new` 或 `ask_user`，校验模型返回的引用并执行风险门控。每次结果写入 `classification_records`，用于校准和纠错分析。

### `extract_service`

从单条原始输入提取 summary、todos、evidences、timeline events、decisions、hypotheses、entities 和 tags。当前持久化前五类结构和 tags；hypotheses、entities 暂只保留在返回结果中。

### `bucket_service`

负责 Bucket/Entry CRUD、结构化记录入库、精确去重、滚动摘要和详情查询。摘要可由 Entry 重新构建，不能代替原始事实。

### `correction_service`

支持移动指定或最近 Entry，并同步移动其派生记录；写入 Correction 前后快照，重建两个 Bucket 的摘要，并把关联分类审计标记为已纠错。Rust `WritableSqliteStore::move_entry` 已在隔离临时数据库复现该聚合事务及失败回滚，但当前 Agent 和 UI 仍调用 Python 服务。

### `agent_service` 的聊天持久化边界

Python 当前仍通过 `add_chat_message` 分别提交 user、tool 和 assistant 消息。Rust `ChatMessageWriteRequest` 与 `WritableSqliteStore::append_chat_message` 已在隔离临时数据库复现单条消息的角色、内容、工具元数据、details、UUID、时间顺序和失败回滚语义，但尚未接入 Agent Harness，也不提供完整 turn 的跨消息事务。

### `search_service` 与 `view_service`

搜索服务使用 SQLite 关键词匹配标题、摘要、标签和 Entry 原文。展示服务将 ORM/Pydantic 对象转换为稳定的 UI 数据结构，避免业务逻辑散落在 Streamlit 回调中。

## 5. 当前焦点与候选范围

当前焦点来自统一 UI 侧边栏选中的 Bucket，并随每轮对话传给 Harness。Agent 默认上下文加载最多 8 个活跃 Bucket；真正进入归档分类时，分类服务仍使用当前焦点和最近活跃的有限候选，默认上限为 20。这样既减少 Token 消耗，也避免把完整历史暴露给每次调用；更旧内容通过搜索按需找回。

## 6. 风险门控

```text
confidence >= 0.85 且候选唯一 → 自动归档
0.55 <= confidence < 0.85       → 用户确认
confidence < 0.55               → 用户确认
多个相似候选                    → 用户确认
```

阈值来自 `.env`，只是保守初值。`confidence` 是模型主观信号，不是正确概率；必须用固定标注集、实际纠错和高错误代价案例持续校准。低置信度输入可写分类审计，但不得在确认前污染正式 Bucket。

## 7. 事务与错误处理

- OpenAI 配置或调用失败：明确报错，不伪造归档结果。
- 输出不符合 Schema：有限重试后失败。
- Bucket ID 无效：降级为确认，不进入持久化流程。
- 数据库任一步失败：自动归档事务整体回滚。
- 用户确认后：通过独立确认入口重新提取并保存。

MVP 不自动创建 `inbox` 兜底，因为它会把“不确定”误解为“已归档”。

## 8. 可观测性与评估

当前持久化分类动作、分数、原因、候选、焦点、Prompt 版本、模型名和纠错状态。固定 50 条标注集负责计算分类准确率、自动归档准确率、询问召回率与严重误合并数。真实模型评估使用独立命令，普通 Pytest 全部 mock LLM。

后续可增加调用耗时、Token、成本、搜索 query、摘要重建版本和用户确认选择等指标。
