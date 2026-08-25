# Doggie 当前架构代码阅读指南

> **迁移说明（2026-08-25）**：本文主体记录冻结的 Rust oracle，路径和启动命令不再代表当前 `dev_ts` 产品实现。TypeScript 的实际启动方式是 `npm start`；当前模块地图请优先阅读 `docs/TS_PROJECT_DECOMPOSITION_GUIDE.md`、`docs/PLAN.md` 和根目录 `README.md`。Rust 内容仅用于裁决迁移前行为。

本文面向第一次接手当前代码库的开发者，目标是说明：**在当前 Cargo workspace 与本地 Web UI 架构下，应该按什么顺序阅读全部生产代码、测试代码和关键文档**。本文不替代源码；当行为存在疑问时，以 `crates/`、`apps/` 下当前代码和测试为准。

当前阶段只考虑本地 Web UI：`doggie-local-web` 是唯一应用入口，同源提供静态 HTML/CSS/JS 和本地 HTTP API；没有 Node/npm/Vite 构建步骤，也没有旧版非 Rust 生产路径。

## 1. 使用本文的方式

建议把阅读分成三层：

1. **先看全局依赖方向**：确认哪些 crate 是底层领域/契约，哪些 crate 是应用服务/运行时，哪些代码只属于本地 Web UI。
2. **再看一条端到端业务流**：从用户在页面输入消息开始，追踪 `/api/chat`、归档、确认、持久化、助手回答和历史恢复。
3. **最后按任务回到模块细读**：修改分类、查询、schema、UI、安全门控或 LLM 适配时，只深入相关模块和对应测试。

不要从 HTTP 文件或 UI 字符串里推断业务规则。业务规则应优先落在 `doggie-domain`、`doggie-protocol`、`doggie-application`、`doggie-engine`，HTTP/UI 只做入参校验、调用服务和产品投影。

## 2. 当前目录与 workspace 总览

顶层 `Cargo.toml` 的 workspace members 是当前唯一产品/测试/开发路径：

| 层级 | 路径 | 职责 |
|---|---|---|
| 领域层 | `crates/doggie-domain/` | 领域值、Bucket/Entry 视图、分类动作、结构化记忆结果、低信息与置信度门控 |
| 契约层 | `crates/doggie-protocol/` | 模型 Structured Outputs 契约、JSON Schema、Agent 工具参数契约、严格边界校验 |
| 持久层 | `crates/doggie-storage-sqlite/` | Doggie canonical SQLite schema、事务写入、查询、删除、纠错、聊天历史、历史库导入 |
| 应用层 | `crates/doggie-application/` | 归档服务、自然语言查询、Bucket 状态、Entry 移动、对话持久化 facade |
| 模型适配 | `crates/doggie-llm/` | OpenAI/兼容端点配置、Responses/Chat Completions HTTP transport、wire response 归一化 |
| Agent 运行时 | `crates/doggie-agent-runtime/` | 工具 Harness、工具 allow-list、轮次/参数/输出限制、对话上下文组装 |
| 组合运行时 | `crates/doggie-engine/` | 组合模型、应用服务和安全策略，输出 HTTP/UI 需要的 JSON projection |
| 本地应用 | `apps/doggie-local-web/` | 进程入口、标准库 HTTP server、本地 API、静态 Web UI 托管 |
| 文档 | `docs/` | 架构、数据模型、Agent Harness、迁移、测试计划和本文 |

依赖方向应保持单向：

```text
doggie-domain
  ↑
  ├── doggie-protocol
  │     ↑
  │     ├── doggie-llm
  │     │     ↑
  │     │     └── doggie-agent-runtime
  │     └── doggie-storage-sqlite
  │           ↑
  │           └── doggie-application
  │                 ↑
  │                 └── doggie-engine
  │                       ↑
  │                       └── doggie-local-web
  └── doggie-storage-sqlite
        ↑
        └── doggie-application / doggie-engine
```

阅读时可以用这个原则判断改动位置是否合理：

- `domain` 不应该依赖 store、HTTP、LLM。
- `protocol` 只负责外部 JSON/工具契约到领域对象的边界，不写数据库。
- `storage` 不做模型决策；它只保证 schema、事务和 projection。
- `application` 组合 store 能力形成业务 facade，但不直接处理 HTTP。
- `engine` 组合 model + service，负责端到端归档和 JSON projection。
- `doggie-local-web` 是边界层，不应把核心业务逻辑塞回 route 或前端模板。

## 3. 推荐全局阅读顺序

### 3.1 最短理解路径

如果只想快速理解“消息如何变成记忆并在 UI 中出现”，按以下顺序：

1. `README.md`：能力、运行方式、HTTP API 总览。
2. `apps/doggie-local-web/frontend/README.md`：确认当前前端是无构建静态资源。
3. `apps/doggie-local-web/src/main.rs`：进程启动、环境变量、模型和数据库组装。
4. `apps/doggie-local-web/src/lib.rs`：`Server::handle_request`、`handle_chat`、`handle_chat_confirmation`。
5. `crates/doggie-engine/src/lib.rs`：`CanonicalRuntime`、`archive`、确认写入和 projection。
6. `crates/doggie-application/src/canonical.rs`：业务服务 facade。
7. `crates/doggie-storage-sqlite/src/canonical.rs` 与 `canonical_schema.rs`：真实数据模型和读写。
8. `apps/doggie-local-web/frontend/assets/app.js`：前端状态、请求、归档卡片和确认事件。

### 3.2 完整代码阅读路径

如果要系统读完整代码，建议顺序是：

1. `crates/doggie-domain/`：先建立领域语言。
2. `crates/doggie-protocol/`：理解模型/工具 JSON 如何被约束。
3. `crates/doggie-storage-sqlite/`：理解 canonical schema 和事务不变量。
4. `crates/doggie-application/`：理解 service facade 如何拼出业务能力。
5. `crates/doggie-llm/`：理解外部模型端点和 Structured Outputs 请求/响应。
6. `crates/doggie-agent-runtime/`：理解聊天回答阶段的受控只读工具 Harness。
7. `crates/doggie-engine/`：理解端到端归档编排和产品 projection。
8. `apps/doggie-local-web/`：理解 HTTP route、静态 UI 和测试契约。
9. `docs/TEST_PLAN.md` 与各 crate `tests/`：用测试倒推系统不变量。

## 4. 运行入口与本地 Web UI 边界

### 4.1 进程入口：`apps/doggie-local-web/src/main.rs`

`main.rs` 是当前唯一应用入口。阅读重点：

1. `load_dotenv(".env")`：读取当前工作目录 `.env`，支持普通 `KEY=VALUE` 和 `export KEY=VALUE`。
2. 数据库路径：优先 `DOGGIE_DATABASE_PATH`，兼容 `RUST_DATABASE_PATH`，默认 `doggie.db`。
3. 监听地址：优先 `DOGGIE_SERVER_ADDRESS`，兼容 `RUST_SERVER_ADDRESS`，默认 `127.0.0.1:8787`。
4. 模型配置：至少需要 `OPENAI_API_KEY` 和 `OPENAI_MODEL`；可选 `OPENAI_SITE`、`OPENAI_BASE_URL`、`OPENAI_API_MODE`、`OPENAI_TIMEOUT_SECONDS`。
5. 组装顺序：
   - `LlmEndpointConfig::resolve(...)`
   - `LlmHttpTransportConfig::new(...)`
   - `UreqStructuredOutputTransport::new(...)`
   - `StructuredMemoryModel::new(...)`
   - `CanonicalService::initialize(database)`
   - `CanonicalRuntime::new(...)`
   - `AgentHarness` / `AgentChatResponder`
   - `Server::with_chat_responder(...)`
   - `serve(address, server)`

这条路径告诉你：生产运行时使用真实 SQLite 文件和真实模型 transport；普通测试不应走这条真实外部依赖路径。

### 4.2 静态前端资源：`apps/doggie-local-web/src/frontend.rs`

当前 UI 已从 Rust 内嵌大字符串拆出，但仍由 Rust 编译进二进制：

| 路径 | 说明 |
|---|---|
| `apps/doggie-local-web/frontend/index.html` | 页面结构和 DOM 挂载点 |
| `apps/doggie-local-web/frontend/assets/styles.css` | 样式 |
| `apps/doggie-local-web/frontend/assets/app.js` | 前端状态、同源 API 请求、Markdown 安全渲染、事件绑定 |
| `apps/doggie-local-web/src/frontend.rs` | `include_str!` 读取上述文件并暴露静态路由资源 |

`asset_for_path(path)` 只暴露：

- `/`
- `/index.html`
- `/assets/styles.css`
- `/assets/app.js`

当前没有前端构建链；不要为了普通 UI 修改引入 Node/npm/Vite，除非另有明确产品决策。

### 4.3 HTTP server：`apps/doggie-local-web/src/lib.rs`

这里是本地 API 边界。先读这些类型：

| 类型/常量 | 重点 |
|---|---|
| `DEFAULT_BIND_ADDRESS` | 默认 `127.0.0.1:8787` |
| `MAX_HTTP_REQUEST_BYTES` | 请求大小上限 1 MiB |
| `HttpRequest` / `HttpResponse` | 测试和 route dispatcher 使用的最小 HTTP 抽象 |
| `Server<M, C>` | 持有 `CanonicalRuntime<M>` 和 `ChatResponder` |
| `ChatResponder` | 归档完成后生成助手回答的边界；只允许读 canonical memory，不允许重复静默写 Entry |
| `ArchiveAwareChatResponder` | 确定性 fallback 和测试默认 responder |
| `AgentChatResponder<T>` | 生产 responder，通过 `AgentHarness` 使用只读工具回答 |

再读网络实现：

1. `serve(...)`：标准库 `TcpListener` 监听。
2. `handle_connection(...)`：一连接一请求。
3. `read_request(...)`：只处理 HTTP/1.1、`Content-Length`、UTF-8 body；不支持 chunked transfer encoding。
4. `HttpResponse::write_to(...)`：写 `Content-Type`、`Content-Length`、`Connection: close`、`Cache-Control: no-store`。

这是本地单用户 MVP server，不是生产 Web 框架。若未来暴露非 localhost，要重新评估认证、CSRF、CORS、超时、并发和日志脱敏。

## 5. HTTP 路由阅读地图

路由集中在 `Server::handle_request(...)`。阅读时先看 route 表，再跳到 handler。

### 5.1 静态与健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 返回 `index.html` |
| `GET` | `/index.html` | 返回 `index.html` |
| `GET` | `/assets/styles.css` | 返回 CSS |
| `GET` | `/assets/app.js` | 返回 JS |
| `GET` | `/health` | 返回 `{ ok: true, service: "doggie-local-web" }` |

### 5.2 Bucket 与记忆查询

| 方法 | 路径 | Handler | 说明 |
|---|---|---|---|
| `GET` | `/api/buckets/active?limit=N` | `handle_active_buckets` | 活跃 Bucket 列表 |
| `GET` | `/api/buckets/search?q=...&limit=N` | `handle_search` | 搜索 Bucket 和 Entry |
| `GET` | `/api/buckets/{id}` | `handle_bucket_detail` | Bucket、Entry、memory 详情 |
| `DELETE` | `/api/buckets/{id}` | `handle_delete_bucket` | 删除 Bucket 及关联数据 |
| `GET` | `/api/memory/query?q=...&limit=N` | `handle_memory_query` | 自然语言查询，query string 形式 |
| `POST` | `/api/memory/query` | `handle_memory_query_json` | 自然语言查询，JSON body 支持状态/时间/结构化筛选 |

`limit` 默认 20，最大 100；非法值返回稳定 JSON 错误。

### 5.3 归档和聊天

| 方法 | 路径 | Handler | 当前用途 |
|---|---|---|---|
| `POST` | `/api/chat` | `handle_chat` | 主 UI 入口：先归档，再生成助手回复 |
| `GET` | `/api/chat/history?limit=N` | `handle_chat_history` | 读取对话历史，刷新旧归档卡片状态 |
| `POST` | `/api/chat/confirm` | `handle_chat_confirmation` | 主 UI 确认入口：追加、新建或不保存 |
| `POST` | `/api/archive` | `handle_archive` | legacy/直接归档 API |
| `POST` | `/api/archive/append` | `handle_confirmed_append` | legacy 显式追加到已有 Bucket |
| `POST` | `/api/archive/create` | `handle_confirmed_create` | legacy 显式创建 Bucket 并保存 |

维护时要区分两套路径：当前 ChatGPT 风格 UI 走 `/api/chat` 和 `/api/chat/confirm`；直接归档/legacy API 仍有测试覆盖，不能随意删除。

### 5.4 纠错和状态

| 方法 | 路径 | Handler | 说明 |
|---|---|---|---|
| `POST` | `/api/corrections/move` | `handle_move` | 移动 Entry 到目标 Bucket，并记录纠错审计 |
| `POST` | `/api/buckets/status` | `handle_bucket_status` | 设置 Bucket 状态 |

`parse_bucket_status(...)` 当前支持 `active`、`paused`、`done`、`archived`。

## 6. 本地 Web UI 阅读地图

### 6.1 HTML：`frontend/index.html`

先对照 DOM id 建立 UI 地图：

| 区域 | DOM id | 作用 |
|---|---|---|
| 新对话按钮 | `#new-chat` | 清空当前输入和状态，不删除服务端历史 |
| 活跃 Bucket | `#buckets`、`#refresh-buckets` | 左侧 Bucket 列表和刷新按钮 |
| Bucket 详情 | `#detail` | 展示选中 Bucket 的 Entry 和结构化记忆 |
| 语言查询 | `#memory-query`、`#memory-query-button`、`#memory-query-result` | 自然语言查询入口与结果展示 |
| 聊天消息 | `#chat-messages` | 渲染 user/assistant/tool 消息和归档卡片 |
| 输入区 | `#chat-input`、`#chat-send`、`#chat-status` | 发送消息和展示状态 |
| 顶部说明 | `#selected-bucket-label` | 当前显示“自动关联最近和热门 Bucket” |

### 6.2 CSS：`frontend/assets/styles.css`

CSS 目前是无构建静态样式文件。阅读重点不是样式细节，而是确认 class 与 JS 渲染的卡片一致：

- `bucket-card` / `entry`：Bucket 与 Entry 展示。
- `message` / `tool-output`：聊天和工具消息。
- `archive-card` / `needs-confirmation`：归档结果与低信息确认卡片。
- `candidate-card` / `archive-actions`：推荐 Bucket、备选 Bucket、创建和不保存操作。
- `move-entry`：归档后的修改 Bucket 入口。
- `md-code-block` 等 Markdown 样式。

### 6.3 JS：`frontend/assets/app.js`

`app.js` 是前端行为主文件。它目前是紧凑格式，但函数边界清晰。建议阅读顺序：

1. 顶部 DOM 引用和全局状态：`activeBuckets`、`selectedBucketId`、`history`。
2. route 常量：`legacyArchiveRoute`、`legacyConfirmRoutes`、`correctionRoute`。
3. 安全渲染：`escapeHtml`、`safeHref`、`renderInline`、`renderMarkdown`。
4. 请求封装：`jsonRequest`。
5. Bucket 展示：`refreshBuckets`、`showBucket`、`deleteBucket`。
6. 语言查询：`runMemoryQuery`、`renderQueryPlan`、`renderMemoryQuery`。
7. 聊天主流程：`loadHistory`、`sendMessage`、`renderHistory`、`renderMessage`。
8. 归档卡片：`renderArchiveCard`、`confirmArchive`。
9. 归档后纠错：`renderMoveEntryCard`、`moveEntry`。
10. 文件末尾事件绑定：click delegation、Enter 发送、textarea 自动增高、初始化 `Promise.all([refreshBuckets(), loadHistory()])`。

前端安全边界：

- 不要直接把用户或模型原文赋给 `innerHTML`。
- Markdown 渲染必须经过 `escapeHtml` 和 `safeHref`。
- 链接应继续使用 `target="_blank"` 和 `rel="noreferrer noopener"`。
- 不要把 `selectedBucketId` 静默传给 `/api/chat` 作为强制 focus；当前语义是服务端自动关联最近和热门 Bucket。

## 7. Crate-by-crate 代码阅读指南

### 7.1 `doggie-domain`：领域模型和确定性规则

主要文件：

| 文件 | 阅读重点 |
|---|---|
| `src/domain.rs` | `BucketType`、`BucketStatus`、`ClassificationAction`、`BucketView`、`ClassificationResult` |
| `src/memory.rs` | `ArchiveStatus`、`ExtractionResult`、`BucketSummaryResult`、`ArchiveResult` |
| `src/classification.rs` | 候选 Bucket 构造、候选引用校验、置信度门控、低信息门控、分类后处理 |
| `src/text.rs` | Unicode case fold 与文本规范化工具 |
| `src/error.rs` | `CoreError` |
| `src/lib.rs` | 对外 re-export 边界 |
| `tests/classification.rs` | 分类动作一致性、低信息输入、候选排序和置信度回归 |

先建立四个概念：

- `BucketType`：`idea`、`task`、`incident`、`experiment`、`decision`、`meeting`、`knowledge`、`draft`。
- `BucketStatus`：`active`、`paused`、`done`、`archived`。
- `ClassificationAction`：`append_existing`、`create_new`、`ask_user`。
- `ConfidencePolicy`：自动写入门槛与需要确认门槛。

修改分类相关行为时，优先从这里开始，不要只改 prompt 或 route projection。

### 7.2 `doggie-protocol`：不可信 JSON 到可信领域对象的边界

主要文件：

| 文件 | 阅读重点 |
|---|---|
| `src/classification.rs` | `ClassificationContract`、`BucketViewContract`，模型分类输出校验 |
| `src/extraction.rs` | `ExtractionContract`、`BucketSummaryContract`，结构化记忆提取契约 |
| `src/archive.rs` | 归档输入/输出契约 |
| `src/agent.rs` | Agent 工具定义、参数结构、聊天角色契约 |
| `src/structured_output.rs` | `StructuredOutputContract` 和 JSON Schema 生成 |
| `src/timestamp.rs`、`src/values.rs` | 时间与枚举字符串解析边界 |
| `tests/contract_fixtures.rs` | 契约 fixture、未知字段拒绝、schema 形状回归 |

阅读原则：

- 外部模型输出必须经过 strict contract。
- 未知字段和非法枚举不应被静默接受。
- contract 转领域对象时还会触发 `doggie-domain` 的跨字段一致性校验。
- 工具 contract 里可能保留写工具定义，但当前 `/api/chat` responder 只开放只读工具。

### 7.3 `doggie-storage-sqlite`：canonical SQLite 持久层

主要文件：

| 文件 | 阅读重点 |
|---|---|
| `src/canonical.rs` | 当前本地 Web 主线使用的 `DoggieStore`、canonical projection 类型和核心读写事务 |
| `src/canonical_schema.rs` | 当前 Doggie-owned schema 定义、表、索引、外键和 schema 校验 |
| `src/records.rs` | 兼容 store 使用的 `StoredBucket`、`StoredEntry`、`StoredChatMessage` 等记录类型 |
| `src/read.rs`、`src/write.rs` | 旧 schema 兼容读写边界；当前 local web 主线优先看 `DoggieStore` |
| `src/archive_write.rs`、`src/bucket_write.rs`、`src/entry_write.rs`、`src/extraction_write.rs` | 兼容服务的细粒度写入构件；理解历史边界时再读 |
| `src/classification_write.rs`、`src/chat_write.rs`、`src/correction_write.rs`、`src/delete_write.rs` | 兼容服务的审计、聊天、纠错和删除写入构件 |
| `src/bucket_summary_write.rs` | Bucket summary 更新/重建辅助逻辑 |
| `src/migration.rs` | schema 检查、迁移、备份恢复 |
| `src/legacy_import.rs` | 历史数据库只读导入到 canonical schema |
| `tests/canonical_store.rs` | canonical store 事务、读写、删除、聊天历史回归 |
| `tests/store_validation.rs` | schema 检查、迁移、legacy import 回归 |

核心 canonical 表可从 `canonical_schema.rs` 开始看：

- `buckets`
- `entries`
- `bucket_tags`
- `memory_items`
- `archive_attempts`
- `corrections`
- `conversation_messages`
- `rust_schema_meta`
- `rust_schema_migrations`

`memory_items` 用 `kind` 区分 `todo`、`evidence`、`timeline`、`decision`、`hypothesis`、`entity`、`tag`，取代旧 schema 中多张结构化子表在主线代码里的直接使用。

重点不变量：

- 归档写入要在事务里完成 Bucket/Entry/memory/audit/attempt 状态。
- 低信息 `ask_user` 不应创建正式 Entry。
- 确认写入必须绑定 pending attempt，并保留原文和审计。
- 删除 Bucket 会影响 Entry、memory、attempt、correction 等关联数据；这是破坏性操作。
- 普通测试应使用临时 SQLite 文件，不调用真实用户数据库。

### 7.4 `doggie-application`：业务服务 facade

主要文件：

| 文件 | 阅读重点 |
|---|---|
| `src/canonical.rs` | `CanonicalService` 主 facade，初始化 store，组合归档/查询/聊天/纠错能力 |
| `src/archive.rs` | `ArchiveService`，候选生成、分类审计和归档服务边界 |
| `src/query.rs` | `MemoryQuery`、查询计划解析、时间/状态/结构化筛选和聚合 |
| `src/chat.rs` | 聊天消息保存和历史读取 |
| `src/correction.rs` | Entry 移动和纠错审计 |
| `src/mutation.rs` | Bucket 状态等 mutation |
| `src/classification.rs` | 分类审计持久化 service |
| `src/extraction.rs` | 结构化提取结果持久化 service |
| `src/summary.rs` | Bucket summary service |
| `tests/canonical.rs` | facade 覆盖归档、对话、纠错、删除、候选排序 |
| `tests/natural_language_query.rs` | 自然语言查询计划、状态/时间/结构化筛选、聚合回归 |

阅读重点：

- `CanonicalService::initialize(...)` 是应用层入口。
- 候选 Bucket 来自最近和热门活跃 Bucket 的排序，不由前端选中项强制决定。
- 查询计划会拆实体、主题、时间范围、状态和结构化字段。
- 状态变更、Entry 移动、聊天历史都通过 service facade 调 store。

### 7.5 `doggie-llm`：模型端点和 wire response 适配

主要文件：

| 文件 | 阅读重点 |
|---|---|
| `src/config.rs` | `LlmEndpointConfig`、`LlmApiMode`、官方/兼容 base URL 解析 |
| `src/http_transport.rs` | `UreqStructuredOutputTransport`、timeout/proxy 配置、HTTP 请求执行 |
| `src/structured_output.rs` | `StructuredOutputTransport` trait、`StructuredOutputAdapter`、request/response 类型、重试边界 |
| `src/wire_response.rs` | Responses 与 Chat Completions 响应归一化，tool calls 解析 |
| `tests/http_transport.rs` | HTTP transport、endpoint 和错误映射测试 |
| `tests/structured_output.rs` | Structured Outputs 请求、schema 和重试测试 |

阅读重点：

- `doggie-llm` 不知道 SQLite 和 HTTP route。
- 它只把应用给定的 prompt/schema/input 变成模型请求，并把 wire response 归一化。
- Responses API 与 Chat Completions 的差异在这里收敛，不应扩散到业务层。

### 7.6 `doggie-agent-runtime`：受控工具 Harness

主要文件：

| 文件 | 阅读重点 |
|---|---|
| `src/lib.rs` | `AgentHarness`、`AgentHarnessRequest`、`AgentHarnessResult`、tool allow-list、上下文组装和限制常量 |
| `tests/agent_harness.rs` | 工具调用轮次、allow-list、参数校验、Responses/Chat 两种 wire shape、错误作为数据返回 |

关键常量：

- `DEFAULT_AGENT_MAX_TOOL_ROUNDS`
- `MAX_AGENT_TOOL_ROUNDS`
- `MAX_AGENT_TOOL_CALLS_PER_ROUND`
- `MAX_AGENT_TOOL_ARGUMENT_BYTES`
- `MAX_AGENT_TOOL_OUTPUT_BYTES`
- `MAX_AGENT_MEMORY_CONTEXT_BYTES`
- `MAX_AGENT_HISTORY_MESSAGES`
- `MAX_AGENT_HISTORY_MESSAGE_BYTES`

当前 server 聊天回答阶段使用 `CHAT_AGENT_SYSTEM_PROMPT`，并只允许：

- `list_active_buckets`
- `search_memory`
- `get_bucket_detail`

不要让模型在聊天回答阶段调用写工具。写入只能由 server 的归档/确认流程完成。

### 7.7 `doggie-engine`：端到端归档编排和 projection

主要文件：

| 文件 | 阅读重点 |
|---|---|
| `src/lib.rs` | `MemoryModel` trait、`StructuredMemoryModel`、`CanonicalRuntime`、`ArchiveExecution`、JSON projection helpers、`RuntimeError` |
| `tests/runtime.rs` | 自动 append/create、ask_user、确认写入、错误映射和 projection 回归 |

阅读顺序：

1. `MemoryModel`：分类、提取、summary 的模型抽象。
2. `StructuredMemoryModel<T>`：把 `doggie-llm` transport 接入 `MemoryModel`。
3. `CanonicalArchiveCoordinator`：协调分类、提取、写入和确认。
4. `CanonicalRuntime`：server 直接使用的运行时 facade。
5. `archive_execution_to_value(...)`、`active_buckets(...)`、`search_memory(...)`、`query_memory_with_plan(...)`、`bucket_detail(...)`：HTTP/UI projection。
6. `RuntimeError`：统一错误边界，再由 server 映射到 HTTP。

这里是端到端归档语义最集中的地方。新增 archive state、confirmation action 或 projection 字段时，通常需要同步改 engine、server、UI 和测试。

### 7.8 `doggie-local-web`：本地 HTTP API 与静态 Web UI

主要文件：

| 文件 | 阅读重点 |
|---|---|
| `src/main.rs` | 进程入口、配置解析、runtime/responder/server 组装 |
| `src/frontend.rs` | 静态资源 include 和 path 映射 |
| `src/lib.rs` | HTTP server、routes、chat responder、确认安全门控、错误映射、route 测试 |
| `frontend/README.md` | 当前前端边界：无构建、静态资源、同源 API |
| `frontend/index.html` | DOM 挂载点 |
| `frontend/assets/styles.css` | UI 样式 |
| `frontend/assets/app.js` | 前端状态、请求、安全 Markdown、归档卡片、事件绑定 |
| `tests/ui_contract.rs` | 静态前端契约、安全渲染和 UI/API 连接点测试 |

`src/lib.rs` 较长，建议不要从头逐行读。按以下路径读：

1. 顶部类型：`ChatResponder`、`ArchiveAwareChatResponder`、`AgentChatResponder`。
2. `Server::handle_request`：全 route map。
3. `/api/chat`：`handle_chat`。
4. `/api/chat/confirm`：`handle_chat_confirmation`。
5. `decorate_chat_archive`、`archive_assistant_text`、`confirmation_assistant_text`。
6. `hydrate_chat_archive_message`：历史恢复时刷新旧归档卡片状态。
7. `execute_read_only_agent_tool`：聊天回答阶段的只读工具执行器。
8. legacy archive、query、bucket、move/status handlers。
9. helper：JSON/limit/status/filter/percent decode/error mapping。
10. `#[cfg(test)]` 测试模块。

## 8. 横向业务流程阅读路线

### 8.1 用户发送消息到自动归档

阅读路径：

```text
frontend/assets/app.js::sendMessage
  → POST /api/chat
  → apps/doggie-local-web/src/lib.rs::handle_chat
  → doggie-engine::CanonicalRuntime::archive
  → doggie-application::CanonicalService
  → doggie-domain classification gates
  → doggie-protocol contracts / doggie-llm model adapter
  → doggie-storage-sqlite transaction
  → doggie-engine::archive_execution_to_value
  → decorate_chat_archive
  → ChatResponder / AgentChatResponder
  → doggie-storage-sqlite chat history
  → app.js::loadHistory / renderHistory
```

重点检查：

- user message 会先持久化为聊天历史。
- 归档 pipeline 总是在助手回答前执行。
- 如果已经自动保存，返回 `archive_state = archived`，并提供 Entry/Bucket 信息和“修改 Bucket”入口。
- 如果需要确认，不能写正式 Entry，返回确认卡片。

### 8.2 低信息输入与确认归档

阅读路径：

```text
doggie-domain::apply_low_information_reference_gate / postprocess_classification
  → doggie-engine::CanonicalRuntime::archive
  → doggie-storage-sqlite archive_attempts
  → apps/doggie-local-web::decorate_chat_archive
  → app.js::renderArchiveCard
  → app.js::confirmArchive
  → POST /api/chat/confirm
  → apps/doggie-local-web::handle_chat_confirmation
  → CanonicalRuntime::append_confirmed_for_attempt / create_confirmed_for_attempt
  → service.discard_archive_attempt for discard
```

必须保留的用户可见元素：

- `ask_user` / `needs_confirmation` 安全门控。
- 推荐 Bucket。
- 备选 Bucket。
- 判断理由和问题。
- 创建新 Bucket。
- 不保存。
- attempt id 与原始 text 的可重放绑定。

确认安全检查：

- `attempt_id` 必须存在。
- attempt 必须 pending、未 resolved、未 corrected。
- 原始 `text` 必须完全一致。
- append 目标 Bucket 必须存在且 active。
- 冲突类错误映射到 HTTP 409。

### 8.3 归档后的修改 Bucket

阅读路径：

```text
archive_execution_to_value / decorate_chat_archive
  → app.js::renderMoveEntryCard
  → app.js::moveEntry
  → POST /api/corrections/move
  → apps/doggie-local-web::handle_move
  → doggie-application::CorrectionService
  → doggie-storage-sqlite::correction_write
```

重点：

- 修改 Bucket 是纠错审计，不是重新静默归档。
- payload 包含 `entry_id`、`target_bucket_id` 和 `command_text`。
- 前端默认文案是“用户在对话中修改了 Bucket。”。

### 8.4 聊天回答与只读工具

阅读路径：

```text
handle_chat
  → recent chat history
  → AgentChatResponder::respond
  → AgentHarness
  → execute_read_only_agent_tool
  → active_buckets / search_memory / bucket_detail
  → agent_result_to_chat_result
  → chat_tool_message_to_value
  → chat history persistence
```

边界：

- responder 可以读取 canonical memory。
- responder 不允许重复写本轮 Entry。
- `execute_read_only_agent_tool` 明确拒绝 `archive_memory`、`save_to_existing_bucket`、`create_bucket_and_save` 等写工具。
- 当 archive state 是 `needs_confirmation`，server 会强制使用 `archive_assistant_text(...)`，防止 conversational LLM 覆盖安全门控文案。

### 8.5 自然语言记忆查询

阅读路径：

```text
app.js::runMemoryQuery
  → GET /api/memory/query 或 POST /api/memory/query
  → apps/doggie-local-web::handle_memory_query(_json)
  → doggie-application::MemoryQuery::parse
  → query_memory_with_plan
  → doggie-storage-sqlite search/query projection
  → app.js::renderQueryPlan / renderMemoryQuery
```

重点：

- 查询会拆实体、主题、时间范围、状态和结构化字段。
- 结果以 Entry 为证据单元，可跨多个 Bucket 聚合。
- evidence 需要去重并保留来源。

### 8.6 Bucket 删除和状态变更

删除路径：

```text
app.js::deleteBucket
  → DELETE /api/buckets/{id}
  → apps/doggie-local-web::handle_delete_bucket
  → doggie-application / doggie-storage-sqlite delete write
  → refreshBuckets + loadHistory
```

状态路径：

```text
POST /api/buckets/status
  → parse_bucket_status
  → CanonicalService mutation
  → storage write
```

注意：删除是破坏性 API。前端有浏览器 `confirm(...)`，但后端没有额外二次确认字段；如果未来开放非本地环境，应增加后端确认和鉴权。

### 8.7 schema、迁移和历史导入

阅读路径：

```text
canonical_schema.rs
  → migration.rs
  → canonical.rs / write modules
  → legacy_import.rs
  → tests/store_validation.rs
  → docs/SQLITE_MIGRATIONS.md
```

重点：

- canonical schema 是当前生产事实来源。
- 旧库兼容只能以 Rust 只读导入方式保留。
- schema 修改要更新迁移、验证、测试计划和文档。

## 9. 测试阅读索引

### 9.1 按 crate 阅读测试

| 路径 | 覆盖重点 |
|---|---|
| `crates/doggie-domain/tests/classification.rs` | 分类动作一致性、低信息门控、候选引用和置信度策略 |
| `crates/doggie-protocol/tests/contract_fixtures.rs` | 严格字段、未知字段拒绝、JSON Schema 和 contract fixture |
| `crates/doggie-storage-sqlite/tests/canonical_store.rs` | canonical store 事务、重开数据库、查询、删除、聊天历史、纠错 |
| `crates/doggie-storage-sqlite/tests/store_validation.rs` | schema inspect/migrate/restore、legacy import 校验 |
| `crates/doggie-application/tests/canonical.rs` | service facade、候选排序、归档/对话/纠错/删除组合行为 |
| `crates/doggie-application/tests/natural_language_query.rs` | 查询计划、时间/状态/结构化筛选、多 Bucket 聚合 |
| `crates/doggie-llm/tests/http_transport.rs` | HTTP transport、endpoint 配置、错误处理 |
| `crates/doggie-llm/tests/structured_output.rs` | Structured Outputs schema、请求 shape、重试 |
| `crates/doggie-agent-runtime/tests/agent_harness.rs` | tool loop、allow-list、只读/写工具边界、wire response 兼容 |
| `crates/doggie-engine/tests/runtime.rs` | runtime 自动归档、确认分支、projection、错误 |
| `apps/doggie-local-web/tests/ui_contract.rs` | 前端静态资源、Markdown 安全、UI/API 契约 |
| `apps/doggie-local-web/src/lib.rs` 内测试 | HTTP routes、聊天历史、确认绑定、删除 Bucket、错误 JSON |

### 9.2 修改场景对应测试

| 修改内容 | 至少阅读/运行 |
|---|---|
| 分类、低信息或置信度 | `doggie-domain/tests/classification.rs`、`doggie-engine/tests/runtime.rs`、server 确认相关测试 |
| 模型输出 schema 或 prompt 输入 | `doggie-protocol/tests/contract_fixtures.rs`、`doggie-llm/tests/structured_output.rs`、`docs/PROMPTS.md` |
| 归档写入、确认、attempt | `doggie-engine/tests/runtime.rs`、`doggie-storage-sqlite/tests/canonical_store.rs`、`apps/doggie-local-web/src/lib.rs` 确认测试 |
| 自然语言查询 | `doggie-application/tests/natural_language_query.rs`、server `/api/memory/query` 测试、前端查询渲染 |
| schema/迁移/导入 | `doggie-storage-sqlite/tests/store_validation.rs`、`docs/SQLITE_MIGRATIONS.md`、`docs/TEST_PLAN.md` |
| 聊天回答/Agent 工具 | `doggie-agent-runtime/tests/agent_harness.rs`、server `execute_read_only_agent_tool` 相关测试 |
| Web UI | `apps/doggie-local-web/tests/ui_contract.rs`、server 静态资源测试 |
| HTTP route 或错误 | `apps/doggie-local-web/src/lib.rs` 内 route/error 测试 |

常用检查命令：

```bash
cargo fmt --all -- --check
cargo check --workspace --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
cargo test --workspace --offline
```

如需在线解析新依赖，可去掉 `--offline`；普通回归不应调用真实模型或真实用户数据库。

## 10. 修改代码时的安全边界

### 10.1 归档安全门控

任何用户可见归档流程都必须保留：

- `ask_user` 安全门控。
- 推荐 Bucket、备选 Bucket、判断理由。
- 创建新 Bucket 和不保存选项。
- 归档后的 Bucket 修改入口。
- Entry 原文、结构化 memory、审计记录。
- 可重放的确认绑定：`attempt_id` + 原始 text。

低信息输入宁愿多询问一次，也不能静默写入不确定 Bucket。

### 10.2 前端安全渲染

`app.js` 的 Markdown renderer 是安全边界。修改时必须维持：

- escape-first。
- `safeHref` 过滤链接。
- 不允许直接渲染未转义 HTML。
- 不新增第二套绕过测试的 Markdown renderer。
- 不通过 innerHTML 直接注入用户/模型原文。

### 10.3 聊天回答阶段不能写记忆

当前 `/api/chat` 的写入顺序由 server 控制：先归档，再回答。`AgentChatResponder` 只能通过只读工具读取记忆。不要让 conversational LLM 在同一轮里重复归档、创建 Bucket 或写 Entry。

### 10.4 本地 server 边界

当前 server 默认绑定 localhost，且实现是标准库最小 HTTP/1.1。不要默认假设它已经具备生产 Web 安全能力。开放到局域网或公网前，至少需要重新设计：

- 鉴权。
- CSRF/CORS。
- 请求超时和并发模型。
- body streaming/chunked 支持。
- 静态资源缓存策略。
- 日志脱敏。
- 删除/状态变更等破坏性 API 的后端确认。

### 10.5 历史恢复与确认卡片

`hydrate_chat_archive_message(...)` 是重启/刷新后确认卡片仍然正确的关键。修改 archive attempt 或 confirmation 状态时，要检查：

- 已 resolved attempt 不应继续显示可点击确认按钮。
- archived 后应能补充 Bucket detail 和 `move_entry` 操作。
- discard 后应显示不保存状态，不应创建 Entry。
- 删除目标 Bucket 后，pending attempt 不应被错误 resolve。

## 11. 快速定位表

| 想找什么 | 先看哪里 |
|---|---|
| 如何运行 | `README.md`、`apps/doggie-local-web/src/main.rs` |
| UI 静态资源如何服务 | `apps/doggie-local-web/frontend/README.md`、`src/frontend.rs` |
| `/api/chat` 做了什么 | `apps/doggie-local-web/src/lib.rs::handle_chat` |
| 确认卡片从哪里来 | `decorate_chat_archive`、`app.js::renderArchiveCard` |
| 确认写入如何防冲突 | `handle_chat_confirmation`、`doggie-engine::CanonicalRuntime`、store attempt 写入 |
| 低信息为什么不保存 | `doggie-domain/src/classification.rs` |
| 候选 Bucket 如何生成 | `doggie-domain::build_bucket_candidates`、`doggie-application/src/archive.rs` |
| 模型输出字段在哪里定义 | `doggie-protocol/src/classification.rs`、`extraction.rs`、`structured_output.rs` |
| SQLite 表在哪里定义 | `doggie-storage-sqlite/src/canonical_schema.rs` |
| Entry/memory 如何写入 | `doggie-storage-sqlite/src/archive_write.rs` 及细粒度 write modules |
| 自然语言查询如何解析 | `doggie-application/src/query.rs` |
| Agent 工具如何限制 | `doggie-agent-runtime/src/lib.rs`、`apps/doggie-local-web/src/lib.rs::execute_read_only_agent_tool` |
| 模型 HTTP 请求在哪里适配 | `doggie-llm/src/http_transport.rs`、`structured_output.rs`、`wire_response.rs` |
| HTTP 错误如何映射 | `apps/doggie-local-web/src/lib.rs::runtime_error_response` |
| 前端 XSS 风险在哪里防 | `app.js::escapeHtml`、`safeHref`、`renderMarkdown`、`tests/ui_contract.rs` |
| 删除 Bucket 的影响 | `apps/doggie-local-web::handle_delete_bucket`、`doggie-storage-sqlite/src/delete_write.rs` |
| 测试计划 | `docs/TEST_PLAN.md` |
| 数据模型说明 | `docs/DATA_MODEL.md` |
| 总体架构说明 | `docs/ARCHITECTURE.md`、`docs/PROJECT_GUIDE.md` |

## 12. 推荐的第一次源码走读练习

如果要确认自己已经读懂当前架构，可以做这条只读练习：

1. 在 `frontend/index.html` 找到 `#chat-input` 和 `#chat-send`。
2. 在 `app.js` 找到 `sendMessage()`，确认请求发往 `/api/chat`，且不把左侧选中的 Bucket 强行传入 focus。
3. 在 `apps/doggie-local-web/src/lib.rs` 找到 `handle_chat()`，确认它先保存 user message，再调用 `runtime.archive(...)`。
4. 在 `doggie-engine/src/lib.rs` 找到 `CanonicalRuntime` 的归档路径，确认自动 append/create 与 ask_user 的分支。
5. 在 `doggie-domain/src/classification.rs` 找到低信息门控。
6. 在 `doggie-storage-sqlite/src/canonical_schema.rs` 找到 `archive_attempts` 和 Entry/memory 相关表。
7. 回到 `handle_chat_confirmation()`，确认 pending attempt、原始 text、目标 Bucket active 的校验。
8. 回到 `app.js` 找到 `confirmArchive()`，确认 append/create/discard 的 payload。
9. 读 `apps/doggie-local-web/src/lib.rs` 中 `chat_confirmation_*` 测试，验证你理解的行为是否被测试锁住。

完成这条练习后，再根据具体任务选择本文第 8、9、10 节对应路径深入阅读。
