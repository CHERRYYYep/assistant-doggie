# 当前项目详解与后续提升指南

> **迁移说明（2026-08-25）**：本文主体记录冻结的 Rust oracle，路径和启动命令不再代表当前 `dev_ts` 产品实现。TypeScript 的实际启动方式是 `npm start`；当前模块地图请优先阅读 `docs/TS_PROJECT_DECOMPOSITION_GUIDE.md`、`docs/PLAN.md` 和根目录 `README.md`。Rust 内容仅用于裁决迁移前行为。

本文档面向后续开发者和产品迭代者，用仓库当前实现解释 Doggie 的整体结构、关键数据流、模块职责、API 行为、测试地图以及可继续提升的方向。它不是替代源码的接口规范；当行为存在疑问时，以 `crates/` 和 `apps/` 下当前源码和测试为准。

## 1. 项目定位与核心心智模型

本项目是一个本地单用户的个人工作长期记忆 Agent。用户像聊天一样输入工作事实、会议结论、排障记录、实验结果、待办或想法；系统先安全地把输入归档到长期记忆，再用当前记忆和历史对话回答问题。

核心抽象：

- **Bucket**：一个持续存在的工作对象，不是普通文件夹。它有类型、生命周期、摘要、标签、最后活跃时间，并聚合多条 Entry 和结构化 memory。
- **Entry**：一次用户输入的原始证据。`raw_text` 是不可替代的事实来源；结构化提取失败或摘要变化都不应丢失原文。
- **Memory item**：从 Entry 中提取出的结构化事实，例如 todo、evidence、timeline、decision、hypothesis、entity、tag。
- **Archive attempt**：每次归档尝试的审计记录。包括自动写入、需要用户确认和丢弃确认等状态。
- **Conversation message**：单一长期对话中的 user / assistant / tool 消息。重启后可以恢复上下文。

当前主流程：

```text
用户输入
  → 保存对话 user 消息
  → 服务端按“最近活跃 + 热门活跃”自动生成候选 Bucket
  → 模型输出结构化分类结果
  → core/service 执行候选 ID、低信息、置信度安全门控
  → 若安全：结构化提取并在 SQLite 事务中写入 Bucket/Entry/memory/audit
  → 若不安全：只保存 pending archive_attempt，返回确认卡片
  → 回答阶段只用只读工具查询记忆并综合回答
  → 保存 assistant/tool 消息
```

重要产品原则：

1. 自动归档不能依赖用户在 UI 侧手动选中的 Bucket；候选由服务端根据最近与热门自动生成。
2. 低信息输入宁愿多问一次，也不能静默写入可能错误的 Bucket。
3. 回答模型不能绕过归档确认流程写数据库；聊天回答阶段只开放只读工具。
4. 所有正式记忆写入必须保留原文、结构化 memory、审计记录和可重放确认绑定。
5. 当前是本地单用户 MVP；绑定非 loopback 地址前必须理解安全风险。

## 2. 运行入口与配置

当前 TypeScript 应用入口是 `src/main.ts`：

```bash
npm ci
cp .env.example .env
# 编辑 .env：至少配置 OPENAI_API_KEY 和 OPENAI_MODEL
npm start
```

默认行为：

- HTTP 地址：`127.0.0.1:8787`，只允许 loopback；
- 数据库：启动工作目录下的 `doggie.db`；
- 存储：Node 24 内置 `node:sqlite` + Doggie canonical schema；
- 模型端点：官方 OpenAI 或兼容 Responses / Chat Completions 的 endpoint；
- 前端：Hono/Node HTTP 同源提供，启动时使用 Node 24 原生 type stripping。

`src/runtime/config.ts` 负责 `.env`、shell 优先级、模型 endpoint、timeout、绝对数据库路径和监听地址校验；`src/runtime/local-web.ts` 负责组装 Store、模型、ArchiveRuntime、HTTP API 和 server；`src/main.ts` 负责生产启动与 SIGINT/SIGTERM 关闭。

主要环境变量以根目录 `.env.example` 和 `README.md` 为准。Web 与 Claude/Codex MCP 应显式使用同一个绝对 `DOGGIE_DATABASE_PATH`。

## 3. Workspace 分层地图

Cargo workspace 只包含当前 canonical 路径：

| crate | 主要路径 | 职责 |
|---|---|---|
| `doggie-domain` | `crates/doggie-domain/src/` | 领域值、Bucket/Entry 模型、分类动作、提取结果、低信息与置信度门控 |
| `doggie-protocol` | `crates/doggie-protocol/src/` | 模型结构化输出契约、JSON Schema、工具参数契约、严格边界校验 |
| `doggie-storage-sqlite` | `crates/doggie-storage-sqlite/src/` | Doggie-owned canonical SQLite schema、事务写入、查询、纠错、删除、历史导入和离线管理 |
| `doggie-application` | `crates/doggie-application/src/` | 业务服务 facade：候选生成、归档边界、自然语言查询、状态和纠错 |
| `doggie-llm` | `crates/doggie-llm/src/` | 模型 endpoint 配置、Responses/Chat Completions 适配、HTTP transport 和 response 归一化 |
| `doggie-agent-runtime` | `crates/doggie-agent-runtime/src/` | 受控工具 Harness、工具轮次/参数/输出限制和对话上下文组装 |
| `doggie-engine` | `crates/doggie-engine/src/lib.rs` | 组合模型、服务和安全策略，执行归档和读 projection |
| `doggie-local-web` | `apps/doggie-local-web/` | 本地 HTTP API、ChatGPT 风格静态 Web UI 资源、应用入口 |

推荐阅读顺序：

1. `README.md`：快速了解能力、运行方式和 API。
2. `docs/CODE_READING_GUIDE.md`：按当前架构走读全部生产代码、前端代码和测试入口。
3. 本文档：理解当前模块和关键流程。
4. `docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/AGENT_HARNESS.md`：了解设计边界。
5. `crates/doggie-engine/src/lib.rs`：看完整归档编排。
6. `crates/doggie-application/src/canonical.rs` 和 `crates/doggie-application/src/query.rs`：看业务服务和查询聚合。
7. `crates/doggie-storage-sqlite/src/canonical.rs`、`canonical_schema.rs`：看真实持久化模型。
8. `apps/doggie-local-web/src/lib.rs`：看 HTTP route 和 projection；`apps/doggie-local-web/frontend/`：看本地 Web UI。

## 4. `doggie-domain`：领域模型与确定性安全门控

核心文件：

- `domain.rs`：Bucket 类型、状态、分类动作、BucketView、ClassificationResult。
- `classification.rs`：候选生成、候选 ID 校验、低信息门控、置信度门控。
- `memory.rs`：ExtractionResult、TimelineEventExtract、ArchiveResult 等归档结果对象。
- `text.rs`：文本规范化、字段校验等通用规则。

### 4.1 主要领域枚举

Bucket 类型 `BucketType`：

- `idea`
- `task`
- `incident`
- `experiment`
- `decision`
- `meeting`
- `knowledge`
- `draft`

Bucket 生命周期 `BucketStatus`：

- `active`
- `paused`
- `done`
- `archived`

分类动作 `ClassificationAction`：

- `append_existing`：追加到已有 Bucket。
- `create_new`：创建新 Bucket 并保存第一条 Entry。
- `ask_user`：需要用户确认，不写正式 Entry。

### 4.2 候选 Bucket 的当前规则

`build_bucket_candidates` 的职责很小但很关键：

- 输入来自 service/store 已经排好序的 BucketView 列表。
- 去重并保留 service 提供的顺序。
- 截断到 `limit`。
- 保留 `_current_focus_bucket_id` 参数只是为了 API 兼容和审计兼容；它不会提升 UI 选中的 Bucket。

这正对应当前产品要求：**用户给出 entry 时，系统自动在最近和热门 Bucket 中关联，而不是要求用户人为选择哪个 Bucket。**

### 4.3 低信息门控

`classification.rs` 中有服务端确定性规则，防止模型因为上下文相似而过度自信。典型低信息输入包括：

- 模糊指代：`那个`、`这个`、`它`、`上次`、`刚才`、`相关` 等。
- 状态短句：`继续`、`更新`、`好了`、`正常了`、`记一下`、`补充一下` 等。

如果这类输入没有数字、指标、错误、日志、决定、原因、验证结果等可核验事实，即使模型给出较高置信度，也会降级为 `ask_user`。

### 4.4 置信度策略

`ConfidencePolicy::default()`：

- 自动归档门槛：`0.85`
- 需要确认门槛：`0.55`

直观理解：

- `>= 0.85` 且候选/信息充分，才允许自动 append 或 create。
- `0.55..0.85` 通常进入确认。
- `< 0.55` 或字段不一致，进入确认或报错。

注意：置信度不是概率；最终是否写入由服务端规则二次裁决。

## 5. `doggie-protocol`：模型与工具的严格 JSON 边界

该 crate 负责把不可信的模型输出转换成可信领域对象。关键原则：

- 反序列化结构使用 `serde(deny_unknown_fields)`，未知字段直接拒绝。
- 枚举字符串通过集中函数解析，拼写错误不会被静默接受。
- JSON Schema 由 Doggie protocol contract 生成，用于 Structured Outputs。
- contract 转领域对象时还会触发 `doggie-domain` 的字段和一致性校验。

主要文件：

| 文件 | 说明 |
|---|---|
| `classification.rs` | `ClassificationContract`、`BucketViewContract` |
| `extraction.rs` | `ExtractionContract`、`BucketSummaryContract` |
| `structured_output.rs` | Structured Output JSON Schema |
| `agent.rs` | Agent 工具定义、工具参数解析和校验 |
| `archive.rs`、`timestamp.rs`、`values.rs` | 归档、时间和枚举值边界 |

### 5.1 分类输出契约

模型分类输出必须表达：

```json
{
  "action": "append_existing | create_new | ask_user",
  "bucket_id": "string or null",
  "bucket_type": "idea | task | incident | experiment | decision | meeting | knowledge | draft | null",
  "title": "string or null",
  "confidence": 0.0,
  "reason": "string",
  "should_ask_user": false,
  "question": "string or null",
  "candidate_bucket_ids": []
}
```

跨字段一致性由领域层保证，例如：

- `append_existing` 必须引用已有候选 Bucket ID。
- `create_new` 必须有合法 `bucket_type` 和非空 `title`。
- `ask_user` 必须能给用户展示问题或理由。

### 5.2 提取输出契约

提取结果只记录用户输入中可观察到的事实：

- `summary`
- `todos`
- `evidences`
- `timeline_events`
- `decisions`
- `hypotheses`
- `entities`
- `tags`

缺失集合返回空数组，不使用空字符串占位，不编造原文没有的信息。

### 5.3 Agent 工具契约

`agent.rs` 中定义了工具名称和参数契约。当前聊天回答阶段只开放只读工具：

- `list_active_buckets`
- `search_memory`
- `get_bucket_detail`

contract 中仍保留写工具定义，例如 archive/save/create 类工具，但 server 的聊天回答阶段不会把它们放进 allow-list。归档写入只能走 runtime/server 的受控流程。

## 6. `doggie-storage-sqlite`：canonical SQLite 持久层

这是当前生产路径唯一持久层。它不暴露任意 SQL 写连接，业务写入通过强类型方法和事务完成。

主要文件：

| 文件 | 说明 |
|---|---|
| `canonical_schema.rs` | Doggie canonical schema 定义、表、索引和外键 |
| `canonical.rs` | 当前 canonical store 主实现和 projection 类型 |
| `archive_write.rs`、`bucket_write.rs`、`entry_write.rs`、`extraction_write.rs` | 较细粒度写入构件和兼容写入边界 |
| `delete_write.rs`、`correction_write.rs`、`chat_write.rs` | 删除、纠错、聊天消息写入 |
| `legacy_import.rs`、`migration.rs` | 历史库导入、备份、恢复和 schema 检查 |
| `bin/store_admin.rs` | 离线管理命令 |

### 6.1 canonical 表

核心表：

| 表 | 用途 |
|---|---|
| `rust_schema_meta` | canonical schema 元信息 |
| `rust_schema_migrations` | canonical migration 记录 |
| `buckets` | Bucket 主表 |
| `entries` | Entry 原文、摘要、分类信息和归档状态 |
| `bucket_tags` | Bucket 标签 |
| `memory_items` | 统一结构化 memory item 表 |
| `archive_attempts` | 分类/归档尝试、pending confirmation 和审计绑定 |
| `corrections` | 移动 Entry、删除 Bucket 等纠错审计 |
| `conversation_messages` | 单会话 user/assistant/tool 消息 |

### 6.2 关键外键行为

当前删除 Bucket 是硬删除，对依赖数据的影响由外键和 store 方法共同保证：

- `entries.bucket_id -> buckets ON DELETE CASCADE`
- `bucket_tags.bucket_id -> buckets ON DELETE CASCADE`
- `memory_items.bucket_id -> buckets ON DELETE CASCADE`
- `memory_items.entry_id -> entries ON DELETE SET NULL`
- `archive_attempts.bucket_id -> buckets ON DELETE SET NULL`
- `archive_attempts.entry_id -> entries ON DELETE SET NULL`

含义：删除 Bucket 会删除该 Bucket 下的 Entry、memory item 和 tag；archive attempt 历史保留，但关联的 bucket/entry 会置空；correction 记录会记录本次删除。

### 6.3 主要读写方法

`DoggieStore` 常用读方法：

- `initialize`、`open_existing`、`open_read_only`
- `list_buckets`
- `list_active_buckets`
- `list_popular_active_buckets`
- `get_bucket`
- `bucket_detail`
- `search`
- `list_entries`
- `list_memory_items`
- `list_archive_attempts`
- `get_archive_attempt`
- `list_chat_messages`
- `list_corrections`
- `counts`

常用写方法：

- `archive`
- `discard_archive_attempt`
- `append_chat_message`
- `move_entry`
- `delete_bucket`
- `set_bucket_status`

### 6.4 最近与热门 Bucket 排序

- `list_active_buckets(limit)`：按 `last_active_at DESC, updated_at DESC, id ASC` 取最近活跃 Bucket。
- `list_popular_active_buckets(limit)`：按 Entry 数、memory item 数、最后活跃时间、更新时间和稳定 ID 排序。

service 会把两组结果交错合并，再交给 core 去重截断。

### 6.5 归档事务不变量

- `ask_user` 只创建 `archive_attempts`，不创建 Entry，也不执行结构化提取。
- `append_existing` 必须引用存在且可写的 Bucket，并且必须有提取结果。
- `create_new` 必须创建 Bucket、第一条 Entry 和相关 memory。
- Entry、memory item、Bucket 摘要、活动时间和 audit 在同一个事务提交。
- 任一步失败都会回滚，避免部分写入。

### 6.6 删除 Bucket 行为

当前已有 `DELETE /api/buckets/{id}` 和 UI 详情页删除按钮。底层 `delete_bucket`：

1. 读取被删 Bucket、Entry、memory item、相关 archive attempt。
2. 执行硬删除 Bucket；依赖 Entry、memory、tag 级联删除。
3. 保留 archive attempt，但对应外键置空。
4. 写入 `corrections`，action 为 `delete_bucket`。
5. 返回 `DoggieDeleteBucketOutcome`，包括删除的 Entry ID、memory item ID、受影响 attempt ID 和 correction ID。

当前删除没有 undo，也不是软删除；后续若要提升用户安全感，优先考虑回收站或可恢复删除。

## 7. `doggie-application`：业务服务 facade

`CanonicalService` 是 runtime/server 之下的业务边界。它把 store 的低层读写转换成产品语义：候选生成、归档边界、自然语言查询、纠错和状态管理。

### 7.1 自动候选生成

`active_bucket_views(limit, _focus)` 当前实现：

1. 读取最近活跃 Bucket。
2. 读取热门活跃 Bucket。
3. 按 index 交错合并：recent[0]、popular[0]、recent[1]、popular[1]……
4. 转成 `BucketView`。
5. 调用 `build_bucket_candidates(..., None, limit)` 去重截断。

`focus` 参数保留但被忽略，不会手动提升某个 Bucket。这是当前“无需人为选择 bucket”需求的核心实现点。

### 7.2 分类后处理

`postprocess_classification(raw_text, result, candidates, policy)` 由 service 调 core，执行：

1. 候选 ID 校验：拒绝模型臆造的 Bucket ID。
2. 低信息门控：模糊/短状态输入降级确认。
3. 置信度门控：低于自动写入门槛时要求确认。
4. 再次校验候选引用，确保 UI 可以展示有效候选列表。

### 7.3 自然语言查询

`query.rs` 实现 Entry 粒度查询。当前是确定性解析和打分，不是向量检索。

解析支持：

- 常见中文查询前缀：`查询`、`查一下`、`帮我查询` 等。
- 相对时间：`最近两周`、`过去两周`、`最近一周/7天`、`最近一个月/30天` 等。
- Bucket 状态：`active`、`paused`、`done`、`archived` 及中文变体。
- 简单实体：以 `接口`、`服务`、`系统`、`项目` 等 marker 抽取。
- 显式结构化筛选：HTTP POST 可附加 `filters` 数组；runtime projection 中对应展示为 `structured_filters`。

打分大致综合：

- Bucket 标题、摘要、tag。
- Entry 原文和 summary。
- memory item 中的 entity、tag、todo、evidence、timeline 等。
- 词项覆盖率作为轻量 semantic score。
- 近期 Entry bonus。

输出是 `MemorySearchResponse`：

- `query` / `query_plan`
- Entry 级 `results`
- Bucket 聚合 `buckets`
- 去重 `evidence`
- 确定性 `answer`

当前 `answer` 是规则化摘要：说明命中 Entry 数和 Bucket 数，并列出前 5 条摘要片段。聊天回答模型可以基于这个只读结果进一步组织自然语言答案。

## 8. `doggie-llm` 与 `doggie-agent-runtime`：模型适配与受控工具 Harness

`doggie-llm` 只负责模型 HTTP/结构化输出适配和 response 归一化；`doggie-agent-runtime` 负责普通对话回答用的工具 Harness。

### 8.1 endpoint 与 transport

- `config.rs`：解析官方或自定义 endpoint；官方默认 `https://api.openai.com/v1`；自定义远端必须 HTTPS，HTTP 只允许 localhost。
- `http_transport.rs`：基于 `ureq` 的 HTTP transport。
- `structured_output.rs`：按 Responses 或 Chat Completions 形态请求结构化输出，并做重试/错误分类。
- `wire_response.rs`：把不同 API response shape 归一化。

### 8.2 Agent Harness 安全限制

`crates/doggie-agent-runtime/src/lib.rs` 控制模型工具调用循环：

- 默认最多 4 个 tool round；硬上限 8。
- 每轮最多 8 个 tool call。
- 单次工具参数最大 32 KiB。
- 单次工具输出最大 64 KiB。
- memory context 最大 64 KiB。
- 历史消息最多 100 条，单条最大 32 KiB。
- 工具必须在 allow-list 中，未知工具不会执行。
- 工具输出被当作数据，而不是指令。

### 8.3 当前聊天回答阶段

`apps/doggie-local-web` 的 `AgentChatResponder` 只给回答模型开放只读工具：

- `list_active_buckets`
- `search_memory`
- `get_bucket_detail`

归档写入、确认写入、移动 Entry、删除 Bucket、状态变更都不由回答模型直接触发，必须走 HTTP/server 的显式业务路径。

## 9. `doggie-engine`：归档编排与 JSON projection

`doggie-engine/src/lib.rs` 是连接模型、service 和核心安全策略的主编排层。

关键常量：

- `RUNTIME_PROMPT_VERSION = "doggie-engine-v1"`
- `DEFAULT_ACTIVE_BUCKET_LIMIT = 20`
- `DEFAULT_STRUCTURED_OUTPUT_RETRIES = 2`

关键类型：

- `MemoryModel` trait：抽象 `classify(text, candidates)` 和 `extract(text)`，便于测试注入 fake model。
- `StructuredMemoryModel<T>`：用 `StructuredOutputAdapter` 实现真实模型分类/提取。
- `CanonicalArchiveCoordinator`：执行一次归档或确认写入。
- `ArchiveExecution`：持久化 outcome + validated classification/extraction + candidate projection。
- `CanonicalRuntime<M>`：server 使用的组合运行时。

### 9.1 自动归档流程

`CanonicalRuntime::archive(text, focus)` 当前由 server 传 `None`，内部流程：

1. 校验文本非空。
2. `service.list_active_buckets(limit)` 用于后续 bucket projection。
3. `service.active_bucket_views(limit, None)` 生成最近+热门候选。
4. `model.classify(text, candidates)` 获取结构化分类。
5. `service.postprocess_classification` 执行服务端门控。
6. 若 action 为 `ask_user`，不做 extraction。
7. 若 action 为 append/create，调用 `model.extract(text)`。
8. `service.archive(...)` 在 store 事务中写入。
9. 返回 `ArchiveExecution`。

### 9.2 显式确认写入

当用户在确认卡片中选择保存：

- `append_confirmed_for_attempt(bucket_id, text, attempt_id)`：绑定 pending attempt，提取并追加到已有 Bucket。
- `create_confirmed_for_attempt(title, bucket_type, text, attempt_id)`：绑定 pending attempt，提取并创建新 Bucket。
- `discard_archive_attempt(attempt_id, command_text)`：不保存并标记 attempt resolved。

确认路径会校验：

- attempt 存在；
- action 是 `ask_user`；
- `archive_state` 是 `needs_confirmation`；
- 未 resolved、未 corrected；
- 提交文本与原始 raw_text 完全匹配；
- append 目标 Bucket 存在且 active。

### 9.3 JSON projection

`archive_execution_to_value` 输出给 HTTP/UI 的字段包括：

- `attempt_id`
- `archive_state`
- `bucket_id`
- `entry_id`
- `memory_item_ids`
- `action`
- `confidence`
- `reason`
- `question`
- `candidate_bucket_ids`
- `recommended_bucket_id`
- `recommended_bucket`
- `candidate_buckets`
- `bucket_title` / `bucket_type`：仅表示新 Bucket 建议
- `bucket`
- `extraction`

这使 UI 能完整展示推荐 Bucket、备选 Bucket、创建新 Bucket、不保存、归档后修改 Bucket 等入口。

## 10. `doggie-local-web`：HTTP API 与静态 Web UI

### 10.1 HTTP route 总览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 返回静态 Web UI 入口 HTML |
| `GET` | `/index.html` | 返回同一入口 HTML |
| `GET` | `/assets/styles.css` | 返回前端样式 |
| `GET` | `/assets/app.js` | 返回前端脚本 |
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/buckets/active?limit=20` | 读取活跃 Bucket |
| `GET` | `/api/buckets/search?q=...&limit=20` | legacy Bucket 级搜索 |
| `GET` | `/api/buckets/{id}` | 读取 Bucket 详情、Entry 和 memory |
| `DELETE` | `/api/buckets/{id}` | 删除 Bucket 及其 Entry/memory/tag，并记录纠错审计 |
| `POST` | `/api/buckets/status` | 设置 Bucket 生命周期 |
| `POST` | `/api/corrections/move` | 移动 Entry 到其他 Bucket |
| `GET` | `/api/chat/history?limit=40` | 读取对话历史 |
| `POST` | `/api/chat` | 发送一轮对话：先归档，再回答 |
| `POST` | `/api/chat/confirm` | 对 pending archive attempt 做 append/create/discard |
| `POST` | `/api/archive` | 直接执行归档，不走完整聊天回答 |
| `POST` | `/api/archive/append` | 显式追加，要求 `confirmation_granted` |
| `POST` | `/api/archive/create` | 显式创建，要求 `confirmation_granted` |
| `GET` | `/api/memory/query?q=...&limit=20` | 自然语言 Entry 级记忆查询 |
| `POST` | `/api/memory/query` | 查询文本 + 显式 filter 查询 |

### 10.2 `/api/chat` 行为

`handle_chat` 的重要行为：

1. 解析 `{ "message": "..." }`。
2. 保存 user message。
3. 记录可选旧字段 `focus_bucket_id` 到 message details 的 `requested_focus_bucket_id`，仅用于兼容/审计。
4. 调用 `runtime.archive(text, None)`，不会让 UI 选中 Bucket 影响自动候选。
5. 如果归档状态是 `needs_confirmation`，assistant 返回确定性提示，不调用回答模型声称已保存。
6. 如果已自动保存，调用 `ChatResponder`，用只读工具查询和综合回答。
7. 保存 tool messages 和 assistant message。

### 10.3 `/api/chat/confirm` 行为

确认请求必须带：

- `confirmation_granted: true`
- `attempt_id`
- `text`
- `action`: `append`、`create` 或 `discard`

append 还需要 `bucket_id`；create 还需要 `title` 和 `bucket_type`。服务端会绑定原始 attempt 和 raw_text，避免客户端伪造或重复确认。

### 10.4 删除 Bucket API 响应

成功响应形态：

```json
{
  "ok": true,
  "bucket_id": "...",
  "deleted_entry_ids": ["..."],
  "deleted_memory_item_ids": ["..."],
  "updated_archive_attempt_ids": ["..."],
  "correction_id": "..."
}
```

不存在的 Bucket 返回 404。当前 UI 在 Bucket 详情页展示“删除 Bucket”按钮，并在删除前弹出确认框。

### 10.5 Web UI 当前状态

UI 已从 Rust raw string 拆成 `apps/doggie-local-web/frontend/` 下的独立静态前端资源：

- `index.html`：页面结构和静态挂载点。
- `assets/styles.css`：页面样式。
- `assets/app.js`：前端状态、API 请求、Markdown 安全渲染和事件绑定。

`apps/doggie-local-web/src/frontend.rs` 通过 `include_str!` 编译期嵌入这些静态资源，保持 `doggie-local-web` 二进制自包含；`GET /` 与 `GET /index.html` 返回入口 HTML，`GET /assets/styles.css` 和 `GET /assets/app.js` 返回对应资源。当前阶段不引入 npm/Vite 等前端构建链。

前端行为约束：

- 左侧显示活跃 Bucket。
- 中间是长期对话。
- 右侧显示选中 Bucket 详情。
- 顶部明确显示 `自动关联最近和热门 Bucket`。
- `sendMessage()` 只发送 `{ message: text }`，不发送选中 Bucket 作为归档目标。
- 选中 Bucket 只用于浏览详情。
- 归档结果展示状态、推荐 Bucket、候选 Bucket、确认操作和修改入口。
- Bucket 详情页支持删除 Bucket。

后续如果 UI 继续增长，可以在保持 `/api` 同源契约的前提下，再引入前端构建或模板边界。

## 11. 关键业务流程详解

### 11.1 自动归档 append existing

适用：用户输入与某个最近/热门活跃 Bucket 明确相关，且包含足够事实。

```text
message/text
  → candidates(recent+popular)
  → classify: append_existing + bucket_id + confidence
  → core gates pass
  → extract
  → store.archive transaction
  → Entry + memory_items + archive_attempt resolved
```

结果：创建 Entry，更新 Bucket 摘要/活跃时间，返回 bucket/entry/memory IDs。

### 11.2 自动归档 create new

适用：用户明确开启新主题，或没有安全匹配的旧 Bucket，但内容信息充足。

```text
message/text
  → classify: create_new + title + bucket_type + confidence
  → core gates pass
  → extract
  → create Bucket + first Entry + memory_items
```

注意：低信息输入不应自动 create；例如“新项目记一下”如果没有事实，应询问用户补充或确认。

### 11.3 `ask_user` 确认

适用：低信息、多个相似候选、模型低置信度、引用不清或用户意图不明确。

```text
message/text
  → classify/postprocess: ask_user
  → no extraction
  → archive_attempt(needs_confirmation)
  → UI confirmation card
```

UI/客户端必须展示：

- 推荐 Bucket；
- 备选 Bucket；
- 模型/规则判断理由；
- 创建新 Bucket；
- 不保存；
- 归档后的修改 Bucket 入口。

### 11.4 显式 append/create/discard

用户确认后，写入不再依赖模型分类，而是用用户选择构造高置信度分类：

- append：保存到指定 active Bucket。
- create：用指定标题和类型创建 Bucket。
- discard：标记 attempt 已解决但不写 Entry。

这保证待确认输入不会因为一次聊天回答被偷偷归档。

### 11.5 记忆查询与综合回答

当前有两层查询：

1. `GET /api/buckets/search` / runtime `search_memory`：较旧的 Bucket 级搜索。
2. `GET|POST /api/memory/query` / service `query_memory`：更丰富的 Entry 级自然语言查询。

Entry 级查询会返回 query plan、results、bucket groups、evidence 和 deterministic answer。聊天回答模型可以调用 `search_memory` 工具获取该结果，并综合多个 Entry/Bucket 的事实回答用户。

当前还不是向量 RAG：语义部分主要是词项覆盖和结构化字段命中。后续可加入 embedding、reranker 或模型辅助 query planner。

### 11.6 Entry 移动与纠错

`POST /api/corrections/move` 会把 Entry 及其结构化 memory 移动到目标 Bucket，并记录 correction。用于修正归档错误。

需要注意：移动 Entry 后，源/目标 Bucket 的摘要、活跃时间和统计一致性要由 store/service 测试覆盖。

### 11.7 Bucket 状态变更

`POST /api/buckets/status` 当前支持设置 `active`、`paused`、`done`、`archived`。UI 若未暴露全部状态，仍应与 HTTP route、core、store、service 和测试保持一致。

### 11.8 对话持久化

所有 chat user/assistant/tool 消息写入 `conversation_messages`。历史读取会尝试 hydrate 归档消息，使重启后仍能看到确认卡片和归档投影。

## 12. 数据模型速查

### 12.1 Bucket

重要字段：

- `id`
- `title`
- `kind` / `bucket_type`
- `lifecycle` / `status`
- `summary`
- `created_at`
- `updated_at`
- `last_active_at`
- `archived_at`
- tags

### 12.2 Entry

重要字段：

- `id`
- `bucket_id`
- `raw_text`
- `summary`
- `content_type`
- `classification_confidence`
- `classification_reason`
- `created_at`
- `updated_at`
- `moved_from_bucket_id`
- `archive_state`
- `archived_at`

### 12.3 Memory item

统一表字段表达：

- `kind`: `todo`、`evidence`、`timeline`、`decision`、`hypothesis`、`entity`、`tag`
- `text`
- `status`
- `due_at`
- `occurred_at`
- `source`
- `reason`
- `metadata`
- `bucket_id`
- `entry_id`

### 12.4 Archive attempt

关键字段：

- `id`
- `raw_text`
- `action`
- `archive_state`
- `bucket_id`
- `entry_id`
- `confidence`
- `reason`
- `question`
- `candidate_bucket_ids`
- `focus_bucket_id`：兼容/审计字段，不代表当前 UI 手动选择会影响候选。
- `prompt_version`
- `model_name`
- `corrected`
- `created_at`
- `resolved_at`

## 13. API 使用速查

### 13.1 发送聊天

```bash
curl -s http://127.0.0.1:8787/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"支付回调从 10:20 开始失败，第三方返回 502。"}'
```

可能结果：

- `archive_state = archived`：已自动保存。
- `archive_state = needs_confirmation`：没有正式写入 Entry，需要用户选择。
- `chat_error != null`：归档可能成功，但回答模型失败；需要看响应中的 archive 状态。

### 13.2 直接归档

```bash
curl -s http://127.0.0.1:8787/api/archive \
  -H 'content-type: application/json' \
  -d '{"text":"今天压测接口 A，QPS 到 1200 后 P99 升到 2.3s。"}'
```

### 13.3 查询记忆

```bash
curl -G http://127.0.0.1:8787/api/memory/query \
  --data-urlencode 'q=查询接口 A 最近两周的压测结果' \
  --data-urlencode 'limit=20'
```

POST 版本可附加结构化 filter：

```json
{
  "query": "接口 A 压测",
  "limit": 20,
  "filters": [
    {"field": "entity", "value": "接口 A"},
    {"field": "kind", "value": "evidence"}
  ]
}
```

### 13.4 删除 Bucket

```bash
curl -X DELETE http://127.0.0.1:8787/api/buckets/<bucket_id>
```

这是硬删除。删除前应在 UI 或调用方明确提醒用户：Bucket 下的 Entry 和 memory item 会被删除，archive attempt 审计保留但关联置空。


### 13.5 显式确认接口的安全边界

`POST /api/archive/append` 和 `POST /api/archive/create` 是显式确认写入接口，只检查 `confirmation_granted: true`，不绑定某个 pending chat attempt。带原文重放保护、防重复确认和 pending 状态校验的路径是 `POST /api/chat/confirm`。如果是在 UI 确认卡片中处理 `needs_confirmation`，应优先使用 `/api/chat/confirm`。

## 14. 测试地图

常用完整检查：

```bash
cargo fmt --all -- --check
cargo check --workspace --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
cargo test --workspace --offline
git diff --check
```

分层测试重点：

| 层 | 测试路径 | 重点 |
|---|---|---|
| core | `crates/doggie-domain/tests/` | 分类动作、候选排序、低信息门控、置信度门控 |
| contracts | `crates/doggie-protocol/tests/` | 严格 JSON、未知字段、schema 与领域对象转换 |
| store | `crates/doggie-storage-sqlite/tests/` | schema 初始化、事务、查询、删除级联、纠错审计、历史导入校验 |
| service | `crates/doggie-application/tests/` | 最近+热门候选、归档边界、自然语言查询、聚合回答 |
| runtime | `crates/doggie-engine/tests/` | fake model 下的自动归档、确认、projection |
| llm | `crates/doggie-llm/tests/` | endpoint 配置、HTTP transport、structured output 和 response 归一化 |
| agent-runtime | `crates/doggie-agent-runtime/tests/` | 工具 Harness 限制、工具 allow-list、上下文资源上限 |
| server | `apps/doggie-local-web/tests/` | route、UI contract、确认卡片、删除按钮、Markdown 渲染边界 |

测试原则：

- 普通测试使用 fake model/transport 和临时 SQLite 文件。
- 不调用真实模型。
- 不读写真正的用户数据库。
- 修改 archive、confirmation、query 或 schema 后，按 `docs/TEST_PLAN.md` 做对应回归。

## 15. 后续提升方向

### 15.1 记忆查询与综合回答

当前查询是确定性关键词/结构化打分。可提升：

- 引入 embedding/vector index，提高跨表达方式召回。
- 增加 reranker，将候选 Entry 按真实相关性重排。
- 增加模型辅助 query planner，把自然语言稳定拆成 entity/topic/time/status/filter。
- 回答中加入更明确的 evidence 引用和“事实 vs 推断”标注。
- 支持多轮查询澄清，例如“最近那个接口”可反问或结合最近查询上下文。

### 15.2 Bucket 生命周期与删除安全

当前已支持删除 Bucket，但为硬删除。可提升：

- 软删除/回收站，支持 undo。
- Bucket merge/split，处理主题重复或过大的 Bucket。
- 自动建议归档 inactive Bucket。
- 删除前显示影响范围：Entry 数、memory 数、最近活动、相关 pending attempt。
- 为删除、移动、状态变更提供更丰富的审计和恢复工具。

### 15.3 自动归档质量

可提升：

- 建立固定标注集校准 confidence 阈值。
- 增加候选解释特征：为什么最近、为什么热门、为什么相关。
- 对低信息门控增加更多中英文模式和单元测试。
- 让模型输出更好的 `candidate_bucket_ids` 排序，但服务端仍必须校验。
- 对 create_new 增加标题去重和近似 Bucket 合并提醒。

### 15.4 UI/产品体验

可提升：

- 视 UI 复杂度引入前端构建或模板边界。
- 确认卡片增强：搜索其他 Bucket、显示更多候选、批量处理 pending。
- Bucket 详情分页、筛选、按 memory kind 展示。
- 查询结果展示 query plan、evidence、命中字段和可复制摘要。
- 导出/备份/恢复 UI。
- 暗色模式、键盘快捷键、错误重试提示。

### 15.5 Store 与运维

可提升：

- canonical schema v2 migration 策略和自动升级策略。
- 数据库备份计划、压缩、加密和完整性检查。
- 并发写入和长事务行为压测。
- 更清晰地区分 legacy compatibility 代码和 canonical runtime 代码。
- 增加 admin 命令：导出 JSON、检查 orphan 审计、统计 Bucket 健康度。

### 15.6 Agent Harness 与安全

可提升：

- 更细粒度的 tool budget 和 per-tool timeout。
- 工具输出引用 ID 化，减少模型误读大段 JSON。
- 对回答阶段的“已保存/待确认/未保存”做更严格模板化。
- 如果未来开放写工具，必须让写工具走同样的 confirmation 和 audit，不允许模型直接写库。

### 15.7 文档和开发者体验

可提升：

- 将 `docs/ARCHITECTURE.md`、`docs/PROMPTS.md` 与当前源码 prompt/projection 定期同步。
- 为每个关键流程补 sequence diagram。
- 为 API 响应补完整 JSON example。
- 建立 `docs/CHANGELOG.md` 或 ADR，记录“为什么从 UI focus 改成最近+热门候选”等设计决策。

## 16. 修改代码时的推荐路径

### 16.1 修改分类/候选逻辑

推荐顺序：

1. `doggie-domain`：更新领域规则和门控测试。
2. `doggie-application`：更新候选构造和后处理测试。
3. `doggie-engine`：更新 prompt 或归档编排。
4. `doggie-local-web`：更新 projection/UI 文案。
5. `docs/PROMPTS.md`、本文档和测试计划同步。

必须确认：低信息输入仍进入 `ask_user`；模型不能使用非候选 Bucket ID。

### 16.2 修改归档写入或确认流程

推荐顺序：

1. 明确事务不变量。
2. 先更新 store request/outcome 和事务测试。
3. 再更新 service/runtime 的业务校验。
4. 最后更新 server API 和 UI。
5. 补充 pending attempt、重复确认、文本 mismatch、目标 Bucket 不存在/非 active 的测试。

### 16.3 修改查询和综合回答

推荐顺序：

1. `MemoryQuery` plan 增加字段和解析测试。
2. `search_memory` 增加检索/打分/去重测试。
3. runtime projection 增加 JSON 字段。
4. Agent tool contract 更新参数和输出说明。
5. UI 展示 query plan/evidence。

### 16.4 修改 schema

推荐顺序：

1. 设计 migration 和回滚/备份策略。
2. 更新 `canonical_schema.rs`。
3. 更新 store 读写类型和事务。
4. 更新 legacy import 映射。
5. 跑完整 store/service/runtime/server 回归。

不要手工修改真实用户数据库来绕过 migration。

## 17. 当前边界与注意事项

- 这是本地单用户系统，没有内置认证、授权、TLS、CSRF、限流或多租户隔离。
- `confirmation_granted` 是业务确认，不是身份凭证。
- 如果监听到非 loopback 地址，网络访问者可能读写数据库。
- HTTP server 和 `ureq` 模型调用都是同步阻塞风格；模型请求期间会阻塞当前 server 处理流程。
- API Key 只应来自环境变量或 `.env`，不要写入日志、测试 fixture 或提交。
- 聊天回答阶段只读；归档写入已经在回答前完成或进入确认。
- UI 选中 Bucket 只用于浏览，不是自动归档目标。
- 删除 Bucket 当前是硬删除；用户体验上应谨慎呈现。
- “综合回答”当前依赖 Entry 级查询结果和回答模型组织语言，尚未实现完整向量 RAG。
