# Doggie 测试与验收计划

## 1. 固定门槛

每次提交前运行：

```bash
npm run check
git diff --check
```

当前分支已移除 Rust workspace。历史 fixture 保留；需要考古时使用隔离的历史工作树，当前产品门禁只运行 TypeScript。

## 2. 测试分层

### Core

覆盖 Bucket 类型/状态、分类 action、候选排序、confidence 门控、低信息输入、时间解析和查询计划边界。

### Protocol、LLM 与 Agent Runtime

覆盖严格 JSON 字段、未知字段、长度限制、Responses/Chat Completions 请求体、拒绝/截断/非法 JSON、网络错误分类、重试上限、工具 allow-list 和上下文资源上限。

### Store

覆盖 canonical schema 初始化/重开、外键、事务提交和回滚、归档图、对话消息、纠错、状态变化、关键词查询、结构化字段查询和 evidence 去重。所有数据库使用临时文件。

### Application 与 Engine

覆盖：

- 自动追加、新建和 `ask_user` 不写 Entry；
- 低信息输入即使高 confidence 也要求确认；
- 确认必须绑定 pending attempt 和原文；
- 多 Entry、多 Bucket、时间/状态/结构化筛选的自然语言查询；
- 失败不产生部分写入；
- 重启后对话和归档状态可恢复。

### Local Web UI

覆盖 `.env` 与 shell 优先级、配置脱敏、loopback 监听限制、生产 bootstrap、健康检查、静态 UI、API 参数校验、UTF-8 query 解码、归档 projection、确认卡片字段、四种确认选项、修改 Bucket 入口和稳定错误 JSON。使用 fake model + 临时文件数据库运行真实 Node socket，验证重启恢复和 MCP proposal → Web history → confirmation 共库链路。静态前端资源还要检查 Markdown 渲染契约：代码围栏（含 `bash` 语言标签）、段落/列表/标题/引用/链接、代码换行保留、危险 URL 拒绝、HTML 转义以及渲染器不能被重复声明覆盖。

## 3. 手工验收

启动：

```bash
npm ci
cp .env.example .env
# 填写 OPENAI_API_KEY 和 OPENAI_MODEL
npm start
```

依次验证：

1. 输入一个含具体数字/事实的新记录，确认自动归档；
2. 输入“它现在正常了”或“压测结果更新了”，确认页面显示“尚未保存”和完整四项选择；
3. 选择推荐 Bucket、其他 Bucket、新建和不保存；
4. 在归档结果中移动 Entry，确认 Bucket 详情和审计同步更新；
5. 输入“查询接口 A 最近两周的压测结果”，确认结果可跨多个 Entry/Bucket，并展示 query plan 和 evidence 来源；
6. 重启服务，确认聊天历史、Bucket 和 pending 状态符合预期。

普通测试不得调用真实模型。真实模型只用于明确的人工 smoke test，并且不得把 API Key 或真实数据库带入测试产物。


## T11：通用待批准动作与纯 TS 前端解耦

针对性门禁：

```bash
node --test --test-isolation=none src/storage/pending-actions.test.ts
node --test src/application/archive-runtime.test.ts src/application/archive.test.ts src/http/api.test.ts src/mcp/tools.test.ts tests/storage-parity.test.ts
npm run check
```

`src/storage/pending-actions.test.ts` 使用 fake model 和内存/临时 SQLite，覆盖：

- 严格四类 payload、未知字段/类型拒绝、参数大小、稳定失败码；
- pending 不产生正式数据，原文绑定、批准前不可完成、终态不能重放；
- user create/append、模型 ask_user 和 MCP proposal 共用审批权威，MCP 工具面不扩展；
- archive 批准、正式数据和审计在同一事务中提交，故障注入时完整回滚；
- 并发确认只有一次正式写入成功；提取可能重复，不宣称已完成 T12 去重/取消；
- proposal 不可被改写，generic approve/reject/finish 不得处理 archive；
- schema v2→v3 保留 pending/resolved ID 与原文，重开不重放，future approved action 重开不自动派发；
- 运行时完成结果严格只接受 executed / failed，非法状态、null、多余字段不能重开批准；
- 显式保存提取失败不登记不可恢复 proposal，正式写入失败自动终结单次提案，重试只写入一次；
- Store/Service 确认保留 exact raw text，不因 trim 放过不一致输入；
- 保留 HTTP 大文本和 MCP 16,000 字 Unicode 合约，不误用未来工具的 32 KiB 上限收紧旧归档行为。

`web/` 搬迁需验证静态资源加载、共享 DTO import、API client 和安全 Markdown 渲染。普通测试和 production 无 Cargo 依赖；Rust oracle 仅资源路径跟随搬迁，不新增功能。沙箱若限制 loopback/子进程，需明确报告并经授权在沙箱外跑完整门禁，不能跳过真实 socket 测试。


## T12 任务队列、SSE 和取消回归（2026-10-08）

- `src/application/task-queue.test.ts`：strict payload/资源上限、claim/CAS、FIFO（同毫秒+重开）、执行器所有权、重启 interrupted 不重放、queued/running 取消、close drain、SSE coalesce/释放、稳定错误、终态持久化故障不得伪报已提交效果且阻止新任务。
- `src/http/tasks.test.ts`：202 提交、列表/get/cancel、严格参数/缺失 ID/foreign Origin、SSE→历史、非协作模型晚返回不得归档、已归档之后回复取消不得写入晚模型工具消息。
- `src/llm/cancellation.test.ts`、`src/application/archive-runtime.cancellation.test.ts`：请求/进程 signal、await 前后和写入前检查、取消不重试及 reason 脱敏、确认仍 pending。
- `src/http/server-stream.test.ts`：真实 socket 早期帧、慢读者 backpressure、HEAD、断线、deadline、shutdown、reader/listener 清理及实际 handler drain。
- `src/runtime/local-web.test.ts`：生产组装、SSE 断线后台继续、shutdown 关流并等 worker 后才关库、queued 重启继续、listen failure + close fault 保留原错误且释放数据库。
- `web/tests/tasks.test.ts`、`ui-tasks.test.ts`、`module-contract.test.ts`：SSE split UTF-8/CRLF/multiline、恶意或错误 ID/大小/revision、轮询次数/观察预算、断线只 GET、取消、恢复、POST 结果不明不重试、keyed 渲染/确认输入/滚动、真实模块图/CSP。

既有 T10b shutdown 测试原来要求进程关闭时返回 500 并追加 error assistant。T12 明确将 shutdown 纳入 Request 生命周期，关闭 socket，取消不冒充模型错误；测试更新为客户端连接终止、用户原文仍保留、无正式归档及 executor ownership 已释放。测试没有删除或跳过。

完整门禁仍为 `npm run check`。真实 socket / subprocess 测试需沙箱外权限；测试全部使用 fake model/transport 和临时或内存 SQLite，不读用户库、密钥，不调用真实模型。


## T13 与 TypeScript 最终验收（2026-11-03）

- `src/agent/harness.test.ts`：§7.1–7.9 全部，双 API、allow-list、严格参数、预算、轮数、tool data 角色隔离、取消和 reasoning continuation。
- `src/agent/control.test.ts`：真实临时 Git 仓库、路径/基线变化、会话绑定、审批防伪造、事务故障回滚、队列入场、取消/恢复、中断不重放和成功落盘故障停止 worker。
- `src/agent/process.test.ts`：两套 JSONL 协议、固定 argv/stdin、只读配置、子进程错误/限制、stubborn 进程组取消、稳定 0700 cwd 与符号链接拒绝。
- `src/storage/agents.test.ts`：真实旧 v4 schema 迁移，保留原文对话、pending action 和 queued task，外键检查为空。
- `src/runtime/local-web.test.ts`：真实 loopback HTTP → 明确批准 → fake runner → SSE → 最终结果、类型剥离的新增 UI 资源。
- `src/mcp/server.test.ts`：CLI 子 MCP 在协议层仅注册三个只读工具；`propose_entry` 不存在且不写入。
- `web/tests/ui-tasks.test.ts`：创建提案不批准、原指令绑定、模型文本/HTML 转义和完成状态。

完整 `npm run check` 删除前通过 329 后端 + 51 前端；最终删除后通过 331 后端 + 53 前端（384 项），详见 [TS_ACCEPTANCE.md](TS_ACCEPTANCE.md)。旧资产测试从 10 个浏览器模块更新为 11 个，并明确断言新增 `agents.ts`，仍逐一检查类型已剥离；v3 迁移测试改为构造真实 v3 schema，避免把最新数据库仅删表伪装成旧库。无测试被跳过或删除。

真实 CLI/模型另行 smoke，不进入自动门禁。手工测试先填写 CLI 配置，确认创建提案不启动进程、批准后只读运行、恢复保持 workspace/backend、取消能结束进程。不要用真实数据或收费模型冒充 fake 测试结果。

Q1 收口追加 `src/agent/control.test.ts` 回归：提前创建的恢复提案在前次失败/取消后拒绝批准和启动；未 reconcile 的 queue 终态也不能绕过检查；通用取消后超过 200 条队列历史淘汰不破坏 Agent 列表；入队失败同步回滚；遗留缺队列记录稳定失败；反向成功状态 fail closed。完整门禁 368 后端 + 53 前端通过。
