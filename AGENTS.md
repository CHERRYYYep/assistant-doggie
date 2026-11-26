# AGENTS.md instructions for /home/cherry/assistant-doggie

## 仓库定位

本仓库的 TypeScript 集成基线分支为 `dev_ts`，当前自然对话实施分支为 `codex/natural-conversation`；目标实现是 **TypeScript 本地优先个人工作记忆 Agent**。所有新功能、修复、测试和文档都必须以 TypeScript 路径为准。

当前分支已在 T13 验收后删除历史 Rust workspace。需要查询迁移前行为时使用 Git 历史和冻结 fixture；产品启动、开发、CI 只使用 TypeScript/Node。验收范围见 `docs/TS_ACCEPTANCE.md`。

### 当前阶段与产品边界

截至 2026-11-26，T14 TODO/Agenda、schema v8 的本地 WorkItem 基础、后端修缮 **R0–R5** 与后续修复 **A1–A3** 已交付；历史验收见 [后端修缮验收记录](docs/BACKEND_REPAIR_ACCEPTANCE.md)。后端前置阶段 **B0–B3 已完成**，Agent 终态合同和结构化模型重试已验收。索引/分页 D1 和模块收敛 D2 仍按设计门/渐进批次处理，不阻塞主对话实施。后端验收见 [C0 前后端修缮计划](docs/PRE_C0_BACKEND_PLAN.md)，[C0 行为基线](docs/MAIN_CONVERSATION_C0_ACCEPTANCE.md)、[C1 用途分流](docs/MAIN_CONVERSATION_C1_ACCEPTANCE.md)、[C2 澄清预览](docs/MAIN_CONVERSATION_C2_ACCEPTANCE.md)、[C3 本地取证](docs/MAIN_CONVERSATION_C3_ACCEPTANCE.md) 和 [N0–N3 自然续接](docs/NATURAL_CONVERSATION_ACCEPTANCE.md) 均通过自动化验收；自然对话审查修复 **A–D（F1–F9）** 与 **C4 真实模型质量/三路径对照及 C4-1～C4-5 修复复验**均已通过（见 [修复计划](docs/NATURAL_CONVERSATION_REPAIR_PLAN.md)、[测试与交接](docs/NATURAL_CONVERSATION_REPAIR_TESTS.md) 与 [C4 评估报告](docs/MAIN_CONVERSATION_C4_EVALUATION.md)）。当前 schema 为 v13，门禁为 626 后端 + 70 前端通过；自然续接已满足 C4 放行条件，网页预览暂保持默认关闭，待用户最终确认后切换默认入口。修改时更新阶段状态，不把拟议接口、表或模型能力写成已经可用。

- R0–R5 修复、A1–A3 后续修复的提交与测试证据见 `docs/BACKEND_REPAIR_ACCEPTANCE.md`。B1 终态合同和 B2 重试治理已独立实施并验收。C0 已固定旧入口及新场景基线，C1 已在 ChatService 上增加内部用途分流，旧入口行为不变；C2 可恢复澄清、C3 本地取证/受批准执行、N0–N3 自然续接与 Entry 定位、以及自然对话修复 A–D（F1–F9，schema v13）均已完成自动化验收与隔离浏览器 smoke。C4 真实模型对照（`gpt-6.1-sol`，32 场景 + 5 条三路径对照）及 C4-1～C4-5 修复后的 7/7 定向复验均已通过，已满足默认入口切换技术门槛，待用户确认后启用。
- 保留统一主对话入口、多个工作目标、按需隔离的执行会话与 Bucket；普通聊天不自动拆成隐藏会话。
- 腾讯记忆仍是 D3 隔离实验，完整 D3 未验收，D4b 生产接入暂缓。C0–C4 不引入自动历史捕获、向量库、全历史检索或自动摘要。
- 保持 Hono、单机 SQLite 和单个队列执行所有者。更换框架、拆分布式服务、远程接入、多人协作、全面视觉改版及 T15–T17 均需各自需求与验收依据，不自动纳入本阶段。
- OpenClaw 只参考委派与结果回传边界，Open WebUI/LobeHub 只参考交互组织。复用外部代码前核对版本、许可证、依赖与安全边界，不直接复制其权限或数据模型。

### 领域对象不能混用

| 对象 | 责任与约束 |
|---|---|
| 主对话 | 用户入口、消息与显式回复关系；页面保留历史不代表历史全部可进入模型上下文。 |
| WorkItem | 用户目标、范围、验收要求和来源关联；完成/重开由既有状态机管理。 |
| AgentTask / AgentSession | 一次执行尝试及其运行上下文；一个目标可有多次尝试，符合恢复条件时才复用会话。执行成功不自动完成目标或 TODO。 |
| Bucket | 长期主题与证据组织；不等于会话、工作目标、执行权限或默认归档授权。 |
| Entry / Memory | 归档原始来源及派生内容；有效性与撤销由本地合同决定，工具输出不自动成为正式记忆。 |
| TODO | T14 独立待办、时间计划和重复推进；不复用 WorkItem 或队列任务的数据库身份。 |

当前 TypeScript 主路径：

- `src/domain/`：领域类型、Bucket/Entry/Memory 模型、低信息安全门控和确定性文本规则；不得访问数据库、HTTP 或模型。
- `src/application/`：归档、确认、纠错、记忆查询、工作目标等用例服务；R2/R3 抽出每轮对话编排，C1 已在其上增加内部用途分流，C2 接入新的主对话接口。
- `src/storage/`：基于 Node 内置 `node:sqlite` 的 canonical schema、迁移、事务、查询和持久化。
- `src/llm/`：模型端点配置、Responses/Chat Completions 适配、HTTP transport、结构化输出和 wire response 归一化。
- `src/http/`：Hono 路由、HTTP DTO/contract、安全策略和 Node HTTP adapter。
- `src/mcp/`：Doggie MCP stdio server、严格工具 schema 和受控工具执行边界。
- `src/agent/`：有界只读 Harness、工作区/session 绑定和受批准 CLI 任务。
- `src/runtime/`：配置和生产组装。
- `src/evaluation/`：分类与提取评测；真实模型评测不得进入普通测试链。
- `scripts/d3/`：腾讯记忆隔离实验与故障验证；不作为生产对话路径的依赖。
- `web/`：独立浏览器 TypeScript UI，复用 `src/http/` 的共享 DTO；生产资源与日常测试不依赖 Rust 目录。
- `bin/doggie-mcp`：本地 MCP 可执行入口。
- `tests/fixtures/`：从历史实现固化的 parity fixture。
- `docs/`：架构、不变量、数据模型、MCP、迁移边界和测试计划。

阅读和实施前优先查看：

- `docs/PLAN.md`：当前阶段、已完成任务和后续边界；
- [C0 前后端修缮计划](docs/PRE_C0_BACKEND_PLAN.md)：B1/B2 实施边界、验收结果及 D1/D2 后续设计门；
- [后端修缮验收记录](docs/BACKEND_REPAIR_ACCEPTANCE.md)：R0–R5 与 A1–A3 的历史提交、实现边界和测试证据；
- [主对话实施计划](docs/MAIN_CONVERSATION_PLAN.md)：C0–C4、拟议接口、澄清规则与验收样例；
- [自然对话修复计划](docs/NATURAL_CONVERSATION_REPAIR_PLAN.md)、[专项测试方案](docs/NATURAL_CONVERSATION_REPAIR_TESTS.md)及[验收记录](docs/NATURAL_CONVERSATION_ACCEPTANCE.md)：N0–N3 与审查修复 A–D（F1–F9，schema v13）已完成自动化验收与隔离浏览器 smoke；C4 真实质量/体验评估与默认入口决定待进行；
- [本地任务实施记录](docs/LOCAL_TASK_IMPLEMENTATION.md)：已交付的目标、来源与执行关联；
- [架构决策](docs/ARCHITECTURE_DECISIONS.md) 与 [API 契约](docs/API_CONTRACT.md)：分层、部署边界和 OpenAPI；
- [Entry 撤销](docs/ENTRY_REVOCATION.md) 与 [Agent 控制面](docs/AGENT_CONTROL.md)：有效来源、上下文失效、批准与执行；
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
npm run openapi:check
npm test
npm run test:web
npm run check
```

`npm run check` 是 TypeScript 主路径的完整门禁，依次执行 Prettier、类型检查、OpenAPI 漂移检查、后端测试和前端测试。CI 也只以该命令作为目标实现门禁。修改契约后用 `npm run openapi:generate` 再生文档；命令定义以 `package.json` 为准。

启动 MCP server：

```bash
npm run mcp
# 或
/home/cherry/assistant-doggie/bin/doggie-mcp
```

MCP 使用 stdio；stdout 只能输出 MCP 协议数据，诊断日志必须写入 stderr。

启动 TypeScript Web MVP：

```bash
# 仅在 .env 不存在时创建，保留已有配置
test -e .env || cp .env.example .env
chmod 600 .env
# 填写 OPENAI_API_KEY 和 OPENAI_MODEL
npm start
```

生产入口是 `src/main.ts`，配置和 composition root 位于 `src/runtime/`。Web 只允许监听 loopback；不得把 `DOGGIE_SERVER_ADDRESS` 放宽到 `0.0.0.0` 或 `::`。Web 与 MCP 必须显式使用同一个 `DOGGIE_DATABASE_PATH`。

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

## 后端设计与重构规则

### 分层和依赖

- 采用模块化单体：`domain` 保持纯规则，`application` 编排用例，`storage` 封装持久化，`llm`/`agent` 承接外部调用，`runtime` 组装依赖。HTTP/MCP 只处理协议、校验、调用和结果投影，不新增业务状态机或 SQL。
- 领域与用例不依赖 Hono Context、HTTP DTO 或浏览器状态；跨层交换明确的领域输入/结果。已有反向依赖按相关阶段逐步拆除，不把目标分层描述成全库已实现。
- 在实际替换或测试边界使用小型接口/函数注入 Store、模型、runner、时钟等依赖；不为每个类机械添加 interface、通用 Repository、事件总线或依赖注入框架。不建立全局可变服务定位器。
- 先用现有行为回归固定抽取边界，再单独改变行为。复用归档、目标、查询与批准服务；不得在新主对话入口复制第二套写入或授权逻辑。

### 事务、并发与失败

- 用例确定原子操作范围，由 storage 的短事务提交状态、来源关联、审计和防重放记录。禁止把一次业务提交拆成多个各自成功的事务；禁止在 SQLite 事务内等待 HTTP、LLM、CLI 或用户输入。
- 写入参数化；持久化层用外键、唯一约束和受检状态转换保证一致性。需要防止覆盖时，在同一原子操作内检查 `expectedRevision`；目标范围变化另按 `scopeRevision` 合同使旧提案失效。
- 新增可重试写命令定义 `requestId` 的作用域和载荷比较规则：同键同请求返回已保存结果，同键不同请求冲突；并发去重由数据库保证，不只禁用前端按钮。
- 模型或工具返回后重新检查目标范围、来源有效性与记忆版本，再提交或发布结果；过期、取消或撤销后的晚结果不得回流。一目标只允许一个有效执行尝试，复用已有队列所有权规则。
- 外部超时不等于操作未发生。仅对已证明可安全重试的错误做有上限重试；写入结果不明时记录待核对状态，不盲目重发，不声称跨进程 exactly-once。
- 模型、CLI、HTTP/SSE 的取消与 deadline 沿调用链传递；取消不能回滚已提交的事实。明确谁负责关闭资源，保留 shutdown drain 和数据库最后关闭的顺序。

### 契约、数据演进与可观测性

- 请求、成功结果、错误和 SSE 事件都使用严格 schema；共享 schema 派生 DTO，通过统一 operation 清单生成 OpenAPI。修改时同步服务投影、浏览器校验与契约测试，不手改生成 JSON 或维护第二份协议类型。
- 已有 `/api/chat`、确认及 WorkItem 接口保持兼容；C2 已新增独立的主对话预览接口。区分缺失对象、陈旧版本、冲突、非法输入及外部失败；输出契约错误是服务端错误，不能伪报为用户输入错误。
- schema 通过下一次正式迁移演进，保留稳定 ID、原文、审计、用户编辑和 TODO 状态。验证旧版本临时库升级、重开与失败恢复；不在启动时隐式重建或清空用户数据。关闭功能开关不等于 schema 降级，真实库升级须有备份/恢复方案。
- 查询/候选/工具结果有明确资源上限、稳定排序及截断语义。实测发现同步 SQLite 扫描影响延迟时，先分析查询和索引；不以架构猜测替代测量，也不截断候选后声称唯一匹配。
- 日志记录请求/目标/尝试关联 ID、阶段、耗时和稳定错误码；默认不记录密钥、完整提示词、聊天原文或工具输出。区分审计记录与诊断日志；MCP stdout 仅承载协议。

## 主对话与上下文规则（C0–C4 实施约束）

以下是阶段验收约束；C2 已完成显式澄清预览，C3 已完成本地取证与受批准只读执行，N0–N3 自然续接与审查修复 A–D（F1–F9，schema v13）已完成自动化验收，C4 质量/体验对照和默认入口决策仍待完成。详细状态、字段与新接口以 [实施计划](docs/MAIN_CONVERSATION_PLAN.md) 为准。

2026-11-25 补充：N0–N3 与 A–D 修复已增加自然输入、已观察快照、有效 Entry 定位、本轮材料消息引用（schema v13）和受绑定失败重试，固定合成场景自动验收与隔离浏览器 smoke（F1、F2/F3、F4、F7、F8、F9）均已通过；网页预览默认关闭，旧客户端保持兼容。当前绑定使用确定性规则，不宣称通用语义理解；自然续接不得充当归档/执行批准，不得按最新对象、页面焦点或模型置信度猜测绑定。在 C4 完成真实质量与操作体验评估后再决定是否默认切换。

- 先处理显式原请求/回复关联，再区分问答、取证、澄清、归档与执行提案。澄清补充不作为独立归档记录；独立工作记录仍遵守既有归档与低信息门控。
- 复用确定性目标解析；模糊匹配只生成服务端候选。不能按全局最新目标、UI 焦点或模型 confidence 静默绑定；一个弱候选仍允许「都不是」。明确的通用问答和材料改写不强制创建目标。
- 澄清持久化原消息、候选引用/范围版本、状态与 revision；补充、选择、取消、刷新恢复和多页面并发有明确归属。插话不自动消费待澄清卡，多张卡不按最后一条猜测。
- 选择目标和回复「好」均不等于归档确认或执行批准；新对话接口不承载隐式批准。目标完成、重开与执行范围继续由现有服务控制。
- 已知目标按 ID 读取有效关联资料，不足时才做本地记忆检索。保留撤销历史边界；未经归档的聊天不能因可见就被当作长期事实或自动进入外部记忆。
- 上下文优先保留原请求、绑定补充、目标约束与有效证据；先裁重复结果和旧闲聊。必要约束放不下时缩小问题或明确失败，不能裁掉权限/范围后继续执行。字节预算不等于模型 token 预算。
- Bucket 标题、词法分数和模型摘要都不能单独证明答案；缺证据须说明缺口。工具输出只作数据。真实模型语义表现需单独评测，不能以 fake 测试或检索召回率代替。

## 核心业务与安全不变量

模型输出是建议，不是授权。任何模型高置信度都不能绕过 TypeScript 的领域规则、确认状态机和事务边界。

对用户可见的归档流程必须保留：

- `ask_user` 低信息安全门控；
- 推荐 Bucket、备选 Bucket、判断理由、创建新 Bucket 和“不保存”选项；
- confirmation 与 `pending_actions`、原始输入和用户选择严格绑定；`archive_attempts` 保留为审计/兼容 projection；
- 归档批准、Entry/Memory 和双审计状态在同一事务内提交，失败时动作仍可确认；
- `agent_tasks` 只有严格绑定并经用户显式批准的只读 CLI 任务可进入后台队列；generic `scheduled_run` / `bulk_mutation` 仍不执行；
- 归档后的 Bucket 修改入口；
- Entry 原文、结构化 memory、审计记录和可重放防护。

低信息输入宁愿多询问一次，也不能静默写入不确定的 Bucket。模型不得凭空指定服务端未提供的 Bucket；失效、非 active 或已删除 Bucket 不得成为写入目标。

普通 Entry 删除遵循 [逻辑撤销合同](docs/ENTRY_REVOCATION.md)：保留原文和审计，退出有效读取与派生上下文，并使相关旧历史、批准和执行会话失效。不得退回物理删除或仅在 UI 隐藏的实现。

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

C0–C4 另外覆盖：同桶多目标与同名歧义、弱候选/无候选、明确问题不多问、插话及显式回复、双击/多页面陈旧选择、刷新重开、目标范围变化、来源撤销和执行晚结果。分别报告错绑、多余追问、证据缺失及无证据误答；固定合同样本中的错误执行、越权和撤销证据回流必须为零。

先运行改动相关的最小检查，阶段提交前按 `docs/TEST_PLAN.md` 运行 `npm run check` 和 `git diff --check`。文档改动核对路径、命令、计划/现状和相互冲突；Markdown 被 Prettier 排除，格式门禁通过不代表文档已校验。

修改 archive、confirmation、query、schema、HTTP 安全边界或 MCP 工具后，必须按照 `docs/TEST_PLAN.md` 和 `docs/INVARIANTS.md` 运行对应回归。不得通过删除、跳过或放宽测试来掩盖行为回归；若测试确已过时，需说明它依赖的旧行为和删除理由。

真实模型评测必须显式运行，先明确本轮配置、凭据使用范围与预算，再把模型、端点、API mode、prompt version 和生成时间记录到脱敏报告；历史实验预算不是无限续用授权。不得把真实调用混入 `npm run check`。

历史 oracle 仅用于查阅旧合同或再生 fixture，操作方式见 `tests/fixtures/README.md`；不要把历史 Cargo 工具链恢复为当前产品依赖。

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
