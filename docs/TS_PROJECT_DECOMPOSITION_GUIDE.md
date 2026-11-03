# Doggie TypeScript 重构版：项目拆解与实现讲解

> 面向对 TypeScript 不熟悉、但希望理解 Doggie 设计与实现方式的读者。
>
> 本文**只讲当前 TypeScript 重构版**。当前分支已在 T13 验收后移除 Rust 源码；历史参考保留在 Git 中。

---

## 1. 先记住一句话：Doggie 到底是什么

Doggie 不是一个“让模型自由调用数据库”的聊天机器人，而是一个：

> **由模型负责理解，由确定性代码负责校验，由 SQLite 负责持久化，由 HTTP/UI 负责交互的个人工作记忆系统。**

一次输入的大致过程是：

```text
用户输入
  ↓
HTTP 边界校验
  ↓
归档运行时 ArchiveRuntime
  ├─ 获取候选 Bucket
  ├─ 调用模型分类
  ├─ 服务端低信息/置信度/候选门控
  ├─ 必要时调用模型提取结构化 memory
  └─ SQLite 事务写入或创建待确认 attempt
  ↓
HTTP projection
  ↓
前端渲染
```

查询则是另一条只读路径：

```text
用户查询
  ↓
解析自然语言查询计划
  ↓
SQLite 查询 Entry/Bucket/memory
  ↓
确定性打分、筛选、去重、聚合
  ↓
返回证据和查询计划
```

最重要的工程原则是：

> **模型输出是建议，不是授权。**

模型可以建议“追加到 Bucket A”，但最终是否写入必须由 TypeScript 的领域规则、应用服务和事务共同决定。

---

## 2. 当前 TypeScript 版本的技术栈

### 2.1 运行时：Node.js 24

项目使用 Node.js 原生执行 TypeScript：

```bash
node src/某个文件.ts
```

这里没有传统意义上的 TypeScript 编译产物。`tsconfig.json` 使用：

```json
{
  "noEmit": true,
  "erasableSyntaxOnly": true,
  "verbatimModuleSyntax": true,
  "allowImportingTsExtensions": true
}
```

含义是：

- `tsc` 只做类型检查，不生成 JavaScript；
- 代码必须使用 Node 能直接剥离的 TypeScript 类型语法；
- 不使用会生成运行时 JavaScript 的 `enum`、`namespace`、参数属性等语法；
- import 明确写 `.ts` 后缀；
- 运行时依赖 Node 24 的 TypeScript type stripping。

例如，项目不写：

```ts
enum BucketType {
  Task = "task",
}
```

而是写：

```ts
export const BucketType = {
  Task: "task",
} as const;

export type BucketType =
  (typeof BucketType)[keyof typeof BucketType];
```

这样同时得到：

- 运行时可用的 `BucketType.Task`；
- 编译时的字符串联合类型 `"task"`；
- 不需要生成额外 JavaScript。

### 2.2 SQLite：Node 内置 `node:sqlite`

存储层使用 Node 原生 SQLite API，不依赖 ORM。

这带来两个设计特点：

1. SQL 和 schema 都比较直接，容易审计；
2. 项目自己明确管理事务、迁移、外键、索引和投影。

### 2.3 HTTP：Hono + Node HTTP

HTTP 分成两层：

```text
Node http.createServer
  ↓
Request 转 Fetch Request
  ↓
Hono app.fetch()
  ↓
路由、Zod 校验、安全策略、API facade
```

对应文件：

- `src/http/server.ts`：Node 原生 HTTP server adapter；
- `src/http/app.ts`：Hono 路由和 HTTP 边界；
- `src/http/api.ts`：把 HTTP 调用组装到应用服务；
- `src/http/contracts.ts`：请求校验和 response projection；
- `src/http/security.ts`：Host、Origin 和安全响应头。

### 2.4 Zod：外部数据边界校验

Zod 用来校验：

- HTTP JSON 请求；
- 模型结构化输出；
- 工具参数；
- 枚举、必填字段、长度和未知字段。

TypeScript 的类型只在编译期存在。来自网络或模型的 JSON 在运行时仍然是 `unknown`，所以必须经过 Zod 或手写解析器。

### 2.5 原生测试：`node:test`

测试命令：

```bash
npm test
npm run test:web
npm run check
```

当前 `npm run check` 包括：

```text
Prettier 格式检查
→ TypeScript 类型检查
→ 后端/领域/存储/LLM 测试
→ 前端测试
```

---

## 3. 目录结构：先看“职责”，不要先看文件数量

当前 TS 主路径可以按下面方式理解：

```text
src/
├── domain/       纯领域规则，不访问数据库、不访问 HTTP、不访问模型
├── application/  归档、确认、查询、纠错、状态服务与后台队列
├── storage/      SQLite 数据库、schema、事务、查询和写入
├── llm/          模型端点、transport、结构化输出、wire response
├── http/         Hono 路由、HTTP DTO、安全策略、Node server adapter
├── agent/        多轮只读 Harness、工作区与 CLI 编排
├── mcp/          MCP stdio 工具服务
├── runtime/      环境配置和生产组装
└── evaluation/   分类/提取评测，不属于在线请求主路径

web/
└── assets/       浏览器端 TypeScript UI
```

目录及产品状态已在 T13 更新，完整验收见 [TS_ACCEPTANCE.md](TS_ACCEPTANCE.md)。阅读时以实际 import、入口和测试为准。

---

## 4. TypeScript 初学者需要先理解的几个概念

### 4.1 `type` 不是运行时对象

```ts
type BucketId = string;
```

这只帮助 TypeScript 检查代码，运行时不会存在 `BucketId`。

所以这段代码不能验证外部输入：

```ts
function load(id: BucketId) {
  // id 在运行时仍然可能是任意字符串
}
```

如果数据来自 HTTP 或模型，需要运行时校验：

```ts
const schema = z.object({
  id: z.string().trim().min(1),
});

const value = schema.parse(input);
```

Doggie 把这个原则贯彻在 HTTP 和 LLM 边界：

> **类型负责开发期约束，schema 负责运行时约束。**

### 4.2 `unknown` 比 `any` 更安全

来自 JSON、catch 或第三方库的数据应该先当成 `unknown`，然后逐步缩小类型。

```ts
function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

项目的 `tsconfig.json` 开启了：

```json
"useUnknownInCatchVariables": true
```

这迫使错误处理代码不要默认假设异常一定是 `Error`。

### 4.3 私有字段 `#field`

应用服务中常见：

```ts
export class ArchiveRuntime {
  readonly #store: Store;
  readonly #model: StructuredOutputModel;
}
```

`#store` 是 JavaScript 真正的运行时私有字段，不是普通的 TypeScript `private` 注解。外部不能直接访问它。

### 4.4 `readonly` 是防止意外修改的设计信号

```ts
export type BucketView = {
  readonly id: string;
  readonly title: string;
};
```

这表示这个 projection 创建后不应该被随意修改。Doggie 大量使用 `readonly`，目的是让跨层数据传递更可预测。

### 4.5 `as const` 保留字面量类型

```ts
const action = {
  AskUser: "ask_user",
} as const;
```

如果没有 `as const`，TypeScript 可能把值推断成普通 `string`；有了它，才能得到精确的字面量类型。

### 4.6 `private constructor + static create` 是受控构造

领域对象如果不能随便构造，可以采用：

```ts
class SomeValue {
  private constructor(readonly value: string) {}

  static create(value: string): SomeValue {
    if (value.trim() === "") throw new Error("empty");
    return new SomeValue(value.trim());
  }
}
```

Doggie 主要使用函数、Zod 和 branded type 实现同类效果，例如 `BucketView` 会通过 `createBucketView()` 归一化后再暴露。

---

## 5. 领域层：项目最重要的“确定性安全核心”

目录：

```text
src/domain/
├── types.ts
├── classification.ts
├── memory.ts
├── text.ts
├── errors.ts
└── *.test.ts
```

领域层有一个非常重要的约束：

> **领域层不应该知道 HTTP、SQLite、fetch 或模型端点。**

这样分类安全规则可以独立测试，也不会因为换 HTTP 框架或换模型供应商而改变。

### 5.1 核心业务对象

#### Bucket

Bucket 是长期工作上下文，而不是普通文件夹。

它有：

- `id`；
- `title`；
- `type`；
- `status`；
- `summary`；
- `tags`；
- `created_at`、`updated_at`、`last_active_at`；
- 下面的 Entry 和 memory。

类型包括：

```text
idea
 task
 incident
 experiment
 decision
 meeting
 knowledge
 draft
```

#### Entry

Entry 是用户原始输入的一次归档记录。

它保留：

- 原文 `raw_text`；
- 分类结果；
- 摘要；
- 创建时间；
- 所属 Bucket；
- 移动来源；
- archive state。

**原文保留是一个核心产品原则。**结构化提取可以出错，但原文不能因为模型摘要而丢失。

#### Memory

Memory 是从 Entry 中提取出的结构化工作信息，例如：

- `summary`；
- `evidence`；
- `timeline`；
- `todo`；
- `decision`；
- `hypothesis`；
- `entity`；
- `tag`。

它用于查询和展示，但不是原始事实的唯一来源。

#### Archive attempt

当系统不能安全自动写入时，不直接创建 Entry，而是保存一个 pending archive attempt：

```text
用户原文
  ↓
分类结果需要确认
  ↓
保存待确认 attempt
  ↓
用户选择推荐 Bucket / 其他 Bucket / 新建 / 不保存
```

attempt 是确认流程的 durable state，不能只放在前端内存里。

---

## 6. 突出设计一：模型 confidence 不是写入授权

这是整个项目最值得学习的设计。

`src/domain/classification.ts` 开头就明确表达了规则：

> 模型的 confidence 不是授权持久化的凭证。

模型可以返回：

```json
{
  "action": "append_existing",
  "bucket_id": "bucket-a",
  "confidence": 0.98
}
```

但服务端仍会继续检查：

1. 输入是不是低信息；
2. Bucket 是否来自服务端候选；
3. 候选是否唯一；
4. confidence 是否是有限数；
5. confidence 是否达到自动归档阈值；
6. action、Bucket ID、候选列表是否互相一致。

任何规则都只能把结果降级：

```text
append_existing → ask_user
create_new      → ask_user
```

但不能把不安全结果升级成自动写入。

### 6.1 低信息门控

例如：

```text
“它现在正常了”
“那个继续”
“搞定了”
“更新一下”
```

这些句子可能对人有意义，但缺少可长期复用的事实。即使模型认为它们应该归到某个 Bucket，也不应静默写入。

如果句子包含足够具体的信息，例如：

```text
“支付回调从 10:20 开始恢复，502 错误率下降到 0.2%。”
```

才可能继续进入自动归档流程。

### 6.2 为什么这比单纯提高模型准确率更重要

模型准确率永远不是 100%。工作记忆系统最糟糕的错误不是“没保存”，而是：

> 把错误事实永久保存到错误上下文，之后查询又把它当成事实返回。

所以 Doggie 的策略是：

```text
不确定 → 请求确认
而不是
不确定 → 猜一个并写入
```

### 6.3 如何实现类似规则

实现步骤：

1. 定义模型输出的候选动作；
2. 写一个纯函数 `postprocessClassification()`；
3. 所有自动写入前都调用它；
4. 让规则只允许降级，不允许升级；
5. 为每条规则写测试；
6. 把原始模型结果和服务端最终结果分开保存。

不要把这类规则放在 HTTP handler 里，也不要只写在 system prompt 中。

---

## 7. 突出设计二：服务端生成候选，模型不能凭空指定 Bucket

归档时，应用层先从 SQLite 读取候选 Bucket。候选通常按：

- 最近活跃；
- 热门活跃；
- 当前状态；
- 服务端排序；
- 候选数量上限；

构造一个有限集合。

模型只能在这个上下文中建议：

```text
追加到已有 Bucket
或
创建新 Bucket
或
询问用户
```

如果模型返回的 Bucket ID 不在服务端候选集合中，不能直接写入，应该降级为确认。

这解决两个问题：

1. 模型不能引用任意不存在或不应暴露的 ID；
2. 分类结果与服务端当前工作空间状态保持一致。

注意“当前 focus Bucket”不是唯一权威。当前实现强调候选由服务端自动生成，避免 UI 当前浏览位置影响归档判断。

---

## 8. 突出设计三：确认流程是后端状态机，不是前端布尔值

错误做法是：

```ts
if (body.confirmation_granted === true) {
  save(body.text, body.bucket_id);
}
```

这会导致客户端可以伪造 confirmation。

Doggie 的正确思路是：

```text
第一次请求
  → 创建 pending attempt
  → 返回 attempt_id 和候选

确认请求
  → 验证 attempt_id 存在
  → 验证 attempt 仍是 pending
  → 验证原文完全一致
  → 验证目标 Bucket 存在且 active
  → 验证 action 合法
  → 在事务中消费 attempt 并写入
```

### 8.1 确认支持的分支

- 追加到推荐 Bucket；
- 追加到其他候选 Bucket；
- 创建新 Bucket 并保存；
- 不保存，直接丢弃待确认内容。

### 8.2 为什么 attempt 必须持久化

如果 pending 状态只在前端：

- 刷新页面会丢失；
- 服务重启会丢失；
- 重复点击难以防止；
- 客户端可篡改原文和 Bucket；
- 并发确认没有明确状态。

因此，attempt 必须是数据库里的状态记录。

### 8.3 如何实现

建议把确认写成显式的 application service 方法：

```ts
async confirm(request: ConfirmationRequest): Promise<ConfirmationResult> {
  const attempt = store.getPendingAttempt(request.attempt_id);

  if (attempt === undefined) throw ...;
  if (attempt.rawText !== request.text) throw ...;
  if (attempt.state !== "needs_confirmation") throw ...;

  return store.withTransaction(() => {
    // 1. 再次消费 pending attempt
    // 2. 校验目标 Bucket
    // 3. 写入 Bucket / Entry / Memory / Audit
    // 4. 返回持久化结果
  });
}
```

重复提交必须得到冲突或稳定错误，而不能生成第二条 Entry。

---

## 9. 突出设计四：结构化模型输出 + 运行时 schema 校验

LLM 目录：

```text
src/llm/
├── config.ts
├── contracts.ts
├── structured-output.ts
├── wire-response.ts
├── transport.ts
└── *.test.ts
```

模型不是直接返回一个可信的 TypeScript 对象。完整过程是：

```text
模型 HTTP 响应
  ↓
解析 Responses / Chat Completions wire format
  ↓
识别 final text / tool call / refusal / incomplete
  ↓
Zod schema 校验
  ↓
业务 contract parser
  ↓
领域对象
```

### 9.1 为什么需要 wire response 层

不同模型接口可能返回：

- final answer；
- tool call；
- refusal；
- incomplete；
- content filter；
- 非 terminal 状态；
- 非法或不完整结构。

`src/llm/wire-response.ts` 的职责是把供应商响应归一化为有限结果，而不是让上层到处判断原始 JSON。

典型结果可以抽象为：

```ts
type WireResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_calls"; readonly calls: readonly ToolCall[] }
  | { readonly kind: "refusal"; readonly message: string }
  | { readonly kind: "incomplete"; readonly reason: string };
```

### 9.2 为什么不能只依赖 TypeScript interface

下面的 interface 不会在运行时检查 JSON：

```ts
interface ModelClassification {
  action: string;
  confidence: number;
}
```

模型可以返回：

```json
{
  "action": "delete_everything",
  "confidence": "very sure",
  "unknown": "...")
}
```

所以必须使用 Zod：

```ts
const classificationSchema = z.object({
  action: z.enum(["append_existing", "create_new", "ask_user"]),
  confidence: z.number().finite().min(0).max(1),
}).strict();
```

`.strict()` 很重要：未知字段不会静默混入业务对象。

### 9.3 结构合法不等于事实真实

Zod 只能证明：

```text
字段存在、类型正确、枚举合法、长度合法
```

不能自动证明：

```text
模型没有编造数字、摘要忠实于原文、时间线没有虚构
```

因此项目额外保留了 `src/evaluation/`，用于分类和提取忠实度评测。

---

## 10. 突出设计五：SQLite canonical schema + 事务

目录：

```text
src/storage/
├── database.ts
├── schema.ts
├── store.ts
├── summary.ts
└── *.test.ts
```

### 10.1 为什么使用 canonical schema

canonical schema 意味着：

- 当前版本只有一套权威数据模型；
- HTTP、应用和查询都围绕它工作；
- 旧数据导入需要经过边界转换；
- 不让历史 schema 直接污染当前业务模型。

### 10.2 数据库启动过程

`openDatabase()` 大致做：

```text
打开 SQLite
  ↓
开启 foreign_keys
  ↓
设置 busy_timeout
  ↓
设置 WAL / synchronous
  ↓
拒绝不属于 Doggie 的外部表
  ↓
执行未完成 migration
  ↓
检查最终 schema version
```

这比“打开文件然后直接 CREATE TABLE IF NOT EXISTS”更可控。

### 10.3 事务边界

`withTransaction()` 的核心思想是：

```ts
BEGIN IMMEDIATE
try {
  执行所有写入
  COMMIT
} catch (error) {
  ROLLBACK
  throw error
}
```

一次归档可能同时写入：

- Bucket；
- Entry；
- memory；
- tags；
- summary；
- classification audit；
- archive attempt。

如果任意一步失败，不能留下“Bucket 已创建但 Entry 不存在”的半成品。

### 10.4 为什么 `BEGIN IMMEDIATE`

普通 deferred transaction 可能到了提交时才发现写冲突。`BEGIN IMMEDIATE` 会更早获得写锁，使冲突在事务开始阶段暴露。

它的作用不是提高模型准确率，而是保护数据库状态一致性。

### 10.5 Store 不应该暴露任意 SQL

应用层最好调用：

```ts
store.appendEntry(...)
store.createConfirmationAttempt(...)
store.resolveConfirmationAttempt(...)
store.moveEntry(...)
```

而不是到处拼接：

```ts
database.prepare(`UPDATE ${table} SET ...`).run(...)
```

这样才能把：

- 字段校验；
- 事务；
- 审计；
- 级联关系；
- summary 重建；

集中维护。

---

## 11. 突出设计六：查询不是简单 SQL LIKE，而是 Query Plan

目录：

```text
src/application/memory-query.ts
src/application/query.ts
```

用户可以输入：

```text
“查询接口 A 最近两周的压测结果”
```

系统先解析成结构化计划：

```text
rawText: 接口 A 最近两周的压测结果
entityTerms: 接口 A
 topicTerms: 压测、结果
bucketTerms: ...
timeRange: now - 14 days 到 now
statuses: ...
structuredFilters: ...
limit: ...
```

然后查询阶段综合：

- Bucket 标题；
- Bucket summary；
- Entry 原文；
- Entry summary；
- tags；
- entity；
- structured memory；
- 时间范围；
- 生命周期状态。

最后输出：

- Entry 级结果；
- Bucket 分组；
- 匹配字段；
- score；
- evidence；
- query plan；
- answer projection。

### 11.1 为什么要返回 query plan

如果只返回一句答案，用户无法知道系统如何理解问题。

返回 query plan 可以让系统可解释：

```text
我把“最近两周”理解成 2026-08-11 到 2026-08-25，
把“接口 A”当作实体条件，
把“压测结果”当作主题条件。
```

这对调试查询错误也很有帮助。

### 11.2 查询必须是只读

查询路径不能偷偷刷新 Bucket 活跃时间，也不能产生归档写入。

这是一个容易被忽略的不变量：

> 读取历史不应该改变历史状态。

---

## 12. 突出设计七：HTTP 使用边界校验和 projection 隔离内部模型

### 12.1 Hono app

`src/http/app.ts` 主要负责：

- 定义路由；
- 读取 query/path/body；
- 使用 Zod 校验；
- 调用 `DoggieHttpApi`；
- 映射错误为稳定 JSON；
- 设置安全 response headers；
- 提供静态前端资源。

它不应该直接操作 SQLite。

### 12.2 HTTP API facade

`src/http/api.ts` 的 `ConcreteDoggieHttpApi` 把 HTTP 操作组装到应用层：

```text
HTTP route
  → ConcreteDoggieHttpApi
  → ArchiveRuntime / MemoryQueryService / CorrectionService
  → Store
```

这样 Hono route 不需要知道复杂的领域流程。

### 12.3 DTO projection

数据库字段和 HTTP 字段不应该直接混用。

例如数据库使用：

```text
bucketId
createdAt
archiveState
```

HTTP 使用：

```json
{
  "bucket_id": "...",
  "created_at": "...",
  "archive_state": "..."
}
```

`projectBucket()`、`projectEntry()`、`projectMemory()` 等函数就是边界投影。

好处：

- 内部字段命名可以变化；
- API 契约稳定；
- 不会意外把内部对象全部暴露给客户端；
- 前端和后端共享明确的 snake_case DTO。

### 12.4 本地 HTTP 安全

`src/http/security.ts` 和 `src/http/server.ts` 处理：

- Host 校验；
- Origin 校验；
- `Origin: null` 拒绝；
- body 请求必须使用 JSON Content-Type；
- CSP；
- `nosniff`；
- `Referrer-Policy`；
- request size；
- duplicate Host / Content-Length；
- chunked body 边界。

默认本地单用户部署仍然不等于有认证。当前定位是：

```text
防浏览器跨源副作用
≠
防同机恶意进程
≠
防局域网未授权访问
```

---

## 13. 前端 TypeScript 如何拆解

目录：

```text
web/assets/
├── api.ts
├── app.ts
├── dom.ts
├── state.ts
├── views.ts
├── markdown.ts
├── render-archive.ts
├── render-bucket.ts
├── render-chat.ts
└── render-query.ts
```

### 13.1 分层方式

```text
app.ts
  ↓ 事件绑定
views.ts
  ↓ 页面控制器和异步流程
api.ts
  ↓ fetch 和 DTO
render-*.ts
  ↓ 纯渲染
state.ts
  ↓ 前端状态
 dom.ts
  ↓ 已查询的 DOM 节点
```

### 13.2 `api.ts`：只负责网络

`api.ts` 应该负责：

- 调用 `/api/chat`；
- 调用 `/api/chat/confirm`；
- 调用 `/api/buckets/...`；
- 编码 path/query 参数；
- 发送 snake_case JSON；
- 把非 2xx 转成稳定 Error。

它不应该操作 DOM。

### 13.3 `render-*.ts`：只负责把数据变成 DOM

例如：

- `render-chat.ts`：渲染聊天消息和确认卡片；
- `render-archive.ts`：渲染归档状态、推荐 Bucket、候选和选项；
- `render-bucket.ts`：渲染 Bucket 详情；
- `render-query.ts`：渲染查询计划、结果和 evidence。

渲染函数要特别注意：

> **所有用户内容都必须经过 HTML escape。**

Markdown 也不能直接使用 `innerHTML` 拼接未经处理的内容。项目的 `markdown.ts` 负责受限 Markdown 解析，并有危险 URL、属性逃逸、代码块和 HTML escape 测试。

### 13.4 `views.ts`：控制器

`views.ts` 负责：

```text
读取输入
  → 调 API
  → 更新 state
  → 重新 render
  → 更新 loading/error 状态
```

`app.ts` 只做事件绑定，不放复杂业务逻辑。

### 13.5 `app.ts`：入口

`app.ts` 的职责应该非常小：

- 给按钮绑定 click；
- 给输入框绑定 Enter；
- 调用 `views.ts`；
- 捕获错误并显示状态。

这是一种值得保留的前端设计：入口文件不承担业务。

---

## 14. 一条完整的 `/api/chat` 实现流程

把当前实现理解成下面的阶段最容易。

### 阶段 1：HTTP 接收

```text
Node IncomingMessage
  → 检查 raw headers
  → 读取 body
  → 构造 Fetch Request
```

### 阶段 2：Hono 边界

```text
POST /api/chat
  → Content-Type 校验
  → JSON 解析
  → chatRequestSchema.safeParse/parse
  → 得到 { message, focus_bucket_id? }
```

### 阶段 3：HTTP facade

`ConcreteDoggieHttpApi.chat()`：

1. 保存 user chat message；
2. 调用 `ArchiveRuntime.archive()`；
3. 得到 `archive projection`；
4. 如果配置了 chat responder，生成回答；
5. 保存 tool messages；
6. 保存 assistant message；
7. 返回统一 chat response。

### 阶段 4：归档运行时

```text
ArchiveRuntime.archive(message)
  → store.listActiveBuckets()
  → model.classify(message, candidates)
  → domain.postprocessClassification(...)
  → ask_user / append / create
  → 非 ask_user 时 model.extract(message)
  → store archive transaction
```

### 阶段 5：前端展示

```text
response.archive_state
  ├─ archived       → 显示已保存 Bucket/Entry
  ├─ needs_confirmation
  │    → 显示推荐/候选/新建/不保存
  └─ discarded      → 显示未保存
```

### 阶段 6：确认

```text
用户点击确认
  → frontend api.confirmArchive()
  → POST /api/chat/confirm
  → Zod 校验 discriminated request
  → attempt/text/target 重新验证
  → SQLite transaction
  → 更新 attempt 状态
  → 写入正式 Entry 或 discarded
```

---

## 15. Agent 部分：两层受控执行

T13 已实现 `src/agent/`，详细讲解和配置见 [AGENT_CONTROL.md](AGENT_CONTROL.md)。

第一层是网页回答的 `AgentHarness`：

```text
模型 function call → 固定 Map 工具表 → Zod 参数校验 → 只读 executor
       ↑                                             ↓
       └──────────── 工具结果作为数据回传 ────────────┘
```

工具名必须已注册且在允许列表中，写工具永远不进入回答阶段。`unknown` 参数先经 Zod 缩小类型，非法字段得到数据错误。轮数、每轮调用数和 UTF-8 字节预算由服务端控制；不能靠 prompt 约定无限循环会自行停止。Responses 和 Chat Completions 的 wire 差异仅体现在请求/续接格式，执行权限相同。

第二层是独立的 CLI 控制面：

```text
workspace（真实路径 + Git 内容基线）
  → session（不可换目录/backend）
  → task + pending action（不可改写提案）
  → 用户显式批准的事务 → T12 queue → 固定 argv spawn
```

数据库 schema v5 保存工作区、会话、任务和原文审批。`AgentService` 负责批准前及执行前校验，`CliAgentRunner` 负责 stdin、只读 CLI 配置、有界 JSONL 和进程组取消。无目录任务只给搜索和 Doggie 读取工具，使用稳定的 0700 私有 cwd。真实 CLI 使用自身登录，和网页 `OPENAI_API_KEY` 分开。

前端 `web/assets/agents.ts` 提供提案、批准/拒绝、结果、刷新恢复和取消；不会把模型返回值当作授权或可执行 HTML。本阶段只读，不开放文件写入、自动 Git 提交或部署。

---

## 16. 如何新增一个功能：推荐的实现顺序

假设要新增“给 Entry 添加优先级”功能，不要直接从前端开始写。

### 第一步：先确定领域概念

回答：

- 优先级有哪些合法值？
- 是否允许为空？
- 它属于 Entry 还是 memory？
- 用户能否纠正？
- 查询能否按它筛选？
- 是否影响 Bucket summary？

在 `src/domain/` 定义类型和规则。

### 第二步：更新 SQLite schema

在 `src/storage/schema.ts`：

- 增加 migration；
- 增加列或表；
- 增加索引；
- 更新 schema version；
- 增加打开旧库和重开测试。

### 第三步：更新 Store

在 `src/storage/store.ts`：

- 增加读写方法；
- 放入正确事务；
- 做字段校验；
- 确保失败回滚；
- 不暴露任意 SQL 给上层。

### 第四步：更新 application service

例如：

```ts
class EntryPriorityService {
  constructor(private readonly store: Store) {}

  setPriority(entryId: string, priority: EntryPriority) {
    // 业务规则和 store 调用
  }
}
```

应用层负责用例，不负责 HTTP JSON 格式。

### 第五步：更新 HTTP contract 和 DTO

在 `src/http/contracts.ts`：

- 定义请求 schema；
- `.strict()`；
- 限制长度和枚举；
- 明确错误映射。

在 `src/http/dto.ts` 或 projection 处：

- 输出稳定的 snake_case 字段。

### 第六步：更新 Hono route 和 API facade

在 `src/http/app.ts` 增加路径，在 `src/http/api.ts` 调用 application service。

不要让 Hono route 自己直接写 SQL。

### 第七步：更新前端 API、state、render、view

推荐顺序：

```text
api.ts
  → state.ts
  → render-*.ts
  → views.ts
  → app.ts 事件绑定
```

### 第八步：先写测试再扩展 UI

至少覆盖：

- domain 合法/非法值；
- storage 事务和重开；
- application 成功/失败；
- HTTP schema 和错误状态；
- 前端 DTO；
- XSS/escape 边界；
- 真实用户流程。

---

## 17. 如何新增一个模型结构化输出

假设新增“提取风险等级”。

推荐流程：

```text
定义领域结果
  ↓
定义 Zod input schema
  ↓
定义 JSON Schema 给模型
  ↓
定义 contract parser
  ↓
接入 structured-output adapter
  ↓
在 application 中消费
  ↓
写 fixture 和评测
```

不要只修改 prompt，然后在 application 里直接访问：

```ts
const result = (await model.call()) as any;
```

应当让模型输出经过：

```ts
const parsed = riskContract.parse(rawModelValue);
```

并明确区分：

- 供应商 wire response；
- contract input；
- 领域结果；
- 存储记录；
- HTTP DTO。

---

## 18. 测试地图：每一层测试什么

### Domain

文件：

```text
src/domain/*.test.ts
tests/low-information-gate.test.ts
```

测试：

- Bucket 类型和状态；
- action 一致性；
- confidence 范围；
- 低信息门控；
- 候选排序和去重；
- Unicode 文本归一化。

### Application

文件：

```text
src/application/*.test.ts
```

测试：

- 自动追加；
- 新建 Bucket；
- ask_user 不写 Entry；
- 确认精确绑定；
- 确认 replay；
- correction；
- status；
- query plan 和只读查询。

### Storage

文件：

```text
src/storage/*.test.ts
```

测试：

- migration；
- foreign keys；
- busy timeout 配置；
- transaction rollback；
- 数据库 reopen；
- summary；
- evidence 去重；
- 删除和移动；
- schema version。

### LLM

文件：

```text
src/llm/*.test.ts
```

测试：

- endpoint 配置；
- timeout；
- API key 脱敏；
- invalid JSON；
- refusal；
- incomplete；
- content filter；
- tool call；
- Responses/Chat 两种 wire format；
- retry 分类。

### HTTP

文件：

```text
src/http/*.test.ts
```

测试：

- 路由；
- 请求 schema；
- DTO projection；
- Host/Origin；
- Content-Type；
- Content-Length；
- chunked 请求；
- 错误 JSON；
- 静态资源；
- chat/confirm 端到端流程。

### Frontend

文件：

```text
web/tests/*.test.ts
```

测试：

- API 请求参数；
- path/query 编码；
- snake_case DTO；
- 删除请求 bodyless；
- HTML escape；
- safe URL；
- Markdown 代码块和列表；
- 恶意内容不能逃逸到 markup。

### Evaluation

文件：

```text
src/evaluation/*.ts
tests/fixtures/*.json
```

测试：

- 分类安全指标；
- confidence 分档；
- extraction 遗漏；
- 禁用词；
- 凭空数字；
- 人工标注 fixture 覆盖。

---

## 19. 当前项目最突出的设计总结

### 19.1 确定性规则覆盖模型不确定性

模型可以提出建议，但不能越过：

```text
Zod → domain gate → application service → transaction
```

### 19.2 不确定时确认，而不是静默写入

这保护的是长期记忆质量，而不仅是接口安全。

### 19.3 原文与结构化 memory 分离

即使提取错了，原文仍可追溯和纠正。

### 19.4 确认是持久化状态机

它支持重启恢复、防重放、防篡改，而不是只依赖前端按钮。

### 19.5 查询返回证据和 query plan

系统不仅给答案，也展示它如何理解查询、命中了哪些内容。

### 19.6 HTTP、应用、存储边界清晰

Hono 不直接碰数据库，Store 不负责 UI，领域层不依赖 HTTP 或 LLM。

### 19.7 测试从旧实现行为中提取不变量

TS 重构不是“重新凭感觉写一份代码”，而是用 fixture、测试和 parity snapshot 固定行为。

---

## 20. 当前 TS 版本需要特别注意的边界

### 20.1 TypeScript 类型不能代替运行时验证

凡是来自：

- HTTP；
- 模型；
- SQLite；
- 浏览器；
- 环境变量；

都应该先视为不可信数据。

### 20.2 prompt 不能代替权限

“请不要调用写工具”不是权限系统。真正的限制应该在：

- 工具注册；
- allow-list；
- Zod 参数校验；
- application service；
- 事务状态机。

### 20.3 结构化 JSON 不能代替事实校验

需要用 `src/evaluation/` 持续检查模型是否：

- 编造数字；
- 遗漏事实；
- 把推断写成原文事实。

### 20.4 HTTP 本地监听不等于认证

默认 loopback 的目标是本地 MVP。不要把 `Origin`/`Host` 检查误认为用户身份认证。

### 20.5 文档中的旧目录不一定等于当前代码

以实际 import、测试和 `package.json` 为准。当前 TS branch 的在线主路径是：

```text
src/domain
src/application
src/storage
src/llm
src/http
src/agent
src/mcp
src/runtime
web
```

---

## 21. 推荐阅读顺序

如果你对 TypeScript 不熟悉，建议不要一开始读所有代码。

### 第 1 步：读产品和不变量

```text
docs/PRD.md
docs/INVARIANTS.md
docs/TS_REWRITE.md
```

先理解“系统必须保证什么”，再看“代码怎么实现”。

### 第 2 步：读领域类型和门控

```text
src/domain/types.ts
src/domain/classification.ts
src/domain/text.ts
src/domain/classification.test.ts
```

重点理解：

```text
model confidence ≠ persistence authorization
```

### 第 3 步：读归档运行时

```text
src/application/archive-runtime.ts
src/application/archive.ts
src/application/archive-runtime.test.ts
```

跟踪：

```text
候选 → 分类 → 门控 → 提取 → 写入/确认
```

### 第 4 步：读 Store 和 schema

```text
src/storage/schema.ts
src/storage/database.ts
src/storage/store.ts
src/storage/store.test.ts
```

重点理解事务和数据图。

### 第 5 步：读 HTTP facade

```text
src/http/api.ts
src/http/contracts.ts
src/http/app.ts
src/http/security.ts
```

重点理解内部服务如何变成稳定 HTTP DTO。

### 第 6 步：读 LLM 边界

```text
src/llm/transport.ts
src/llm/wire-response.ts
src/llm/contracts.ts
src/llm/structured-output.ts
```

重点理解“原始模型 JSON 如何变成可信领域结果”。

### 第 7 步：读前端

```text
web/assets/api.ts
web/assets/views.ts
web/assets/render-chat.ts
web/assets/render-archive.ts
web/assets/app.ts
```

重点理解事件 → API → state → render。

### 第 8 步：最后读 evaluation

```text
src/evaluation/
tests/fixtures/
```

理解如何衡量模型的安全性和事实忠实度。

---

## 22. 推荐的本地验证命令

```bash
npm install
npm run check
```

拆开执行：

```bash
npm run format:check
npm run typecheck
npm test
npm run test:web
```

当前检查的意义：

- `format:check`：代码风格一致；
- `typecheck`：跨层类型契约没有明显断裂；
- `npm test`：领域、应用、存储、LLM、HTTP 和评测回归；
- `test:web`：前端 API、渲染和安全边界回归。

如果要运行真实模型评测，应把它和普通测试分开，不要让普通测试依赖 API key 或真实数据库。

---

## 23. 最后的心智模型

你可以把 Doggie TS 重构版记成六层：

```text
第 1 层：Domain
        什么输入和状态在业务上合法？

第 2 层：Application
        一个完整用户动作如何执行？

第 3 层：Storage
        如何可靠保存、查询、回滚和恢复？

第 4 层：LLM
        如何把不可靠模型输出变成受控结果？

第 5 层：HTTP
        如何把内部服务安全地暴露给客户端？

第 6 层：Frontend
        如何把稳定 DTO 渲染成可操作界面？
```

其中最核心的两条链是：

```text
模型不确定性
  → schema 校验
  → 确定性领域门控
  → 确认状态机
  → SQLite 事务
```

以及：

```text
内部领域对象
  → application service
  → HTTP DTO projection
  → frontend render
```

第一条链保证**安全和数据质量**，第二条链保证**可维护性和边界清晰**。

如果你后续要继续开发，优先遵循这两个原则：

1. **不要让模型直接决定写入；**
2. **不要让 UI 或 HTTP handler 直接承担领域和存储逻辑。**


## T11 补充：通用待批准动作（2026-10-08）

现在前端源码已位于独立 `web/`，生产入口为 `src/main.ts`，运行、类型检查、前端测试和 CI 不依赖 Rust/Cargo。

### 类型定义：判别联合而不是大而全的对象

`src/domain/pending-action.ts` 使用 `z.discriminatedUnion("kind", ...)` 同时提供运行时校验和 `z.infer` 类型：

```ts
type PendingActionDraft =
  | { kind: "archive"; payload: ArchivePayload }
  | { kind: "agent_task"; payload: { instruction: string; workspaceId: string | null } }
  | { kind: "scheduled_run"; payload: { scheduleId: string } }
  | { kind: "bulk_mutation"; payload: BulkPayload };
```

上面是简化讲解，真实定义以源码为准。`kind` 告诉 TS 应使用哪类 payload，Zod 的 `.strict()` 阻止运行时偷偷夹带其他字段。没有新增依赖、通用插件框架或复杂 class 继承。

### 持久化状态不等于执行权限

```text
proposal → pending → approved → executed
                  │          └→ failed
                  └→ rejected
```

动作包含 `proposedBy`、原文 `binding`、用户 `approval` 和结果 `result`。存储层会比对动作 ID、原文和当前状态，不能仅凭模型给出的高置信度批准。proposal 字段由 SQLite trigger 保护，后续不能替换输入再复用批准。

### 归档事务与兼容投影

schema v3 增加 `pending_actions`，自动在迁移事务中回填 TS v2 库的确认记录。原来的 `archive_attempts` **不直接删除**：纠错、历史卡片和 HTTP DTO 还需要它，它现在是归档审计 projection，不再是另一套授权入口。

归档确认在同一个事务内执行：

```text
校验 pending action + attempt + exact raw text
  → 记录用户 append/create 选择，status=approved
  → 写 Bucket / Entry / Memory
  → 更新归档审计，status=executed
  → commit
```

任何一步失败全部 rollback，原动作仍是 pending；“不保存”则将动作和归档审计一起标成拒绝。批准与执行之间不会留下可被重放的半成品 archive。

`ArchiveRuntime.appendConfirmed/createConfirmed` 不再另走直接写入分支，而是登记用户 proposal，再复用 `confirm()`。用户已经明确点击保存，因此不会重复弹出一次批准。该单次入口先提取再登记 proposal，模型失败不留下不可恢复的 pending；正式写入失败则保留 rejected 审计。已经有 UI 卡片的确认失败仍保留 pending 供重试。自动归档仍保留原有领域安全门控。

### 此阶段不实现什么

T11 当时只提供三类数据契约；T12/T13 现已新增队列、取消/SSE、只读 Harness，以及显式批准后执行的 CLI Agent 任务。`scheduled_run` / `bulk_mutation` 仍不执行，普通 MCP 仍只有读取工具和 `propose_entry`。

代码阅读顺序：`src/domain/pending-action.ts` → `src/storage/schema.ts` 的 v3 → `src/storage/pending-actions.ts` → `src/storage/store.ts` → `src/application/archive-runtime.ts` → `src/storage/pending-actions.test.ts`。


## T12 补充：理解 TS 的后台执行

详细实现见 [TASK_QUEUE.md](TASK_QUEUE.md)。这里没有把 TypeScript 当成需要编译的“另一套 Rust”：Node 原生 async 承担等待模型，SQLite 同步事务承担短时间确定性写入，两者的边界明确。

- `Promise<T>` 代表“未来返回 T”，并不代表工作在独立线程。单 worker 是用一个 `#worker: Promise<void>` 防止同时启动两次 drain；claim → await execute → finish 循环按持久化 sequence 顺序执行。
- `AbortController` 是发出取消的一方，`AbortSignal` 是传给下层的一方。把它作为最后一个可选参数，原有调用仍兼容；有 signal 的调用在 await 两侧和写入前检查。
- `ReadableStream<Uint8Array>` 是分块响应。SSE 发送的是任务状态 JSON，不是执行命令；`desiredSize` 与 socket `drain` 分别控制应用缓冲和网络背压。
- TypeScript 的联合类型约束内部状态，Zod 则在运行时验证外部 JSON/SQLite 行；两者不是替代关系。浏览器的 type-only import 会被 Node strip 掉，不把后端 Zod/数据库模块带入浏览器。
- `finally` 是生命周期底线：worker 无论成功/失败都清 timer，socket 无论断线/结束都清 listener，进程无论关闭哪层失败都等实际工作结束再关数据库。

最值得保留的设计不是某个框架，而是**授权、执行、观察三个边界分离**：批准状态机决定能不能写，queue 决定何时执行，SSE 只告诉 UI 当前是什么状态。
