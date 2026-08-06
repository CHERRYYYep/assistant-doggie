# Rust Work Memory MVP 规格

## 1. 目标

MVP 只解决一个闭环：把一段工作事实可靠地归档到 Rust SQLite，并让用户立即看到归档结果和 Bucket 内容。

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
- `candidate_bucket_ids`：服务端候选 ID 的子集

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

空工作区不改变上述规则：`create_new` 仍需达到自动归档阈值，低置信度新建只返回确认信息。这样可以避免把不确定输入误当成第一个长期事务。

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

当需要确认时，`archive_state` 为 `needs_confirmation`，响应中的 `bucket_id`、`entry_id` 和 `memory_item_ids` 均为 `null` 或空数组，不会创建正式 Entry；`question`、`candidate_bucket_ids`、`bucket_title` 和 `bucket_type` 用于渲染确认操作。

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
- `GET /api/buckets/:id`
- `POST /api/corrections/move`，请求 `{ "entry_id": "...", "target_bucket_id": "...", "command_text": "..." }`
- `POST /api/buckets/status`，请求 `{ "bucket_id": "...", "status": "active|paused|archived" }`

详情响应至少包含 Bucket、Entry 和 memory 列表，便于 UI 在归档后立即展开查看。

## 6. 内嵌 UI

首页提供：

1. 文本输入和归档按钮。
2. 最近的活跃 Bucket 列表。
3. 归档状态、分类理由、置信度和提取摘要。
4. `needs_confirmation` 时的确认追加/确认新建按钮。
5. Bucket 详情中的摘要和原始 Entry。

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

### 场景 C：纠错移动

1. 对一个已有 Entry 调用 `/api/corrections/move`。
2. Entry 的 `bucket_id` 变为目标 Bucket，保留 `moved_from_bucket_id`。
3. 返回纠错结果，并写入 correction audit。

## 8. 非目标与限制

MVP 不包含多用户权限、远程部署安全层、附件、向量检索、复杂对话编排、自动合并多个 Bucket 或后台任务队列。服务默认只适合本机受信环境；需要对外提供时，必须在 HTTP 层前置认证、TLS、限流和请求幂等控制。
