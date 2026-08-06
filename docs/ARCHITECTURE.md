# Rust Work Memory MVP 架构

## 1. 组件

```text
浏览器 / curl
      │ HTTP
      ▼
work-memory-server
      │ 路由、JSON 校验、错误映射、ChatGPT 风格内嵌 UI
      ├── ChatResponder（默认确定性 fallback / 生产 AgentHarness）
      │       └── 只读 Bucket、Entry 和自然语言记忆查询工具
      ▼
CanonicalRuntime<M>
      │
      ├── MemoryModel
      │     ├── StructuredOutputAdapter
      │     └── UreqStructuredOutputTransport
      │
      ├── 候选构造与置信度/低信息门控
      └── CanonicalService
              │
              ├── 归档、详情、纠错和状态变更
              ├── MemoryQuery 解析、筛选、排序和结果聚合
              ▼
        RustStore / SQLite
```

crate 职责：

- `work-memory-core`：Bucket、分类结果、提取结果、状态和确定性安全规则。
- `work-memory-contracts`：分类与提取的严格 JSON Schema，以及模型输出到领域值的校验。
- `work-memory-agent`：结构化模型请求、端点配置、HTTP transport 和重试边界。
- `work-memory-store`：Rust-owned SQLite schema、事务和持久化投影。
- `work-memory-service`：对 runtime 暴露稳定的归档、查询、纠错和状态服务。
- `work-memory-runtime`：组合模型调用、门控和归档闭环，并生成 API 投影。
- `work-memory-server`：单进程 HTTP listener、路由和内嵌 Web UI。

## 2. 请求数据流

### 2.1 自动归档

1. server 解析 `POST /api/archive` 的 JSON，要求非空 `text`。
2. runtime 从 SQLite 读取活跃 Bucket，按活动时间排序，并把可选 `focus_bucket_id` 放在候选首位。
3. `MemoryModel::classify` 收到文本和候选投影。
4. runtime 先校验模型返回的 Bucket ID，再执行候选数量、置信度和低信息引用门控。
5. `ask_user` 直接写 archive attempt；其他动作调用 `MemoryModel::extract`。
6. service 在单一 SQLite 事务中创建/选择 Bucket、写 Entry、写 memory items、更新摘要和保存审计。
7. runtime 读取最终 Bucket，server 返回结构化 JSON，UI 用同一结果显示状态。

### 2.2 确认写入

`/api/archive/append` 和 `/api/archive/create` 在路由层要求 `confirmation_granted: true`，然后调用独立 runtime 方法。确认路径不重新接受模型分类结果：目标 Bucket、标题和类型直接来自用户已确认的请求。

### 2.3 ChatGPT 风格对话与自动归档

Rust server 的聊天入口把长期对话、归档安全门控和自然语言回答串成同一条时间线：

```text
POST /api/chat
  → 先写入 conversation_messages(user)
  → CanonicalRuntime.archive(text, focus_bucket_id)
  → archived：事务性创建/追加 Entry
  → needs_confirmation：只保留 archive attempt，不创建正式 Entry
  → ChatResponder / AgentHarness 生成回答
       ├── 只允许读取 Bucket、Entry 和查询结果
       └── 禁止再次执行写工具，避免同一轮重复归档
  → 写入 tool 消息和 conversation_messages(assistant)
```

`GET /api/chat/history` 按最近窗口读取消息，但返回时保持 `sequence` 升序，因此刷新页面可以恢复完整对话。`POST /api/chat/confirm` 接收 `append`、`create` 或 `discard`，由用户显式选择推荐 Bucket、备选 Bucket、创建新 Bucket 或不保存。低信息输入的 assistant 文本和 `archive` 结构化详情必须同时呈现推荐 Bucket、备选 Bucket、模型判断理由、四种操作和后续“修改 Bucket”入口；不能因为模型 confidence 较高就跳过确认。

聊天阶段使用 `AgentHarness` 时，`search_memory` 委托给 Entry 级 `query_memory`，可识别实体、主题、时间范围和状态，并返回多 Bucket 合并结果、排序字段和去重证据。自动归档已经由 server 完成，Harness 的写入工具只返回明确错误；用户确认后的写入只能通过确认路由执行。

### 2.4 自然语言查询

`GET /api/memory/query` 和 `POST /api/memory/query` 都进入 canonical service 的查询路径。查询是 model-independent 的，不调用 `MemoryModel`：

```text
自然语言 query
  → MemoryQuery 解析 query plan
  → Bucket 状态与 Entry.created_at 时间过滤
  → Bucket 名称/摘要/标签、Entry 原文/summary、memory entity/tag 等字段评分
  → Entry 级结果排序
  → 按 Bucket 分组
  → evidence 确定性去重
  → 确定性 answer 摘要
```

`MemoryQuery` 当前包含 `raw_text`、`terms`、`entity_terms`、`topic_terms`、`bucket_terms`、`time_range`、`statuses`、`structured_filters` 和 `limit`。`time_range` 是半开区间 `[start, end)`；执行时唯一用于时间筛选的记录时间是 `Entry.created_at`，不是结构化 memory 的 `occurred_at`。相对时间按当前 UTC 解析。

结果以 `MemorySearchHit` 表示，每个命中 Entry 保留所属 Bucket、Entry、该 Entry 的 memory、`matched_fields`、`keyword_score`、`semantic_score` 和总分。因此一个 Bucket 可有多条命中 Entry，响应也可以把多个 Bucket 合并到同一份结果中。`MemoryBucketGroup` 只提供结果分组和 `matched_entry_count` / `top_score`，不替换 Entry 级结果。

当前 `semantic_score` 只是响应字段名，实际是基于字符串包含、命中比例和完整短语命中的 lexical similarity，不是 embedding 或向量检索。排序还加入确定性的关键词分数和 Entry 新近程度；当前没有模型重排。`evidence` 按 memory kind 与 Unicode case-fold 后的 trimmed text 去重，`answer` 由 runtime 根据结果数量、Bucket 数量和前几条摘要确定性生成，不经过 LLM。

`CanonicalService::query_memory` 负责从自然语言生成计划并执行查询，`query_memory_with_plan` 接受 HTTP 客户端或其他调用方已经补充筛选条件的计划。runtime 只负责把 `MemorySearchResponse` 投影为 HTTP/UI/Agent 可消费的 JSON。

### 2.4 旧查询与纠错

读取接口通过 `CanonicalService` 生成 Bucket 列表、旧搜索投影、自然语言查询结果和详情。旧 `CanonicalService::search` 及 `GET /api/buckets/search` 保持 Bucket 级契约，返回 Bucket、匹配 Entry 数和分数；它不被新 Entry 级查询响应替换。纠错接口把 Entry 移动、派生 memory 关系、Bucket 摘要刷新和 correction audit 放在同一个 store transaction 中。

## 3. SQLite 数据边界

核心持久化对象：

- `buckets`：标题、类型、状态、摘要、标签和活动时间。
- `entries`：用户原文、摘要、分类元数据、`created_at` 和所属 Bucket。
- `memory_items`：todo、evidence、timeline、decision、hypothesis、entity、tag。
- `archive_attempts`：每次分类请求的动作、置信度、候选、问题、模型和最终状态。
- `corrections`：Entry 移动的前后关系和用户命令文本。

原始 Entry 是事实来源；memory item 和 Bucket summary 是可追溯派生数据。所有写入由 Rust service 生成 ID 并使用显式事务，runtime 不直接拼 SQL。

## 4. 模型边界

`MemoryModel` 是 runtime 的最小模型接口：

```rust
trait MemoryModel {
    type Error: Display;

    fn classify(
        &mut self,
        text: &str,
        candidates: &[BucketView],
    ) -> Result<ClassificationResult, Self::Error>;

    fn extract(&mut self, text: &str) -> Result<ExtractionResult, Self::Error>;
}
```

生产实现使用严格结构化输出：

- 分类请求只携带用户文本和服务端候选 Bucket。
- 提取请求只携带用户文本。
- 模型响应必须通过 contract schema 和领域不变量校验。
- 网络、临时 HTTP 状态、缺失输出、非法 JSON 等失败在 adapter 的有限重试策略内处理。
- 模型永远不能绕过 runtime 的候选 ID 校验和置信度门控。

## 5. 事务与错误处理

- 自动归档的正式写入要么完整提交，要么不留下 Entry 和 memory item。
- `ask_user` 是有意的持久化状态：它只留下 archive attempt，等待下一次显式确认；聊天确认前不会产生正式 Entry。
- `/api/chat` 即使分类或聊天模型失败，也保留已经接收的 user 消息，并尝试写入 assistant 错误消息，便于用户看到失败原因而不是静默丢失输入。
- 目标 Bucket 不存在、字段为空、分类契约不一致和未知状态会返回 4xx 级 JSON 错误。
- SQLite、模型 transport 和内部持久化错误不会伪装成成功响应。
- 服务端默认使用单进程顺序处理连接；MVP 不承诺多进程并发写入协调。

## 6. HTTP 表面

| 路径 | 责任 |
|---|---|
| `POST /api/chat` | 持久化 user 消息，执行自动归档并返回 assistant、tool 和归档状态 |
| `GET /api/chat/history` | 恢复最近聊天消息，按 sequence 升序返回 |
| `POST /api/chat/confirm` | 显式确认追加、创建新 Bucket 或不保存 |
| `POST /api/archive` | 兼容的纯归档入口：分类、门控、提取、归档或创建确认待办 |
| `POST /api/archive/append` | 用户确认后追加 |
| `POST /api/archive/create` | 用户确认后新建 |
| `GET /api/buckets/active` | 活跃 Bucket 列表 |
| `GET /api/buckets/search` | Bucket/Entry 搜索 |
| `GET /api/memory/query` | 自然语言查询，返回查询计划、Entry 命中、多 Bucket 分组、evidence 和 answer |
| `POST /api/memory/query` | 自然语言查询加显式状态、时间和结构化字段筛选 |
| `GET /api/buckets/:id` | Bucket 详情 |
| `POST /api/buckets/status` | 状态变更 |
| `POST /api/corrections/move` | Entry 移动和纠错审计 |
| `GET /health` | 进程健康检查 |

## 7. 安全边界

这是本地单用户 MVP：

- 默认绑定 loopback；
- 没有内置用户认证、授权、TLS、CSRF、限流或多租户；
- `confirmation_granted` 只表示业务确认，不是认证凭证；
- 监听地址可被其他进程访问时，它们也能读取和修改该数据库；
- 不应直接绑定公网地址，生产部署必须由认证和 TLS 反向代理保护。

模型 API Key 只从进程环境读取，错误信息和调试输出不得打印密钥。数据库路径应指向专用 Rust SQLite 文件，备份时保留 SQLite 文件和应用停止时的一致性。

## 8. 实现状态与边界

Rust canonical store/service/runtime/server 是当前唯一的目标实现。Python 版本已放弃作为目标运行路径，仓库中残留的 Python 代码、fixture 和迁移说明仅作历史或兼容参考；本阶段不新增 Python 实现测试。自然语言查询、Entry 级结果、多 Bucket 合并、evidence 去重和确定性 answer 均以 Rust 实现与 Rust 测试为准。

## 9. 可测试性

runtime 依赖 `MemoryModel` trait，因此测试可以注入固定的分类与提取结果，不调用真实模型。主要验证层级：

- core：分类契约、候选排序、置信度门控和低信息引用规则；
- store/service：事务、重开数据库、搜索、详情、移动和状态变更；
- runtime：完整 archive loop、确认分支和结果投影；
- server：路由、JSON 校验、错误映射和内嵌 UI。
