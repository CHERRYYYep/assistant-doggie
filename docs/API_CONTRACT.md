# HTTP 契约与 OpenAPI

日期：2026-11-03。本规范覆盖现有本地 HTTP 能力与 Entry 撤销，不增加远程接入、身份认证或 MCP 写权限。源码与自动化测试是运行行为的验收依据；本文不代表真实模型、收费 CLI 或人工浏览器验收已完成。

## 契约来源

- [operations.ts](../src/http/operations.ts) 是业务路由清单：method、path、operationId、请求 body/query/path schema、成功状态、响应 schema、可选功能及 SSE 类型。
- [contracts.ts](../src/http/contracts.ts) 与现有 domain schema 定义请求校验；[response-schemas.ts](../src/http/response-schemas.ts) 定义严格成功响应、错误和事件数据。
- [dto.ts](../src/http/dto.ts) 从响应 schema 派生浏览器共享类型，使用只读集合和精确可选属性；契约测试检查其兼容性。浏览器不能在运行时导入 Node 或 Zod；HTTP 数据始终从 unknown 验证，类型断言不能替代运行时验证。
- [browser-contracts.ts](../src/http/browser-contracts.ts) 从同一 operation 清单生成浏览器的纯数据响应规则，`api.ts` 在接收成功或错误响应时进行有界校验；浏览器不加载 Zod。
- [openapi.ts](../src/http/openapi.ts) 使用项目已安装的 Zod 4 `z.toJSONSchema` 生成 OpenAPI **3.1.0** / JSON Schema 2020-12。[openapi.json](openapi.json) 为生成产物，不手工编辑。

上述命令同时更新或检查 OpenAPI 和 `web/assets/response-contracts.ts`。生成和检查不启动产品、不连接用户数据库、不读取密钥，也不调用模型：

```bash
npm run openapi:generate
npm run openapi:check
node --test src/http/openapi.test.ts
```

修改路由或字段后同步操作清单和 schema，重新生成文档并运行相关用例、HTTP 和前端回归，最后执行 `npm run check`。自动测试对路由覆盖、operationId 唯一性、生成文档漂移和所有内部 `$ref` 的可解析性做检查。

## 本地访问与请求

仅允许既有 loopback 监听、合法 Host 与同源 Origin。`Origin: null`、foreign/重复/畸形头、非 JSON body 继续拒绝；保留连接、请求大小、header/request timeout、每 socket 请求数和安全响应头。OpenAPI 的相对 server `/` 只表示当前可信来源，不授予任意主机访问权限。不开放宽泛 CORS，也没有远程配对或 relay 路由。

所有 JSON 对象请求拒绝未知字段。路径和 query 有独立 schema；重复参数不能被静默折叠后当作明确请求。普通 Bucket/Entry ID 保持非空字符串，兼容历史 ID；后台任务与 Agent ID 使用 UUID。

有 body 的请求必须使用 `application/json`。DELETE Entry/Bucket 不需要 body；取消操作 POST 必须发送严格空对象 `{}`。归档和聊天输入通常会 trim，归档确认中的 `text` 保留原文并与 pending action 精确绑定，不能使用清理后的文本代替原文。

默认列表限制 20，最大 100；后台任务快照列表上限 40，Agent task/workspace 列表上限 100。不存在分页游标或无限历史的承诺。query 中的 limit 是 URL 文本，运行时转换并检查整数范围，OpenAPI 以数值范围描述其语义。

部分约束无法完全表达为 JSON Schema：UTF-8 字节预算、非空白原文、精确原文绑定、Bucket active、审批状态和事务边界仍由 Zod refinement、领域、应用与存储层强制。不得因为客户端通过 OpenAPI 校验就跳过服务端规则。

## 响应、错误与兼容

成功 JSON 对象包含 `ok: true`，并按各 operation 严格校验。字段省略与 `null` 有不同含义；服务生成的创建、更新、归档、撤销时间使用 ISO UTC 字符串，query plan 时间范围也使用 ISO UTC。Memory 的 `due_at/occurred_at` 与 extraction 的 `event_time` 是来源提取文本，历史数据可以只有日期，保留可空字符串合同，不伪装成统一时区时间戳。HTTP task 快照沿用 `createdAt/updatedAt/errorCode`，现有 memory/archive DTO 使用 snake_case；本阶段不做破坏性重命名。

错误对象为 `{ok:false,error:string}`，仅允许已知聊天恢复字段 `user_message`、`assistant_message`。错误不能携带内部堆栈、密钥或完整上游响应。用户消息已保存而后续失败时，恢复字段可让客户端反映真实历史；失败不能被伪装成“没有接收输入”。

规范记录 400、403、404、409、415、429、500、503 错误形状；这并不保证每个 operation 都能触发全部状态。无效请求映为 400；服务端生成的成功数据违反响应 schema 属于内部故障，必须返回脱敏 **500**，不能误判为请求错误。

浏览器仅接受 JSON Content-Type、合法 UTF-8 和完整路由响应；单次响应最多 8 MiB，校验最多 64 层和 100000 节点。超限会明确失败，可缩小查询/历史 limit 后重试读取；不会自动重发写操作。

兼容变更必须同时更新 schema、DTO、投影、浏览器解析与 fixture。不兼容的字段删除、重命名、类型/可空性变化或语义收紧需明确迁移说明；本地 UI 与后端同版本交付，但这不能替代契约测试。没有对第三方客户端承诺长期独立版本兼容。

## 写入、重复操作与恢复

- 归档建议不是授权。`needs_confirmation` 不产生正式 Entry，确认绑定 attempt、原文和选择；重复确认拒绝重放。
- Entry DELETE 表示撤销有效记忆，返回 `entry_id`、`bucket_id`、`correction_id`、`revoked_at`、`memory_item_ids`；memory ID 表示退出有效集合的记录，不表示物理清除。重复撤销返回原结果。它不等于彻底清除聊天、原文与审计。
- 历史 archive 或进行中的回复遇到已撤销 Entry 时，允许 `archive_state: revoked` 与 `revoked_at`；撤销卡片不得继续提供移动/撤销入口或展示有效派生证据。历史 `details` 保持 JSON，不能强制所有旧聊天元数据符合新 archive 结构。
- 任务提交返回 202，Agent 提案和工作区登记返回 201；提案创建不启动 CLI。批准返回 202，并携带 Agent task 与 queueTask；批准仍须用户原文绑定与明确确认。
- 不将所有 POST 宣称为幂等。超时/断线可能发生在效果已经提交之后，不能自动重复归档、提交或批准。优先读取任务/历史恢复；取消是显式操作，断线不等于取消。

## 主对话预览（C2）

- `POST /api/conversation/turns`：严格区分 `message`（独立发言）、`reply`（补充）、`select`（选择目标）、`none`（都不是）和 `cancel`。每次写入需要 UUID `requestId`；卡片操作还需要 `clarificationId` 和 `expectedRevision`。文本 trim 后最多 4000 UTF-16 单元；不接受批准、Bucket 焦点或工作区字段。
- 回执给出类型、实际持久化的用户/助手消息 ID，以及澄清 ID（适用时）。同键同规范化载荷返回原回执，同键不同载荷、陈旧版本或无效候选返回 409；卡片缺失返回 404。常规回合效果未确认时，同键返回 409，客户端先核对历史，不另换编号自动重发。
- `GET /api/conversation/clarifications`：优先返回等待卡及最近历史，最多 40 张，每卡最多 5 个候选；显示最新补充与当前有效的选定目标，目标范围或来源失效时显示 `stale`。最多同时保留 20 张等待卡。完整边界与验收见 [C2 记录](MAIN_CONVERSATION_C2_ACCEPTANCE.md)。

## SSE

`GET /api/tasks/{taskId}/events` 成功使用 `text/event-stream`，不是 JSON envelope。每个 task 事件包含：

```text
id: 2
event: task
data: {"id":"…","status":"running","revision":2,"createdAt":"…","updatedAt":"…","errorCode":null}

```

`data` 与 REST `task` 使用同一严格 TaskSnapshot schema，`id` 等于 revision 的十进制字符串。OpenAPI 用 `x-event-name`、`x-event-id`、`x-event-data-schema` 描述事件，不把文本流冒充 JSON body。

服务端发送当前快照、合并慢消费者的中间状态，15 秒发送 heartbeat 注释，终态后关闭。没有历史事件重放或 `Last-Event-ID` 续传保证。断开只取消观察订阅，不取消后台工作；客户端按同一任务 ID 严格校验、只接受递增 revision，必要时有界 GET 轮询。不得因事件流失败自动重发 POST。

Tasks/Agent 路由由运行时可选能力决定；OpenAPI 的 `x-optional-feature` 标记能力归属，不代表任何部署都启用 CLI。MCP 保持独立工具清单与批准边界，详见 [MCP_SERVER.md](MCP_SERVER.md)。远程访问仍仅预留，见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。
