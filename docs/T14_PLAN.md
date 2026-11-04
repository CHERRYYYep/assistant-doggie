# T14：TODO 生命周期与 Agenda 规划

日期：2026-11-04（Asia/Shanghai）。

本文只规划 T14，不启动 T15 调度通知、T16 插件或 T17 导出/导入实现。T14 的目标是让现有 `memory_items.kind = todo` 从“模型提取出的文本”升级为可查询、可修改、可审计的个人 TODO 对象，同时保持 Entry 原文和撤销边界不变。

## 1. T14 的目标与非目标

T14 完成后，用户可以：

- 在一个 Agenda 中查看开放、进行中、阻塞、已完成和已取消的 TODO；
- 区分 `SCHEDULED`（计划开始/提醒关注）和 `DEADLINE`（最晚完成时间）；
- 手动修改 TODO 状态、计划时间和截止时间；
- 查看 TODO 的来源 Entry、Bucket 和原文；
- 在刷新、重启和查询后得到一致结果；
- 对重复 TODO 查看下一次发生时间，并在完成后产生下一次开放发生项；
- 撤销来源 Entry 后自动停止显示其 TODO，不留下可操作的孤儿任务。

T14 不包含：

- 系统通知、后台 tick、错过任务补跑或无人值守执行；这些属于 T15；
- 外部日历、邮件、手机同步或远程访问；
- 模型自动替用户完成 TODO；
- 任意 RRULE 方言、复杂节假日计算或跨时区协作；
- 彻底删除原文和审计；
- 大规模视觉重设计。

## 2. 现状审查结论

当前已经存在：

- `MemoryKind.Todo`；
- `memory_items.status`，模型提取默认写入 `open`；
- `memory_items.due_at` 和 `metadata_json`；
- Entry 撤销后有效 TODO 会退出查询、证据和后续模型上下文；
- Bucket 详情和自然语言查询可以显示 Memory。

当前缺少：

- 明确的 TODO 状态机；
- `SCHEDULED` 与 `DEADLINE` 的区分；
- 重复规则和下一次发生项；
- TODO 专用读写用例和并发保护；
- Agenda 查询合同；
- 状态变更审计和来源绑定；
- 前端 TODO 操作和空/加载/冲突状态。

因此，“schema 不用改”的旧计划只能理解为可以复用 `memory_items`，不能理解为现有字段已经足够表达 T14 的全部语义。建议做小型 schema v7 迁移，而不是新增独立 TODO 大表。

## 3. 建议的领域合同

### 3.1 TODO 状态

第一版使用五个状态：

```text
open | in_progress | blocked | done | cancelled
```

推荐状态转换：

- `open` → `in_progress`、`blocked`、`done`、`cancelled`；
- `in_progress` → `open`、`blocked`、`done`、`cancelled`；
- `blocked` → `open`、`in_progress`、`cancelled`；
- `done` → `open`；
- `cancelled` → `open`。

`done` 和 `cancelled` 不允许直接修改为另一个终态，必须先明确重新打开。每次转换都保留 command text、操作者来源、前后状态和时间。模型提取只能创建 `open`，不能自动完成、取消或阻塞 TODO。

### 3.2 时间语义

- `scheduled_at`：计划开始或应被用户关注的时间；
- `due_at`：截止时间；
- 两者都允许为空，可以同时存在；
- 对外统一使用带时区的 ISO 8601 时间；输入中的日期-only 或自然语言必须先解析为用户时区，再保存规范值，同时保留原始表达；
- 没有明确时区时使用本机配置的 IANA 时区，不静默当作 UTC；
- `scheduled_at > due_at` 直接拒绝；
- 已过期只影响 Agenda 分组，不自动改变 TODO 状态；
- `done`/`cancelled` 的时间由审计记录表达，不覆盖原始截止时间。

### 3.3 重复规则

T14 先支持一个受限、可验证的规则对象，不接受任意 RRULE 字符串：

```ts
type RepeatRule = {
  readonly frequency: "daily" | "weekly" | "monthly";
  readonly interval: number;       // 1..31
  readonly weekdays?: readonly number[]; // 1..7，仅 weekly
  readonly until?: string;         // ISO 8601，含边界
  readonly count?: number;         // 1..366
};
```

`until` 与 `count` 不能同时出现。第一版按“完成当前发生项后计算下一项”推进，不由 T14 后台自动生成未来任务。下一次发生项必须可由纯函数确定，并记录在审计中。复杂月末、节假日和跨 DST 的行为先写成测试再实现；无法无歧义计算时拒绝规则。

### 3.4 来源与撤销

TODO 仍然是 Entry 派生 Memory，不是脱离原文的独立事实：

- TODO 必须保留 `entry_id`，来源 Entry 撤销后 TODO 退出有效集合；
- 用户状态变更不修改 Entry 原文；
- 用户调整只写 correction/audit，并更新 TODO 的当前投影；
- 不跨 Entry 自动合并相似 TODO；
- 重复状态请求使用 `expected_updated_at` 或版本字段防止旧页面覆盖新状态。

## 4. 最小存储设计

建议新增 schema v7，继续使用 `memory_items`，不创建独立 TODO 表：

- `scheduled_at TEXT NULL`；
- 保留已有 `due_at TEXT NULL`；
- `todo_rule_json TEXT NULL`，保存经过 Zod 校验的 `RepeatRule`；
- `todo_raw_time_json TEXT NULL`，保存必要的原始时间表达和解析时区；
- `todo_occurrence INTEGER NULL`，保存当前重复发生项序号，避免用 `metadata_json` 猜测 `count` 进度；
- 继续使用 `status` 保存当前生命周期状态；
- 使用 `updated_at` 与 correction audit 作为并发版本和变更依据。

如果实现阶段证明 SQLite 列约束、导出/导入或查询索引需要独立结构，再评估 TODO 表；在证据出现前不引入第二套权威对象。

迁移要求：

- 旧 todo 行默认 `status = open`；
- 旧 `due_at` 原样保留，不擅自解释为 `scheduled_at`；
- 非 TODO Memory 的新列保持 NULL；
- 迁移可重跑、事务化，并通过数据库重开测试；
- Entry 撤销、Bucket 删除和历史 orphan 规则保持现有行为。

## 5. 应用服务拆分

新增独立 `TodoService`，不把状态机塞进 HTTP route 或前端：

1. `listAgenda(input)`：按时间窗口、状态、Bucket 和 overdue 规则返回稳定排序结果；
2. `getTodo(id)`：返回 TODO、来源 Entry、Bucket 和审计摘要；
3. `transitionTodo(id, command)`：校验状态转换、来源有效性、版本和事务；
4. `updateTodoPlan(id, command)`：修改 scheduled/deadline/repeat，禁止写入非 TODO Memory；
5. `advanceRepeatingTodo(id, command)`：完成当前发生项并计算下一项，整个动作单事务完成；
6. `reopenTodo(id, command)`：显式恢复 done/cancelled TODO 为 open。

服务层必须拒绝：已撤销来源、已删除 Bucket、非 TODO Memory、非法时间范围、非法重复规则和旧版本覆盖。

## 6. HTTP 与前端 MVP

建议增加以下最小 HTTP 能力，最终名称以 operation registry 评审为准：

- `GET /api/agenda`：返回窗口内 TODO、分组、计数和当前时间快照；
- `GET /api/todos/:todoId`：返回 TODO 及来源；
- `POST /api/todos/:todoId/transition`：状态变更；
- `POST /api/todos/:todoId/plan`：计划时间/截止时间/重复规则变更；
- `POST /api/todos/:todoId/advance`：完成并推进重复 TODO；
- `POST /api/todos/:todoId/reopen`：显式重新打开。

所有写请求都必须包含 `command_text` 和 `expected_updated_at`，响应返回新的 TODO 投影与 correction ID。不要把 TODO 状态修改伪装成 Entry 重新归档，也不把普通 POST 宣称为全都幂等。

前端只实现功能性 Agenda：

- 按今天、逾期、未来、无日期和已完成分组；
- 点击 TODO 查看来源 Entry/Bucket；
- 完成、阻塞、取消、重新打开；
- 修改计划/截止时间；
- 处理中、冲突、失败和撤销后的状态清晰；
- 复用现有样式 token，不启动整体视觉改版。

## 7. 实施阶段

### T14-A：语义冻结

产出领域类型、状态转换表、时间/重复规则解析规则和不变量测试。此阶段不改 HTTP/UI。

退出条件：所有非法状态转换、日期边界、时区、重复规则和撤销来源场景都有明确结果。

### T14-B：schema v7 与 Store

实现迁移、todo row parser、Agenda 查询、版本字段、事务状态变更和审计投影。

退出条件：临时 SQLite、旧库重开、迁移失败回滚、并发旧版本拒绝、撤销/删桶后有效读取均通过。

### T14-C：Application 与 HTTP 契约

实现 `TodoService`、operation registry、OpenAPI、错误投影和浏览器 API。成功响应继续由服务端 schema 与浏览器生成规则共同验证。

退出条件：所有路由有严格 request/response schema，内部非法输出转为 500，未知字段和重复 query 被拒绝。

### T14-D：功能性 Agenda UI

加入最小列表、筛选、状态操作和来源跳转，不做布局重构、主题重设计或移动端远程接入。

退出条件：桌面和窄屏的基本可操作性、空/加载/失败/冲突/撤销状态通过 DOM 和有限浏览器 smoke。

### T14-E：联合验收与阶段提交

通过真实 loopback、临时数据库、fake model 和浏览器 API 模块验收；补齐文档、OpenAPI 和 `npm run check`，单独提交 T14。

## 8. 测试矩阵

- `domain`：状态机、时间解析、时区、重复规则、下一次发生项；
- `storage`：schema v7、迁移、查询排序、事务回滚、版本冲突、数据库重开；
- `application`：状态变更、来源绑定、重复推进、撤销和 Bucket 删除；
- `http`：Agenda 查询、所有写请求、错误映射、响应契约和资源上限；
- `frontend`：生成契约解析、空/加载/失败/冲突、XSS、旧响应不能覆盖新状态；
- `runtime`：归档提取 TODO → Agenda → 状态变更 → 查询 → 撤销 → 重启；
- `MCP`：T14 不新增写工具；如未来展示 TODO，只增加受控只读投影。

普通测试全部使用 fake model、临时 SQLite 和无公网环境。真实模型日期抽取、真实系统通知和真实 CLI 不进入普通门禁。

## 9. T14 完成标准

T14 只有同时满足以下条件才标记完成：

- TODO 状态、时间和重复语义写入领域不变量；
- 数据库迁移可重开且旧数据不被误解释；
- 用户变更有来源、版本和审计，不能被旧页面静默覆盖；
- Agenda 查询稳定、可筛选、可解释；
- Entry 撤销后 TODO 不再进入有效 Agenda；
- HTTP/OpenAPI/浏览器契约一致；
- 功能性 UI 可完成状态操作并正确处理失败；
- `npm run check`、T14 定向集成测试和文档检查全部通过。

## 10. 产品决定与实现默认值

以下三项已经确认：

1. TODO 使用五状态：`open / in_progress / blocked / done / cancelled`；
2. 重复 TODO 在用户完成当前发生项后计算并推进下一次，不由后台自动生成多个 occurrence；
3. 采用 schema v7 的显式字段，不把核心计划语义隐藏在 `metadata_json` 中。

以下是进入 T14-A 时采用的实现默认值，若真实需求出现再单独调整：

- 默认时区取运行时配置的 IANA 系统时区，同时在 TODO 计划中保存解析时区；
- Agenda 默认显示 open、in_progress、blocked、逾期和近期项目，done/cancelled 通过历史筛选查看；
- 先完成非重复 TODO 的完整生命周期，再在同一 T14 阶段接入受限 repeater；重复规则不能阻塞普通 TODO 的交付。

因此可以进入 T14-A（领域语义与不变量）；完成 T14-A 的测试后再进入 schema v7 和 Store 实现。
