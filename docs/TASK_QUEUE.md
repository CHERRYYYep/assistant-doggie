# T12：TypeScript 后台任务与取消

> 2026-10-08。本文描述已实现的本地记忆任务基础设施，不代表 T13 Agent Harness / Claude / Codex 进程编排已经完成。

## 1. 用户现在可以做什么

正常启动方式不变：在项目根目录配置 `.env` 后执行 `npm start`。Web 聊天发送消息后立即得到任务 ID，不需要让一个 POST 一直等待模型结束。页面显示排队、执行中、已完成、失败或取消，并提供取消按钮、刷新任务状态入口。

任务完成后，页面读取原有聊天历史和 Bucket API。任务快照不重复携带原文、模型结果、密钥或完整错误；聊天历史和归档审计仍是业务结果的权威。

- 刷新页面会恢复未结束任务和近期状态。
- SSE 网络中断只停止订阅，不会取消工作；客户端改用有界 GET 轮询。
- 客户端不会自动重试任务 POST，避免网络结果不明时重复归档。
- “已完成”只表示聊天流程完成。低信息输入仍可能得到 `needs_confirmation`，必须通过原来的确认卡片批准，不能把任务完成理解为归档批准。

## 2. 模块与实际调用链

```text
web/assets/views.ts → web/assets/api.ts
  POST /api/tasks → src/http/app.ts
  TaskQueue.submit → TaskStore.enqueue → SQLite background_tasks
  单个 async worker → ConcreteDoggieHttpApi.chat
    → ArchiveRuntime → MemoryModel → StructuredOutputAdapter → fetch
    → 原有领域门控 / pending action / 事务归档
  TaskStore.finish → SSE task snapshot
  浏览器刷新 chat history + buckets
```

| 文件 | 实现职责 |
|---|---|
| `src/domain/task.ts` | 严格输入与快照 schema、状态类型、稳定错误；不访问数据库或 HTTP |
| `src/storage/tasks.ts` | 提交、FIFO claim、终态 CAS、容量和历史清理、执行器所有权 |
| `src/application/task-queue.ts` | 单 worker、执行 deadline、显式取消、关闭 drain、状态订阅和有界 SSE 流 |
| `src/http/app.ts` | 受现有安全 middleware 保护的任务路由 |
| `src/http/server.ts` | socket lifecycle signal、SSE 分块写入/backpressure、实际 handler drain |
| `src/runtime/local-web.ts` | 组装 worker，关闭 HTTP/worker 后才关闭 SQLite |
| `src/llm/cancellation.ts` | await 前后取消检查和脱敏 AbortError |
| `web/assets/api.ts` | 严格 SSE 解码、有界轮询，所有浏览器网络访问集中于此 |
| `web/assets/render-chat.ts` | 基于 message ID 的增量渲染，保留未改变卡片中的表单输入 |

没有引入队列框架、消息代理、打包器或新的依赖。

## 3. 持久化与重启策略

schema **v4** 新增两张表：

- `background_tasks`：稳定 UUID、不可修改 payload、单调 sequence、状态/revision、稳定错误码和时间。sequence 保证同一毫秒提交的任务仍按 FIFO 执行，UUID 不参与业务排序。
- `background_task_executor`：当前 Web worker 的随机 owner ID 和 PID。MCP 不启动 worker。

状态转换：

```text
queued → running → succeeded | failed | cancelled
queued → cancelled
```

claim 与状态转换都是同步 SQLite 操作；claim 使用事务，终态更新比较旧状态（CAS）。没有跨 await 的 SQLite 事务。通用 `pending_actions` 不被队列当作可执行命令。

重启时：

1. 拒绝占有同一数据库的另一个活着或无法确认已死亡的 worker。
2. 旧的 `running` 任务标记 `failed / interrupted`，**不自动重新执行**。
3. `queued` 任务按持久化顺序继续执行。
4. 正常关闭会取消当前工作并等待其实际返回；尚未开始的任务保持 queued。

本地 PID 所有权是轻量化的同机策略，不支持跨机器共享数据库。PID 重用会导致保守拒绝启动，属于可用性限制，不能通过超时偷占一个可能仍在写入的 worker 来解决。

如果 executor 成功后保存终态失败，效果可能已经提交。此时不伪造 cancelled/failed，不重放，而是停止队列接收、返回稳定的 unavailable 错误；任务暂留 running，重启后按 interrupted 处理。任务状态不是“恰好一次执行”的证明，既有归档事务和确认防重放仍独立有效。

## 4. HTTP 合同

所有 JSON 请求仍必须具有 `Content-Type: application/json`，Host/Origin/loopback 和 CSP 等既有安全规则不变。

| 方法 | 路径 | 响应 |
|---|---|---|
| POST | `/api/tasks` | ChatRequest `{message, focus_bucket_id?}`；202 `{ok:true, task}` |
| GET | `/api/tasks` | `{ok:true, tasks}`；最多 40 条，优先包括所有 outstanding 任务 |
| GET | `/api/tasks/:id` | `{ok:true, task}` |
| POST | `/api/tasks/:id/cancel` | 必须是严格 JSON `{}`；等待当前取消执行返回 `{ok:true, task}` |
| GET | `/api/tasks/:id/events` | `text/event-stream`，终态后关闭 |

快照类型：

```ts
type TaskSnapshot = {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode: 'execution_failed' | 'interrupted' | null;
};
```

SSE 使用 `event: task`、`id: revision` 和 JSON `data`。订阅首次获得当前快照，慢读者只接收合并后的最新状态，不积累无界日志。重连重新获取快照，不提供全量日志回放，也不依赖 Last-Event-ID。客户端按 ID 与递增 revision 拒绝错任务/旧状态，终态不能回退。

未知字段和不合法 UUID 拒绝；不存在任务返回 404；容量超限返回 429；worker 已关闭、故障或启动所有权冲突使用稳定错误（HTTP 路径为 503）。

原有 `/api/chat`、归档和确认同步 API 保留；MCP 工具仍只有既有四个，没有新增后台写工具。

## 5. 取消不是回滚

必须区分两种生命周期：

1. **同步 HTTP**：客户端断开 → Request.signal → API → ArchiveRuntime → adapter → fetch。执行 deadline 或进程关闭也会取消。
2. **持久化后台任务**：提交成功后由队列拥有，不和提交 POST / SSE 连接的存活绑定。显式 cancel、任务 deadline 或 shutdown 才触发任务 signal。

业务服务在 model await 两侧及正式持久化前检查取消。即使模型忽略 signal 并晚返回，也不能继续归档；已接受的用户消息保留。取消不作为可重试的模型错误，任意 abort reason 不泄露。

正式归档已经提交后再取消，不能把已有 Entry 当作“未保存”。回复阶段被取消时保留真实归档结果，不写入晚返回的模型工具消息；任务可能以 succeeded 结束。这与 UI 的“取消请求结果未确认”和查询任务状态相配合，而非承诺撤销已发生的效果。

Node adapter 不使用正常的 `IncomingMessage.close` 来判定断线，因为 body 读完也会触发它。它监听 request aborted / response premature close，并为 handler 提供 signal。SSE 直接分块写 socket，遇到 backpressure 等 drain，断线取消 reader。

## 6. 当前资源界限与明确限制

- 并发 worker：1；queued + running 总数：32。
- 单任务序列化 payload：128 KiB；保留任务：最多 200（优先清理终态），列表最多 40。
- SSE 订阅：最多 32；每条 stream 只缓冲一个快照，心跳 15 秒。
- 后台执行 deadline：120 秒；HTTP handler deadline：默认 120 秒，与请求 body timeout 分离。
- Web SSE 空闲超时：35 秒；失败后最多 60 次 GET 轮询、间隔 3 秒；单次观察请求 10 秒，整体观察预算 5 分钟。
- 原有连接数、请求大小、header/body timeout 和每 socket 请求数限制保留。

AbortSignal 是协作取消，不是线程/进程强制终止。正常 fetch 会响应取消；如果注入的模型/执行器永不返回，安全关闭会等待，不能为了“迅速关闭”先释放它仍可能访问的数据库。生产 `src/main.ts` 仍保留 5 秒 shutdown grace 和第二次信号强制退出兜底；进程退出不代表业务已回滚，下次启动会按 interrupted 处理遗留 running。CPU 密集无限循环也不由 async 队列隔离；真实进程管理、工具权限、上下文预算等在 T13 处理。

本阶段没有实现模型 token 流式回答、模型完整只读工具循环、Claude/Codex 子进程、任务自动重试、跨主机队列或 Agent workspace/session。它们不能因为增加了 SSE 就被视作完成。
