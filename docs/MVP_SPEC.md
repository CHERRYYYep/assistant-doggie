# Rust Work Memory MVP 规格

## 1. 目标

MVP 只解决两个相连的闭环：把一段工作事实可靠地归档到 Rust SQLite，并让用户通过自然语言查询立即看到相关 Entry、Bucket 和证据。

```text
输入文本
  ↓
读取活跃 Bucket 候选
  ↓
Structured Output 分类
  ↓
服务端安全门控
  ├─ ask_user：保存待确认审计，不写 Entry
  └─ append_existing/create_new：结构化提取并原子写入
  ↓
返回 ArchiveExecution 和 Bucket 详情
```

## 2. 分类模型

分类结果包含：

- `action`：`append_existing`、`create_new` 或 `ask_user`
- `bucket_id`：追加时的服务端候选 ID
- `bucket_type`、`title`：新建时使用
- `confidence`：`0.0..=1.0` 的风险信号
- `reason`：分类理由
- `question`：需要确认时的问题
- `candidate_bucket_ids`：服务端候选 ID 的有序列表；顺序为显式目标、模型候选、服务端其余活跃候选。
- `recommended_bucket` / `recommended_bucket_id`：客户端优先展示的已有 Bucket。
- `candidate_buckets`：与候选 ID 对应的完整 Bucket 元数据，至少包含 `id`、`title`、`type`、`status`、`summary`、`tags`、`last_active_at_unix_ms` 和 `is_recommended`。
- `bucket_title` / `bucket_type`：只用于建议创建的新 Bucket；不能用来承载已有 Bucket 的展示信息。

模型只能引用 runtime 提供的 Bucket 候选。runtime 会过滤未知 ID，不允许模型自行创建或猜测持久化 ID。

## 3. 安全门控

默认策略：

| 条件 | 结果 |
|---|---|
| 已经是 `ask_user` | 只保存归档审计 |
| 多个候选 Bucket | 请求确认 |
| 唯一候选且 `confidence >= 0.85` | 自动归档 |
| `0.55 <= confidence < 0.85` | 请求确认 |
| `confidence < 0.55` | 请求确认 |
| 模糊指代且只有“继续处理/补充一下”等低信息动作 | 请求确认 |
| 没有可核验事实的短状态更新（如“压测结果更新了”“切备用后好了”“它现在正常了”） | 请求确认，即使 confidence 很高 |

低信息门控优先于 confidence：模型不能用高分绕过确认。空工作区也不能把纯指代或低信息状态输入误当成第一个长期事务；这类输入只返回确认信息。

## 4. 归档写入

通过自动归档或确认接口写入时，Rust service 在一个 SQLite 事务中完成：

1. 创建或读取目标 Bucket。
2. 创建原始 Entry。
3. 保存结构化 memory items。
4. 更新 Bucket 摘要、标签和活动时间。
5. 保存 archive attempt 审计及最终状态。

正式 Entry 的事实字段包括 `raw_text`、`summary`、`content_type`、分类置信度、分类理由和时间戳。提取结果可以包含：

- `summary`
- `todos`
- `evidences`
- `timeline_events`
- `decisions`
- `hypotheses`
- `entities`
- `tags`

缺失内容使用空数组，不应由模型补造事实。`timeline_events.event_time` 保留用户原文表达，避免在 MVP 中丢失模糊时间信息。

`ask_user` 只创建 archive attempt，`entry_id`、`bucket_id` 和 memory item 列表为空。用户确认后必须调用显式确认接口，不能通过再次调用普通归档接口绕过确认。

## 5. HTTP 接口

### 5.1 自动归档

`POST /api/archive`

```json
{
  "text": "支付回调从 10:20 开始失败，第三方返回 502。",
  "focus_bucket_id": "optional-bucket-id"
}
```

成功响应包含：

```json
{
  "ok": true,
  "archive_state": "archived",
  "action": "create_new",
  "confidence": 0.93,
  "bucket_id": "bucket-id",
  "entry_id": "entry-id",
  "bucket_title": "支付回调故障",
  "bucket_type": "incident",
  "candidate_bucket_ids": [],
  "extraction": {"summary": "..."}
}
```

当需要确认时，`archive_state` 为 `needs_confirmation`，响应中的 `bucket_id`、`entry_id` 和 `memory_item_ids` 均为 `null` 或空数组，不会创建正式 Entry；`recommended_bucket`、`recommended_bucket_id`、`candidate_buckets`、`candidate_bucket_ids`、`reason` 和 `question` 用于渲染已有 Bucket 选择。`bucket_title` 和 `bucket_type` 只用于渲染“创建新 Bucket”的可编辑建议。

### 5.2 确认追加

`POST /api/archive/append`

```json
{
  "bucket_id": "bucket-id",
  "text": "备用通道已恢复。",
  "confirmation_granted": true
}
```

### 5.3 确认新建

`POST /api/archive/create`

`bucket_type` 必须是 `idea`、`task`、`incident`、`experiment`、`decision`、`meeting`、`knowledge` 或 `draft`。

```json
{
  "title": "支付回调故障",
  "bucket_type": "incident",
  "text": "第三方返回 502。",
  "confirmation_granted": true
}
```

### 5.4 查询和纠错

- `GET /api/buckets/active?limit=20`
- `GET /api/buckets/search?q=支付&limit=20`
- `GET /api/memory/query?q=接口%20A%20最近两周的压测结果&limit=20`
- `POST /api/memory/query`
- `GET /api/buckets/:id`
- `POST /api/corrections/move`，请求 `{ "entry_id": "...", "target_bucket_id": "...", "command_text": "..." }`
- `POST /api/buckets/status`，请求 `{ "bucket_id": "...", "status": "active|paused|archived" }`

详情响应至少包含 Bucket、Entry 和 memory 列表，便于 UI 在归档后立即展开查看。

自然语言查询的 POST 请求格式为：

```json
{
  "query": "接口 A 最近两周的压测结果",
  "limit": 20,
  "statuses": ["active"],
  "start_at": "2026-07-23",
  "end_at": "2026-08-06",
  "filters": [{"field": "tag", "value": "性能"}]
}
```

响应包含 `query_plan`，其字段为 `raw_text`、`terms`、`entity_terms`、`topic_terms`、`bucket_terms`、`time_range`、`statuses`、`structured_filters` 和 `limit`。`time_range` 为半开区间 `[start, end)`，时间筛选只比较 `Entry.created_at`。`results` 是 Entry 级命中，每项带所属 Bucket、Entry、memory、`matched_fields`、`keyword_score`、`semantic_score` 和 `score`；`buckets` 是多个命中 Entry 按 Bucket 的分组，`evidence` 是确定性去重后的 memory item，`answer` 是不调用 LLM 的确定性摘要。

当前 `semantic_score` 实际表示 lexical similarity（字符串包含、命中词项比例和完整短语匹配），不是 embedding 或向量检索；当前没有模型重排。旧 `/api/buckets/search` 保持原有 Bucket 级响应兼容，不改成 Entry 级响应。

## 6. 内嵌 UI

首页提供：

1. 文本输入和归档按钮。
2. 最近的活跃 Bucket 列表。
3. 归档状态、分类理由、置信度和提取摘要。
4. `needs_confirmation` 时依次展示推荐 Bucket、备选 Bucket、模型判断理由和问题。
5. 四种确认路径：保存到推荐 Bucket、保存到其他 Bucket、创建新的 Bucket（标题和类型可编辑）、不保存。
6. 正式归档后提供“修改 Bucket”入口，并通过纠错接口记录移动审计。
7. Bucket 详情中的摘要和原始 Entry。

UI 只调用 HTTP API，不直接访问 SQLite。

## 7. 验收场景

### 场景 A：新建并追加故障事务

1. 输入“支付回调从 10:20 开始失败，第三方返回 502”。
2. 分类为高置信度 `create_new`，创建 `incident` Bucket。
3. 输入“10:40 切备用通道后恢复了”。
4. 分类为唯一高置信度 `append_existing`，追加到同一 Bucket。
5. Bucket 详情包含两条原始 Entry 和提取出的事实。

### 场景 B：不确定输入先确认

1. 空工作区输入一条低置信度的新主题。
2. 响应为 `needs_confirmation`，数据库只有 archive attempt，没有 Entry。
3. 用户调用 `/api/archive/create` 并携带 `confirmation_granted: true`。
4. 创建 Bucket、第一条 Entry 和结构化 memory。

### 场景 C：低信息输入必须确认

1. 已有“接口 A 压测” Bucket 时输入“压测结果更新了”。
2. 即使模型返回高 confidence，响应仍为 `needs_confirmation`。
3. 客户端展示推荐 Bucket、备选 Bucket、理由和四种操作；点击“不保存”不创建 Entry。
4. 用户选择目标后，只有确认接口才创建正式 Entry。

### 场景 D：纠错移动

1. 对一个已有 Entry 调用 `/api/corrections/move`。
2. Entry 的 `bucket_id` 变为目标 Bucket，保留 `moved_from_bucket_id`。
3. 返回纠错结果，并写入 correction audit。
4. 客户端在归档成功结果中提供该入口，而不是要求用户重新输入原文。

### 场景 E：自然语言跨 Bucket 查询

1. 已有多个 Entry，分布在“接口 A 压测”和另一个相关 Bucket 中。
2. 用户输入“查询接口 A 最近两周的压测结果”。
3. 查询计划识别实体“接口 A”、主题“压测结果”和最近两周时间范围。
4. 时间筛选按每条 `Entry.created_at` 执行，返回多个 Entry，并在 `buckets` 中合并多个 Bucket。
5. `evidence` 去重，`answer` 的 Entry/Bucket 数量与结果一致且重复调用得到相同文本。

## 8. 非目标与限制

MVP 不包含多用户权限、远程部署安全层、附件、embedding/向量检索、模型重排、LLM 生成式汇总、复杂对话编排或后台任务队列。查询已经支持确定性地合并多个 Bucket 的 Entry 与 evidence，但不承诺语义向量召回或模型生成的跨 Bucket 总结。服务默认只适合本机受信环境；需要对外提供时，必须在 HTTP 层前置认证、TLS、限流和请求幂等控制。

Python 版本已放弃为目标实现，仅保留历史或兼容参考；本阶段不新增 Python 实现测试，查询验收以 Rust canonical 测试为准。
