# AGENTS.md instructions for /home/cherry/assistant-doggie

## 仓库定位

本仓库当前分支 `dev_ts` 的目标实现是 **TypeScript 本地优先个人工作记忆 Agent**。所有新功能、修复、测试和文档都必须以 TypeScript 路径为准。

Rust workspace 仅作为冻结的行为参考（oracle）保留，用于查询历史行为、运行差分测试或重新生成 parity fixture。除非任务明确要求维护参考实现，否则不得在 `crates/`、Rust Web server 或 Cargo 产品路径中新增功能，也不得把 `cargo run` 写成当前产品的启动方式。

当前 TypeScript 主路径：

- `src/domain/`：领域类型、Bucket/Entry/Memory 模型、低信息安全门控和确定性文本规则；不得访问数据库、HTTP 或模型。
- `src/application/`：归档、确认、纠错、Bucket 状态和自然语言记忆查询等用例服务。
- `src/storage/`：基于 Node 内置 `node:sqlite` 的 canonical schema、迁移、事务、查询和持久化。
- `src/llm/`：模型端点配置、Responses/Chat Completions 适配、HTTP transport、结构化输出和 wire response 归一化。
- `src/http/`：Hono 路由、HTTP DTO/contract、安全策略和 Node HTTP adapter。
- `src/mcp/`：Doggie MCP stdio server、严格工具 schema 和受控工具执行边界。
- `src/evaluation/`：分类与提取评测；真实模型评测不得进入普通测试链。
- `apps/doggie-local-web/frontend/`：当前复用的浏览器 UI 源码。该目录暂时保留在旧 Rust crate 下，后续按 `docs/PLAN.md` 搬迁；不要因此把 Rust Web runtime 视为目标实现。
- `bin/doggie-mcp`：本地 MCP 可执行入口。
- `tests/fixtures/`：从历史实现固化的 parity fixture。
- `docs/`：架构、不变量、数据模型、MCP、迁移边界和测试计划。

阅读和实施前优先查看：

- `docs/PLAN.md`：当前阶段、已完成任务和后续边界；
- `docs/INVARIANTS.md`：TypeScript 重构的可执行验收规格；
- `docs/TS_REWRITE.md`：技术选型和迁移定位；
- `docs/TS_PROJECT_DECOMPOSITION_GUIDE.md`：模块拆解与实现讲解；
- `docs/MCP_SERVER.md`：MCP 工具、安全模型和客户端接入方式；
- `docs/TEST_PLAN.md`：相关功能的回归要求。

## 运行环境与常用命令

需要 Node.js 24 或更新版本。项目依赖 Node 原生 TypeScript type stripping 和 `node:sqlite`，不生成 JavaScript 构建产物。

首次安装依赖：

```bash
npm ci
```

常用检查命令：

```bash
npm run format:check
npm run typecheck
npm test
npm run test:web
npm run check
```

`npm run check` 是 TypeScript 主路径的完整门禁，依次执行 Prettier、类型检查、后端测试和前端测试。CI 也只以该命令作为目标实现门禁。

启动 MCP server：

```bash
npm run mcp
# 或
/home/cherry/assistant-doggie/bin/doggie-mcp
```

MCP 使用 stdio；stdout 只能输出 MCP 协议数据，诊断日志必须写入 stderr。

当前仓库尚未提供完整的 TypeScript Web 进程 bootstrap/package script。不得虚构 `npm start`、`npm run dev` 或 `node src/main.ts`。实现 Web 启动入口时，应组装 `src/storage`、`src/llm`、`src/application` 和 `src/http`，并在 `package.json` 中提供明确脚本，同时更新 README 和本文件。

本地数据库、`.env`、API Key、`node_modules/`、日志、评测输出和构建产物不得提交。

## TypeScript 编码规范

遵循 `tsconfig.json` 的最高严格度设置和 Prettier 格式。重点要求：

- 使用 ESM，并在本地 import 中保留 `.ts` 后缀。
- 优先使用 `type`、字符串联合、`as const` 和显式返回类型。
- 外部输入一律先视为 `unknown`，通过 Zod 或明确的解析函数缩小类型；不得用 `as` 强行信任 HTTP、模型、数据库或 MCP 输入。
- 不使用 `any`；确实无法避免时必须限制在最小边界并说明原因。
- 保持 `erasableSyntaxOnly`：不得使用 `enum`、`namespace`、参数属性等需要 TypeScript 生成运行时代码的语法。
- 尊重 `exactOptionalPropertyTypes` 和 `noUncheckedIndexedAccess`，不要用非空断言掩盖缺失值。
- 公共对象优先 `readonly`；共享常量和协议对象应避免可变全局状态。
- 错误必须使用稳定、可测试的错误类型或错误投影，不把密钥、完整模型响应或内部堆栈泄露给用户。
- 服务层保持职责单一，不把业务逻辑塞入 HTTP route、MCP transport 或前端渲染代码。
- 跨层变化优先更新领域/协议契约和应用服务，再更新 HTTP/MCP projection。
- 只在确有必要时增加依赖；优先使用 Node 标准库和现有依赖。

## 核心业务与安全不变量

模型输出是建议，不是授权。任何模型高置信度都不能绕过 TypeScript 的领域规则、确认状态机和事务边界。

对用户可见的归档流程必须保留：

- `ask_user` 低信息安全门控；
- 推荐 Bucket、备选 Bucket、判断理由、创建新 Bucket 和“不保存”选项；
- confirmation 与持久化 pending attempt、原始输入和用户选择严格绑定；
- 归档后的 Bucket 修改入口；
- Entry 原文、结构化 memory、审计记录和可重放防护。

低信息输入宁愿多询问一次，也不能静默写入不确定的 Bucket。模型不得凭空指定服务端未提供的 Bucket；失效、非 active 或已删除 Bucket 不得成为写入目标。

HTTP 边界必须继续强制：

- 仅接受合法 loopback Host；
- 拒绝 foreign、opaque、重复或畸形 Origin/Host/Content-Type 等请求头；
- 有 body 的请求必须使用 JSON Content-Type；
- 保留请求大小、连接数、header timeout、request timeout 和每 socket 请求数限制；
- 保留 `no-store`、`nosniff`、`no-referrer` 和不含 `unsafe-inline` 的 CSP；
- 不为本地 API 开放宽泛 CORS。

MCP 边界必须继续强制：

- 默认只暴露 `list_active_buckets`、`search_memory`、`get_bucket_detail` 和 `propose_entry`；
- 前三个工具只读，`propose_entry` 只能创建待确认 proposal，不得直接创建正式 Entry/Memory；
- 不暴露直接创建、追加、移动、删除或归档写工具，除非规格、安全评审和测试同时更新；
- schema 拒绝未知字段，工具名使用 allow-list，并保留输入、输出和 stdio 消息资源上限；
- MCP 工具输出是协议数据，不得当作可执行命令。

## 测试要求

普通测试必须使用 fake model/transport 和临时 SQLite 文件，不调用真实模型、不访问真实用户数据库，也不依赖公网。

重点覆盖：

- `domain`：分类、低信息门控、确定性文本规则和查询计划解析；
- `llm`：严格结构化输出、wire response、重试分类、超时和密钥脱敏；
- `storage/application`：事务回滚、数据库重开、搜索、筛选、结果聚合、确认防重放和纠错审计；
- `http`：自动归档、确认分支、聊天历史、错误映射、安全请求头和资源上限；
- `mcp`：工具注册、未知工具拒绝、严格参数、只读保证、pending proposal 和输出上限；
- `frontend`：真实模块图、渲染行为、XSS 防护和 API contract。

修改 archive、confirmation、query、schema、HTTP 安全边界或 MCP 工具后，必须按照 `docs/TEST_PLAN.md` 和 `docs/INVARIANTS.md` 运行对应回归。不得通过删除、跳过或放宽测试来掩盖行为回归；若测试确已过时，需说明它依赖的旧行为和删除理由。

真实模型评测必须显式运行，并把模型、端点、API mode、prompt version 和生成时间记录到报告；不得把真实调用混入 `npm run check`。

Rust 参考实现只在以下场景使用：

- 需要裁决迁移前行为；
- 需要重新生成或核对 parity fixture；
- 任务明确要求验证 Rust oracle。

Cargo 检查不是 TypeScript 日常门禁。不得为了让 Rust 参考代码跟随 TS 新功能而修改它。

## Agent 协作与执行规范

- **有求有应**：先确认任务目标和约束；存在关键歧义时说明假设，不擅自扩大范围。
- **有据可查**：修改前先阅读相关代码和文档，结论基于仓库现状，不虚构命令、入口、接口或测试结果。
- **以 TS 为准**：新实现只能进入 TypeScript 主路径；发现文档仍把 Rust 描述为产品入口时，应指出并在任务范围允许时修正。
- **有行有果**：实施后运行与改动直接相关的最小检查；不能运行时明确说明原因和影响。
- **有错必报**：如实报告失败、风险、兼容问题和未覆盖场景，不以绕过测试代替修复。
- **有始有终**：最终说明修改文件、实现内容、验证命令、结果和剩余风险。
- **最小改动**：只修改完成任务所需内容，保留用户已有改动和未跟踪文件。
- **保护本地数据**：不得读取、覆盖、迁移或删除用户真实数据库和密钥，除非用户明确授权且已说明备份/回滚方案。
- **阶段提交**：完成一个独立阶段后创建 Git 提交；提交信息使用简短祈使句，例如 `Document TypeScript workflow`。

## Multi-agent workflow

仅对大型、可并行、以阅读或独立模块修改为主的任务使用 subagent：

- 用 explorer 映射代码和依赖关系；
- 用 reviewer 检查正确性、安全性和边界回归；
- 用 test analyst 分析测试覆盖和失败；
- 并发修改必须使用互不重叠的文件写入范围；
- 主线程负责整合冲突结论、审查改动并执行最终验证；
- 小型或单文件任务不要为了形式而启动 subagent。
