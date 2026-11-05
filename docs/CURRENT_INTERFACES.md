# 当前功能接口与前端接入说明

日期：2026-11-05。本文描述当前 `dev_ts` 分支实际存在的 TypeScript/HTTP/浏览器接口，方便前端改版时区分“已有能力”和“尚未接入页面的能力”。运行行为以 `src/http/operations.ts`、请求/响应 schema 和自动化测试为准。

## 当前验证结果

- `npm run check`：通过。
- 后端测试：414 通过。
- 前端测试：59 通过。
- T14 定向测试：26 通过。
- 当前没有发现自动化测试失败；下面的问题是功能缺口和交互缺口，不是当前门禁失败。

## 用户主流程

当前页面启动后会同时加载：活跃 Bucket、Agenda、聊天历史和后台任务。用户发送消息时，页面实际走的是后台任务链路：

```text
web/assets/app.ts
  -> views.sendMessage()
  -> api.postTask()
  -> POST /api/tasks
  -> SSE /api/tasks/:taskId/events 或 GET /api/tasks/:taskId
  -> 刷新聊天历史和 Bucket
```

`POST /api/chat` 和 `POST /api/archive` 仍然存在，是同步/直接归档接口；当前主页面不把它们作为普通聊天发送入口。

## HTTP 接口分组

### 1. 基础与对话

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/api/chat/history?limit=20..100` | 读取聊天历史 |
| POST | `/api/chat` | 同步聊天并返回归档结果 |
| POST | `/api/archive` | 同步归档一条输入 |
| POST | `/api/chat/confirm` | 提交聊天归档确认；支持 `append/create/discard` |
| POST | `/api/archive/append` | 直接确认追加 |
| POST | `/api/archive/create` | 直接确认创建 Bucket |

聊天确认必须绑定 `attempt_id`、原始 `text` 和用户选择，不能只提交 Bucket ID。

### 2. Bucket、Entry 和记忆查询

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/buckets/active?limit=20..100` | 活跃 Bucket 列表 |
| GET | `/api/buckets/search?q=...&limit=...` | 搜索 Bucket |
| GET | `/api/buckets/:bucketId` | Bucket 详情、Entry 和 Memory |
| DELETE | `/api/buckets/:bucketId` | 删除 Bucket 及其有效内容，保留审计 |
| DELETE | `/api/entries/:entryId` | 撤销 Entry；不是物理删除 |
| POST | `/api/corrections/move` | 将 Entry 移动到另一个 Bucket |
| POST | `/api/buckets/status` | 设置 Bucket 生命周期状态 |
| GET | `/api/memory/query?q=...&limit=...` | 自然语言记忆查询 |
| POST | `/api/memory/query` | 带时间范围、状态和结构化筛选的查询 |

Entry 撤销后，来源于它的有效 Memory、TODO、证据和后续模型上下文都会退出有效集合；聊天和审计记录仍保留。

### 3. TODO 与 Agenda

TODO 响应的核心字段是：

```json
{
  "id": "todo-id",
  "bucket_id": "bucket-id",
  "entry_id": "entry-id",
  "text": "完成 T14",
  "status": "open",
  "scheduled_at": null,
  "due_at": null,
  "todo_rule": null,
  "todo_raw_time": null,
  "todo_occurrence": 1,
  "created_at": "2026-11-05T00:00:00.000Z",
  "updated_at": "2026-11-05T00:00:00.000Z"
}
```

状态为：`open`、`in_progress`、`blocked`、`done`、`cancelled`。

| 方法 | 路径 | 用途 | 页面现状 |
|---|---|---|---|
| GET | `/api/agenda` | 读取 Agenda；支持 `from`、`to`、`bucket_id`、`include_history` | 已接入，当前只使用 `include_history` |
| GET | `/api/todos/:todoId` | 读取单个 TODO | 暂无页面调用 |
| POST | `/api/todos/:todoId/transition` | 修改状态 | 已接入完成、阻塞、取消 |
| POST | `/api/todos/:todoId/plan` | 修改计划时间、截止时间、重复规则和原始时间 | API 已有，页面未接入 |
| POST | `/api/todos/:todoId/advance` | 完成当前重复 occurrence 并推进下一次 | API 已有，页面未接入 |
| POST | `/api/todos/:todoId/reopen` | 将 `done/cancelled` 重新打开为 `open` | 已接入 |

所有 TODO 写请求都需要：

```json
{
  "command_text": "用户修改 TODO",
  "expected_updated_at": "当前页面看到的 updated_at"
}
```

版本不匹配时服务端返回 HTTP 409，防止旧页面覆盖新修改。

### 4. 后台任务与 Agent

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/tasks` | 提交后台聊天任务，返回 202 |
| GET | `/api/tasks` | 读取任务列表 |
| GET | `/api/tasks/:taskId` | 读取单个任务 |
| POST | `/api/tasks/:taskId/cancel` | 取消后台任务 |
| GET | `/api/tasks/:taskId/events` | SSE 任务状态流 |
| GET | `/api/agent/capabilities` | 读取 Agent 能力 |
| GET/POST | `/api/agent/workspaces` | 读取或登记工作区 |
| GET | `/api/agent/tasks` | 读取 Agent 提案/任务 |
| GET | `/api/agent/tasks/:id` | 读取单个 Agent 任务 |
| POST | `/api/agent/tasks` | 创建待批准提案 |
| POST | `/api/agent/tasks/:id/approve` | 明确批准只读 CLI 任务 |
| POST | `/api/agent/tasks/:id/reject` | 拒绝提案 |
| POST | `/api/agent/tasks/:id/cancel` | 取消 Agent 任务 |

Agent 提案创建不会直接执行 CLI；批准、工作区绑定和只读边界仍由服务端强制。

## 当前前端模块职责

| 文件 | 职责 |
|---|---|
| `web/index.html` | 页面结构和控件占位 |
| `web/assets/app.ts` | 事件绑定和启动加载 |
| `web/assets/api.ts` | 所有浏览器网络请求、响应校验和路径编码 |
| `web/assets/state.ts` | 单一前端可变状态、请求版本号和任务观察器 |
| `web/assets/views.ts` | 请求控制器、状态变更和 HTML 片段渲染 |
| `web/assets/dom.ts` | DOM 元素获取和全局状态提示 |
| `web/assets/render-*.ts` | 聊天、Bucket、查询和 Agent 的纯渲染逻辑 |
| `web/assets/styles.css` | 当前布局、颜色 token、深色模式和窄屏规则 |

改版时应保持 `api.ts` 负责网络、`state.ts` 负责状态、`views.ts` 负责控制流程、`render-*.ts` 负责纯渲染，避免把请求或业务状态重新塞进 HTML 事件代码。

## 已确认的功能缺口

### 需要优先决定的功能缺口

1. **重复 TODO 还不能通过当前页面推进。** 页面只有“完成/阻塞/取消”，没有调用 `/advance`；重复 TODO 如果先被标记为 `done`，当前 Store 的 advance 接口也不会接受这个状态。
2. **计划编辑器尚未实现。** 页面不能修改 `scheduled_at`、`due_at`、重复规则和原始时间，虽然 API 已经支持。
3. **`in_progress` 没有页面入口。** 后端状态机支持，Agenda 页面没有“开始处理”按钮。
4. **冲突后的页面恢复较弱。** TODO 写请求返回 409 时页面只显示错误，通常不会自动重新拉取最新 Agenda，旧按钮仍可能停留在页面上。

### 可以在视觉改版时处理的接口表现问题

1. Agenda API 当前返回扁平 `todos`，没有服务端分组和计数；页面自行决定如何分组。
2. 浏览器的 `fetchAgenda()` 暂时只传 `include_history`，没有使用 `from/to/bucket_id` 筛选能力。
3. `/api/todos/:todoId` 只返回 TODO 的 `bucket_id/entry_id`，没有直接返回来源 Bucket 和 Entry 详情；当前“查看来源”只能跳到 Bucket。
4. 普通 `Memory` 投影没有带出 TODO 专用计划字段；TODO 详情应优先使用 `/api/todos/:todoId` 或 `/api/agenda`。

## 建议的前端改版顺序

1. 先把 Agenda 做成真正可用的 TODO 工作区：状态筛选、计划编辑、重复推进、冲突后自动刷新和来源详情。
2. 再做视觉层：布局、层级、色彩、间距、动效和移动端排版。
3. 改版期间保持上述 HTTP 字段和错误语义不变；如果需要改接口，先同步 operation registry、响应 schema、OpenAPI、浏览器 contract 和测试。

