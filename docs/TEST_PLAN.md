# Doggie 测试与验收计划

## 1. 固定门槛

每次提交前运行：

```bash
npm run check
git diff --check
```

Rust workspace 只在需要裁决迁移前行为或重新生成 parity fixture 时运行，不属于 TypeScript 产品的日常门禁。

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
