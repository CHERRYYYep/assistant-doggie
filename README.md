# Rust Work Memory MVP

一个面向个人工作的本地长期事务记忆 Agent。用户输入日志、想法、会议结论、实验记录或排障事实后，Rust runtime 会完成：

```text
输入文本 → 分类已有/新建 Bucket → 结构化提取 → SQLite 持久化 → 返回归档结果 → 查看 Bucket
```

`work-memory-server` 是唯一的应用入口，提供本地 HTTP API 和内嵌 Web UI。默认只监听 `127.0.0.1`，数据库默认写入 `rust-work-memory.db`。

## 实现状态

Rust canonical store/service/runtime/server 是当前唯一的目标实现。早期 Python 版本已放弃为目标运行路径，相关代码、fixture 和说明仅保留作历史或兼容参考；本阶段不新增 Python 实现或 Python 查询测试，新的自然语言记忆查询验证全部以 Rust 为准。

## MVP 行为

- `append_existing`：把内容追加到一个明确匹配的活跃 Bucket。
- `create_new`：为新事务创建 Bucket，并保存第一条 Entry。
- `ask_user`：分类不够安全时只保存归档尝试，不创建正式 Entry。低信息输入（例如“压测结果更新了”“切备用后好了”“它现在正常了”）即使模型给出高 confidence，也必须先确认。
- 自动归档要求候选唯一且 `confidence >= 0.85`；低信息门控优先于 confidence。
- `0.55 <= confidence < 0.85` 或存在多个候选时请求确认；低于 `0.55` 也不会自动写入。
- 空工作区中的新 Bucket 仍需通过相同的置信度门控；纯指代或低信息状态输入不能直接创建。
- 确认响应同时提供推荐 Bucket、备选 Bucket、模型理由和问题；`bucket_title` / `bucket_type` 只表示建议创建的新 Bucket，不伪装已有 Bucket 元数据。
- 内嵌 UI 提供“保存到推荐 Bucket / 保存到其他 Bucket / 创建新的 Bucket / 不保存”四条路径，并在归档后提供修改 Bucket 的入口。
- 每条正式 Entry 保存原文，并可保存 `summary`、`todo`、`evidence`、`timeline`、`decision`、`hypothesis`、`entity` 和 `tag` memory item。
- 归档尝试、分类原因、候选 Bucket、模型名和 Prompt 版本写入审计记录。
- 支持显式确认追加、显式确认新建、移动 Entry 和更新 Bucket 状态。

## 快速开始

需要 Rust 1.85 或更新版本，以及一个支持 Structured Outputs 的模型端点。

```bash
cp .env.example .env
# 编辑 .env，至少填写 OPENAI_API_KEY 和 OPENAI_MODEL
cargo run -p work-memory-server
```

服务启动后打开 `http://127.0.0.1:8787/`。程序会自动读取当前工作目录下的 `.env`；如果同时设置了 shell 环境变量，shell 环境变量优先。

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
| `GET` | `/api/memory/query?q=接口%20A%20最近两周的压测结果&limit=20` | 自然语言查询，返回 Entry 级结果 |
| `POST` | `/api/memory/query` | 以查询文本和显式筛选条件执行自然语言查询 |
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

需要确认时，响应 `archive_state` 为 `needs_confirmation`，并返回 `recommended_bucket_id`、`recommended_bucket`、`candidate_bucket_ids`、`candidate_buckets`、`reason` 和 `question`。`candidate_buckets` 中包含 `id`、`title`、`type`、`status`、`summary`、`tags`、`last_active_at_unix_ms` 和 `is_recommended`，供客户端同时呈现推荐项与备选项；如果分类建议新建，还会返回可编辑的 `bucket_title` 和 `bucket_type`。确认追加示例：

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

`confirmation_granted` 必须是 JSON 布尔值 `true`。它只表示本次请求的用户确认，不是网络认证；服务应只在受信任的本机或已配置认证的反向代理后使用。用户选择“不保存”时不调用确认写入接口，正式 Entry 保持不变，但归档尝试审计仍会保留。归档成功后，客户端还可以调用 `/api/corrections/move` 修改目标 Bucket。

### 自然语言记忆查询

`/api/memory/query` 是 Rust canonical 的新查询入口。它把一句自然语言解析成有限的查询计划，再在 Bucket、Entry 和结构化 memory 上执行筛选与确定性排序。例如：

```text
查询接口 A 最近两周的压测结果
```

查询计划会尝试识别：

- `entity_terms`：实体，例如“接口 A”；
- `topic_terms`：主题，例如“压测结果”；
- `terms`：用于关键词和 lexical similarity 的合并词项；
- `bucket_terms`：用于 Bucket 名称、摘要和标签匹配的词项；
- `time_range`：时间范围，包含 `start`、`end`、`label`；
- `statuses`：Bucket 状态筛选；
- `structured_filters`：`{ "field": "...", "value": "..." }` 结构化条件；
- `limit`：最多返回的 Entry 数量；
- `raw_text`：未裁剪的原始查询文本。

时间范围使用半开区间 `[start, end)`，执行时只按 `Entry.created_at` 判断是否命中；不会使用 `memory_items.occurred_at` 代替 Entry 创建时间。相对时间以当前 UTC 时间计算，测试或调用方需要稳定结果时可在 service 层使用固定时钟入口。

GET 请求使用 `q` 和可选 `limit`：

```bash
curl -s 'http://127.0.0.1:8787/api/memory/query?q=%E6%8E%A5%E5%8F%A3%20A%20%E6%9C%80%E8%BF%91%E4%B8%A4%E5%91%A8%E7%9A%84%E5%8E%8B%E6%B5%8B%E7%BB%93%E6%9E%9C&limit=20'
```

POST 请求允许在自然语言计划之上显式覆盖状态、时间和结构化字段筛选。`start_at` 与 `end_at` 必须同时提供，时间支持 RFC3339、canonical SQLite timestamp 或 `YYYY-MM-DD`：

```json
{
  "query": "接口 A 的压测结果",
  "limit": 20,
  "statuses": ["active"],
  "start_at": "2026-07-23",
  "end_at": "2026-08-06",
  "filters": [
    {"field": "tag", "value": "性能"}
  ]
}
```

响应中的 `results` 是 **Entry 级**结果；每项同时带有所属 `bucket`、Entry 原文与 summary、命中的 memory、`matched_fields`、`keyword_score`、`semantic_score` 和总 `score`。因此同一个 Bucket 可以贡献多条 Entry，查询也可以同时命中多个 Bucket。`buckets` 只是对结果的分组投影，包含每个 Bucket 的 `matched_entry_count` 和 `top_score`，不是把结果重新折叠成单条 Bucket 记录。

`evidence` 是结果中 memory item 的确定性去重集合，当前按 memory kind 加上 Unicode case-fold 后的 trimmed text 去重。`answer` 是 runtime 根据结果数量、Bucket 数量和前几条 Entry 摘要生成的确定性摘要，不调用 LLM，也不是 embedding 或模型重排的结果。

当前实现的 `semantic_score` 名称只是兼容性投影：实际使用的是字符串包含、命中词项比例和完整短语匹配等 **lexical similarity**，不是 embedding、向量数据库或神经语义相似度。当前排序是关键词得分、lexical similarity 和 Entry 新近程度的确定性组合；后续可以替换检索实现而不改变上述响应形状。

旧的 `GET /api/buckets/search?q=支付&limit=20` 保持兼容，仍返回 Bucket 级搜索结果（包括 `matched_entry_count` 和 `score`）。新客户端需要 Entry 级结果、多 Bucket 合并和查询计划时应使用 `/api/memory/query`，不要把旧接口的结果形状当作新接口契约。

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

这是一个单进程、单用户、本地 MVP：默认无认证、无多租户、无云同步、无附件和无 embedding/向量检索。HTTP server 使用简单的单连接处理模型，不能直接暴露到公网。原始 Entry 是事实来源，结构化 memory 是可追溯的派生数据；查询可以确定性地合并多个 Bucket 的 Entry 和 evidence，但当前不提供 embedding 检索、模型重排或 LLM 生成式汇总。当分类不确定时，系统宁可等待确认，也不自动制造错误归档。

更多细节见：

- [`docs/MVP_SPEC.md`](docs/MVP_SPEC.md)：用户流程、门控规则和 API 验收标准。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：组件、数据流、事务和安全边界。
- [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md)：测试策略与回归场景。
