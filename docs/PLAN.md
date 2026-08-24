# Doggie 重构计划说明书

> 最后更新：2026-08-24 · 当前分支 `dev_ts` · T9 已完成（M2 进行中）

---

## 一、当前状态一览

| | 数量 |
|---|---|
| TS 代码 | 15,483 行（含测试；含 1,401 条生成的 Unicode casefold 映射） |
| TS 测试 | **166 个测试声明通过** |
| 前端测试 | **23 个测试声明通过** |
| Rust 参考实现 | **124 通过**（完好保留，可随时对拍） |
| 不变量规格总条数 | **85 条**（8 个章节） |
| 已覆盖 | **76 条**（§1 全部 13 + §2 全部 7 + §3 全部 8 + §4 全部 15 + §5 全部 11 + §6 全部 12 + §8 全部 10 条） |
| 剩余 | **9 条** |

```
进度  ███████████████████████████░░░  76 / 85
```

### 分支布局

| 分支 | 内容 | 状态 |
|---|---|---|
| `main` | 原始 Python 实现 | 冻结 |
| `dev` | Python + Rust 并存 | **Python 参考**，`128 passed in 6.18s` |
| `dev_rust` | 纯 Rust workspace | **Rust 参考**，124 测试 |
| `dev_ts` | ← **当前** | TypeScript 目标实现 |

---

## 二、已完成

### 阶段 A — Rust 侧加固（换语言决策之前）

这三个提交在 `dev_rust` 上完成，**`dev_ts` 继承了全部成果**。

| # | 提交 | 内容 | 是否随重写保留 |
|---|---|---|---|
| **S1** | `38592c9` | 服务端安全边界 | **✅ 已在 T7 重建并加强** |
| **S2** | `c299b4c` | 前端还原为可审查源码 | **✅ 完全保留** |
| **S3** | `0d1ba54` | 前端拆成 10 个单一职责模块 | **✅ 完全保留** |

**S1 — 拒绝浏览器可伪造的本地请求**

修正了文档里一句错误推理（"只绑 loopback 所以不需要 CSRF"）。实际强制：`Host` 必填且必须是 loopback、跨源状态变更拒绝、`Origin: null` 拒绝、带 body 必须 `application/json`、`nosniff` + `Referrer-Policy` + CSP。真实 socket 上 8 个场景逐一验证通过。

> 这一条在接 agent 之前是**阻断性**的：agent 能执行命令之后，CSRF 从"污染记忆"升级为"任意网页触发本地 RCE"。

**S2 — 前端还原**

原前端被压成单行（`renderMarkdown` 一行 4000 字符）。引入 Prettier 后发现：**纯格式化打挂了 4 个前端测试里的 3 个**——它们断言的是源码拼写（`APP_JS.contains("escapeHtml(plain)")`），改名会红、真出 XSS 会绿。于是抽出 `markdown.js` 并写了 16 个喂真实注入载荷的行为测试。附带：删死代码、去掉内联 style 从而把 CSP 收紧到 `style-src 'self'`、加深色模式。

**S3 — 前端模块化**

415 行 `app.js` → 10 个模块。契约测试升级为真实结构不变量：每个 `import` 必须能路由到、只有 `dom.js` 能碰 DOM、只有 `api.js` 能 `fetch`、路由只在一处声明。用 stub DOM 的 Node harness 真实执行了模块图，确认无循环 import 与缺失导出。

### 阶段 B — TypeScript 重写（T8/T8b 已完成）

| # | 提交 | 内容 |
|---|---|---|
| **T1** | `2b9e09b` | 分支 + 工具链 + **不变量规格** |
| **T2** | `faf9977` | 领域层 + 安全门控 + 差分测试 |
| **T3** | `2fdf105` | SQLite 存储层 + canonical schema + 事务 + Rust/TS 差分测试 |
| **T4** | `02d6e24` | 归档确认 + 纠错 + Bucket 生命周期应用服务 |
| **T5** | `d794fc4` | Entry 级自然语言查询、确定性重排和 evidence 投影 |
| **T6** | `03bfe63` | LLM 端点、严格结构化输出、wire 归一化和有界重试 |
| **T7** | `4d1caca` | HTTP 合同、Hono API、S1 安全边界和 Node loopback server |
| **T8** | `fe66410` → `2339bd3` | 前端 TypeScript、共享 HTTP DTO、Node/Rust 类型剥离与浏览器 smoke test |
| **T8b** | `6c9e8eb` | GitHub Actions：Node 24 + `npm ci` + `npm run check` |

**T1 — 骨架与规格**

技术选型（全部实测验证）：

| 需求 | 选择 | 依赖数 |
|---|---|---|
| 运行 TS | Node 24 原生类型剥离 | 0 |
| SQLite | `node:sqlite` 内置 | 0 |
| 测试 | `node --test` 原生跑 `.ts` | 0 |
| 类型检查 | TypeScript | 1 |
| 边界校验 | zod | 1 |
| HTTP | Hono | 1 |

`tsconfig` 开 `erasableSyntaxOnly`——编译器拒绝任何无法类型剥离的语法，**"无构建步骤"由编译器强制，不会腐化**。

核心产出 **`docs/INVARIANTS.md`**：从 Rust 124 + Python 79 个测试提取的 85 条行为清单，每条标注钉住它的测试名，区分 `[R]` / `[P]` / `[RP]`。

> **交叉核对发现**：Rust 重写时静默丢掉了 Python 的整套评测 harness（`evaluation.py` 361 行 + `extraction_evaluation.py` 270 行 + live 变体 271 行）。其中提取忠实度检查专门抓"模型编造了原文没有的数字"，直接对应 PRD 的"原文保留"原则；而 PRD 第 8 节的成功指标"分类准确率 70%"，Rust 版本没有任何东西能回答。已记入规格 §9，**T9 必须补回**。

**T2 — 领域层**

覆盖 §1 全部 13 条 + §2 全部 7 条。做了**差分测试**：给 Rust 加 oracle example，919 条压力语料（指代词×动作词全组合、动作词×Unicode 数字全组合、24 字符边界）喂进两个实现逐行比对，**919/919 完全一致**，并把 Rust 判定冻结成 golden fixture，使行为在删除 Rust 后仍被钉住。

> 差分测试纠正了规格里的一处错误：我原写"中文数字算具体事实"，实测 `三`/`百` 是 Unicode 类别 `Lo` 不是 `N`，**两个实现都不认**。

**T3 — 存储层**

T3 已完成，覆盖 `docs/INVARIANTS.md` §4 全部 15 条：

- `node:sqlite` canonical schema：稳定业务 ID、迁移记录、外键、WAL、`busy_timeout=5000`；
- 单事务归档、回滚、级联删除、Entry 携带 memory 移动、自动空 Bucket 清理、审计和聊天持久化；
- Unicode 摘要滚动/截断、标签合并、提取去重、追加 Entry、活跃/热门 Bucket 投影；
- Rust 场景与 TS 场景执行同一组写操作，按业务语义逐表比较，忽略实现相关 UUID 和系统时间格式，但保留所有外键、状态、候选顺序和业务时间；
- 差分过程使用文件数据库并关闭后重开，另行断言外键检查为空。

T3 阶段门禁已通过：`npm run check`、`cargo fmt --all -- --check`，以及在允许本地回环 socket 的环境下通过 `cargo test --workspace --offline`。此前受沙箱限制的 Rust HTTP mock 失败是端口绑定权限错误，放宽权限后 124 个 Rust 测试全部通过。

提交链：`af9fd81` → `f0d585e` → `1d5dd02` → `8e27a21` → `2fdf105`。未跟踪的 PDF 文件保留，未纳入提交。

**T4 — 应用服务**

T4 已完成，覆盖 `docs/INVARIANTS.md` §3 全部 8 条：

- 归档服务保留低信息 `ask_user` 门控；明确实现推荐 Bucket、备选 Bucket、创建新 Bucket 和不保存四种确认动作；
- confirmation 与 pending attempt、原始文本和用户显式选择严格绑定，并在单事务中原子消费，拒绝重放和重复写入；
- 非 active 或已删除 Bucket 不能作为确认目标，失败时 attempt 保持 pending；确认路径不重新分类；
- pending 新 Bucket 建议随 schema v2 migration 持久化，数据库关闭重开后仍可恢复；
- 纠错服务支持按 Entry、最近 Entry 和中文命令移动，保留 correction 审计，并提供 Entry/Bucket 删除接口；
- Bucket 生命周期服务支持 `active`、`paused`、`done`、`archived`，正确维护 `updated_at` / `archived_at`，不污染 Entry、memory 或 correction。

T4 阶段门禁已通过：`npm run check`、`cargo fmt --all -- --check`、`cargo test --workspace --offline`。当前共有 84 个 TS 测试声明、16 个前端测试声明，Rust 参考实现 124 个测试继续全部通过。

提交链：`7f69c1b` → `1d947d9` → `896c041` → `02d6e24`。未跟踪的 PDF 文件保留，未纳入提交。

**T5 — 自然语言查询**

T5 已完成，覆盖 `docs/INVARIANTS.md` §5 全部 11 条：

- 确定性 `MemoryQuery` 解析器提取 entity/topic/bucket terms、相对 UTC 时间、生命周期状态和调用方 structured filters，并用类型化错误限制空查询、500 字符上限、非法 limit、时间范围和过滤器数量；
- Store 以 Entry 为候选单元，检索 Bucket 标题/摘要/标签、Entry 原文/summary/content type，以及所属 memory 的 kind/text/status/source/metadata；memory 严格按 `entry_id` 关联；
- SQL LIKE 始终参数绑定，并把 `%`、`_`、`/` 作为字面量转义；Unicode 内存回退固定为 Rust `unicode-casefold 0.2.0` 的 Unicode 9 full/non-Turkic 语义，1,112,064 个 Unicode scalar value 全量差分一致；
- 查询服务支持 lifecycle、`Entry.created_at` UTC 半开区间和结构化字段过滤；全局完成 lexical ranking、recency bonus、稳定 tie-break 后才应用 limit，并按 Bucket 聚合；
- evidence 按 `kind + casefold(trim(text))` 去重，同文本不同 kind 保留；`answer` 完全确定性生成，字段明确命名为 `lexicalSimilarity`，不冒充 embedding/vector score；
- 查询前后数据库业务快照、Bucket 活动时间和聊天历史保持不变；额外覆盖非法日历日期、无时区时间、RFC3339 offset、顶层数组 metadata、archived、时间四边界和重复查询一致性。

T5 阶段门禁已通过：`npm run check`、`cargo fmt --all -- --check`、`cargo check --workspace --offline`、`cargo clippy --workspace --all-targets --offline -- -D warnings`、`cargo test --workspace --offline`、`git diff --check`。当前共有 97 个 TS 测试声明、16 个前端测试声明，Rust 参考实现 124 个测试继续全部通过。

提交链：`be25375` → `4b06031` → `99ff0d6` → `d794fc4`。未跟踪的 PDF 文件保留，未纳入提交。

**T6 — LLM 适配**

T6 已完成，覆盖 `docs/INVARIANTS.md` §6 全部 12 条：

- 用 zod 建立 classification、extraction 和 bucket summary 的严格运行时合同，并提供 Responses / Chat Completions 共用的严格 JSON Schema；未知字段、非法 confidence、不一致 action、缺失 summary 和非法 timeline 文本均被拒绝；
- extraction 的数组默认值每次解析独立创建，并兼容 Rust `Option<Vec<_>>` 的缺失值和 `null`；`timeline_events: null` 仍按合同拒绝；
- endpoint 配置区分 official/custom 与 Responses/Chat 两种模式；自定义地址拒绝 credentials、query、fragment 和远程明文 HTTP，仅允许 localhost HTTP gateway；site 按 100 UTF-8 字节限制；
- fetch transport 将 API Key 保存在 JavaScript 私有字段中，错误与 inspect 输出统一脱敏；timeout 限制为 1 到 2,147,483,647 的 safe integer，并区分瞬时 HTTP 与不可重试客户端错误；
- Responses / Chat wire parser 统一处理 final answer、refusal、incomplete、content filter、非终止状态和 modern function tool calls；structured-output 路径明确拒绝 tool calls、legacy function_call、unsupported tool output 和畸形 finish reason，不允许文本掩盖未解决的工具调用；
- structured adapter 发送 `strict: true` JSON Schema 请求，保留 prompt 原文、只 trim model，按 `maxRetries + 1` 精确限制总尝试次数，并统一处理 transport、wire、JSON 和 contract 错误；endpoint、transport 和 timeout 使用运行时私有状态，不能用 `Reflect.set` 绕过校验。

T6 阶段门禁已通过：`npm run check`、`cargo fmt --all -- --check`、`cargo check --workspace --offline`、`cargo clippy --workspace --all-targets --offline -- -D warnings`、`cargo test --workspace --offline`、`git diff --check`。当前共有 124 个 TS 测试声明、16 个前端测试声明，其中 LLM 边界有 27 个测试声明；Rust 参考实现 124 个测试继续全部通过。

提交链：`98826cf` → `c03841f` → `0a619c0` → `4436bc8` → `03bfe63`。未跟踪的 PDF 文件保留，未纳入提交。

**T7 — HTTP 服务**

T7 已完成，覆盖 `docs/INVARIANTS.md` §8 全部 10 条：

- 建立严格 HTTP DTO 和 Hono 路由，组装归档、确认、查询、纠错、Bucket 生命周期、聊天历史与状态 API；UTF-8 query、HEAD 和稳定 JSON 错误投影均有回归测试；
- 新增 concrete API 与 archive runtime facade，补齐 confirmation/history/query parity：`focus_bucket_id` 全链路进入审计，失败确认保留已接受消息，缺失 Bucket 不暴露无效移动操作，legacy Bucket 搜索使用确定性排序；
- 在 API dispatch 前重建 S1 安全边界：严格校验 Host、Origin 和有 body 请求的 JSON Content-Type，允许合法 loopback authority 与无 Origin CLI 请求，拒绝 foreign/opaque/重复或畸形头；所有响应统一带 `no-store`、`nosniff`、`no-referrer` 和无 `unsafe-inline` 的 CSP，且不发送 CORS allow headers；
- 新增 `node:http` loopback server adapter，在 `rawHeaders` 层拒绝重复 Host/Origin/Content-Type/Content-Length、Content-Length 与 Transfer-Encoding 冲突及非严格 chunked 编码；完整 socket 字节预算限制为 1 MiB，并校验 fatal UTF-8；
- 真实 loopback socket 测试覆盖正常请求、合法 chunked JSON、超限/framing/parser 错误、内部错误和 HEAD 无 body；安全拒绝发生在业务 dispatch 前，不产生写入副作用。

T7 阶段门禁已通过：`npm run check`、`cargo fmt --all -- --check`、`cargo check --workspace --offline`、`cargo clippy --workspace --all-targets --offline -- -D warnings`、`cargo test --workspace --offline`、`git diff --check`。当前共有 165 个 TS 测试声明、16 个前端测试声明，Rust 参考实现 124 个测试继续全部通过。真实 socket 测试在默认沙箱中因禁止绑定 `127.0.0.1:0` 返回 `EPERM`，在允许 loopback socket 的环境下全部通过。

提交链：`3842bc2` → `da755f9` → `2da2e3f` → `186306b` → `5d03523` → `531bd05` → `4d1caca`。未跟踪的 PDF 文件保留，未纳入提交。

**T8 — 前端接入**

T8 已完成：S2/S3 前端资产已全部迁移为严格 TypeScript，并与后端 HTTP DTO 共享类型。

- 10 个前端 TypeScript 模块和前端测试入口均已切换为 `.ts`，保留原生 ES module 和无第三方 bundler 的架构；
- 前端 API client 复用 `src/http/contracts.ts` 与 `src/http/dto.ts`，Bucket、Entry、Memory、归档、确认、聊天历史、查询和状态响应不再重复声明；
- Node 24 HTTP runtime 在响应 `/assets/*.ts` 前使用 `stripTypeScriptTypes`，Rust `build.rs` 在 Cargo 编译时使用同一原生能力，把临时剥离结果嵌入二进制；生成 JavaScript 不提交；
- 浏览器继续请求 `/assets/*.ts` 路径，但服务端响应体已是可执行 JavaScript，并保持 `text/javascript; charset=utf-8`；
- DOM 类型守卫、事件类型收窄、JSON-safe details、Markdown 输入边界和归档确认判别联合均已完成严格类型化。

T8 阶段门禁已通过：`npm run typecheck`、`npm run test:web`（23 个通过）、`npm test`（166 个通过）、`cargo fmt --all -- --check`、`cargo check --workspace --offline`、`cargo clippy --workspace --all-targets --offline -- -D warnings`、`cargo test --workspace --offline`、`git diff --check`。Rust `doggie-local-web` UI contract 测试 9 个全部通过；Node HTTP server 的 10 个真实 `.ts` 资源经 headless Chrome 加载成功，无 TypeScript 语法错误、模块加载错误或 CSP 拒绝。

实现提交链：`fe66410` → `459e4e4` → `f729bc4` → `2339bd3`；收口文档和格式提交：`315de89` → `e02b4b5` → `87e2af1` → `d44ec3f`。未跟踪的 PDF 文件保留，未纳入提交。

**T8b — CI**

T8b 已完成：新增 `.github/workflows/ci.yml`，在 `push` 和 `pull_request` 上以最小只读权限运行 Node 24、`npm ci` 和 `npm run check`；npm cache 已启用。工作流不扩展到 Rust CI，以保持本阶段范围聚焦。

本地等价门禁已通过：Prettier YAML 检查、`npm run check`（166 个 TS 测试、23 个前端测试）和 `git diff --check`。真实 GitHub runner 将在该分支首次推送或 pull request 时执行；本地验证不将其误记为远程运行结果。

提交：`6c9e8eb Add CI workflow`。未跟踪的 PDF 文件保留，未纳入提交。

**T9 — 评测 harness 恢复**

T9 已完成，恢复了原 Python harness 的确定性能力，并保留 live evaluation 的可复现报告格式：

- `src/evaluation/classification.ts`：加载并校验 50 条人工标注分类 fixture，计算 action / Bucket / 自动归档准确率、ask-user recall、高代价误合并和 confidence 分档指标；同时提供不读取 expected label 的 keyword baseline；
- `src/evaluation/extraction.ts`：计算 summary / todo / evidence / timeline / decision term recall，检测 forbidden terms 和原文不存在的新数字；`85` 与 `85%` 按同一数字风险归一化；
- `src/evaluation/live.ts`：注入真实 classifier / extractor，记录模型、端点、API mode、prompt version、生成时间和原始预测，写出可复核的 snake_case JSON 报告；不在普通测试中调用真实模型；
- 复用了 `dev` 分支的 `tests/fixtures/classification_cases.json`（50 条）和 `extraction_cases.json`（3 条），没有重新标注；
- 测试覆盖 fixture 覆盖率、指标边界、ID 对齐、报告加载/写盘和空选择拒绝。

T9 小任务提交链：`ef7c8be`（分类）→ `24a4ad4`（提取）→ `63d901d`（live 报告）。首次完成后的全量 `npm run check` 与 `git diff --check` 作为收口门禁执行；真实模型 live run 仍需由用户显式提供端点和密钥后单独运行。

---

## 三、待完成

### 里程碑

```
M1  TS 与 Rust 功能对等           T7 → T8b ✅  ← CI 已就位，协作者可加入
M2  记忆开始被日常消费             T9 ✅ → T10     ← 最高杠杆，产品开始有价值
M3  Doggie 成为 Agent 控制面      T11 → T13
M4  日常长期助手                  T14 → T17
```

### M1 — 功能对等

| # | 阶段 | 交付 | 覆盖不变量 | 依赖 |
|---|---|---|---|---|
| **T3** ✅ | 存储层 | `node:sqlite`、canonical schema、事务、Rust/TS 差分测试 | §4 全部 15 条 | T2 |
| **T4** ✅ | 应用服务 | 归档、确认、纠错、状态变更 | §3 全部 8 条 | T3 |
| **T5** ✅ | 查询 | `MemoryQuery` 解析、检索、重排、evidence 去重 | §5 全部 11 条 | T3 |
| **T6** ✅ | LLM 适配 | 端点配置、结构化输出、重试策略 | §6 全部 12 条 | T2 |
| **T7** ✅ | HTTP 服务 | Hono 路由 + **S1 安全边界重建** | §8 全部 10 条 | T4 T5 T6 |
| **T8** ✅ | 前端接入 | S2/S3 成果改 `.ts`、前后端共享 DTO 类型 | — | T7 |
| **T8b** ✅ | **CI** | GitHub Actions 跑 `npm run check` | — | T8 |

**T3 约束（按 Q3 调整）**：**不做 legacy 导入，不兼容现有 `doggie.db`**。物理 schema 自由设计，但必须保留 §4 全部 15 条事务语义，且为 T17 导出/导入预留：业务 ID 稳定、无隐藏状态、派生数据可从原文重建。WAL + `busy_timeout` 从一开始就配好（T12 后台执行器的前置）。

**T3 差分测试方案**：让 Rust 和 TS 分别执行同一串写操作，逐表比对最终状态（忽略 UUID 和时间戳）。比 T2 的单函数对拍更强。

**T8b 存在的理由**：协作者在重写完成后加入（Q1）。CI 防的是"别人推了坏代码"，所以必须**赶在他加入之前**就位，而不是之后。

**M1 完成后**：删除 `crates/`、`apps/`、`Cargo.*`，把前端从 `apps/doggie-local-web/frontend/` 移到 `web/`。

### M2 — 记忆被消费

| # | 阶段 | 交付 | 说明 |
|---|---|---|---|
| **T9** ✅ | 评测 harness 恢复 | 分类准确率 + 提取忠实度 + live 报告 | 已补回规格 §9 标 `[!]` 的能力；人工标注 fixture 已从 `dev` 分支复用 |
| **T10** | **MCP server** | 只读工具 + `propose_entry` | **最高杠杆** |

**T10 为什么最高杠杆**：它让已有的存储+查询层**每天在你用 Claude Code 工作时被调用**，而不是只有侧边栏在用。`AGENT_TOOL_DEFINITIONS` 已经是 JSON Schema 形状，MCP 的 `tools/list` 返回的就是这个——缺的只是协议传输层。

```bash
claude mcp add doggie -s user -- <doggie-mcp 路径>
```

> **安全约束**：第一版只暴露只读工具。写操作走 `propose_entry` → 返回"已提交待确认" → 你在 Doggie UI 里批准。**agent 不得绕过确认门控直接写。**

> **必须尽早加 `propose_entry`**：否则 MCP 越好用，记忆越贫瘠——你和 agent 的整段对话对 Doggie 不可见，长期记忆会退化成只读档案馆。

### M3 — Agent 控制面

| # | 阶段 | 交付 |
|---|---|---|
| **T11** | `PendingAction` 泛化 | 把 `ArchiveAttempt` 抽象成通用待批准动作，顺带合并两套并行归档流 |
| **T12** | 任务队列 + 后台执行器 + SSE | Node 原生 async，不需要 tokio 那种重构 |
| **T13** | Agent 编排 | `agent_workspaces` / `agent_sessions` / `agent_tasks` 三表 + spawn `claude`/`codex` |

**T11 的关键洞察**：`ask_user` → 确认卡片 → 服务端执行，**已经是 agent action approval 的正确形态**。扩展不需要发明新安全模型，只需泛化：

```
PendingAction
  ├─ kind: archive | agent_task | scheduled_run | bulk_mutation
  ├─ proposed_by: model | schedule | user
  ├─ payload / binding（防伪造）
  └─ status: pending | approved | rejected | executed | failed
```

**T13 数据模型**（已在对话中确认）：

```
Bucket ──N:1──► Workspace ──1:N──► AgentSession
（记忆锚点）      （目录+git基线）    （执行缓存，可再生）
   │                                      ▲
   └──────────── AgentTask ───────────────┘
```

- `buckets.workspace_id` 可空外键（N:1，多个 Bucket 可指向同一目录）
- **`agent_sessions.workspace_id` 不可变**——换目录必须新建 session，否则恢复的上下文是关于旧目录的
- **`agent_tasks.workspace_id` 可空**——非 coding 任务（会议、想法）不需要目录，只开 WebSearch + doggie MCP，不给文件系统工具
- 六项目录检测：路径规范化、边界白名单、存在性、git 状态与 base commit、并发互斥、session↔目录一致性

**已核实的 CLI 接口**：

```bash
claude -p "指令" --output-format stream-json --include-partial-messages \
  --session-id <uuid> --resume <uuid> --permission-mode manual \
  --allowedTools "Read Grep Glob" --add-dir <workspace> \
  --mcp-config <doggie> --strict-mcp-config
```

`--strict-mcp-config` 保证定时任务拿到确定的工具面，不受个人 MCP 配置影响。Codex 侧对应 `codex exec` / `codex exec resume`。

### M4 — 日常长期助手

| # | 阶段 | 交付 | 参考实现 |
|---|---|---|---|
| **T14** | TODO 生命周期 + agenda | `SCHEDULED` / `DEADLINE` / repeater | **org-mode / org-agenda** |
| **T15** | 调度器 + 系统通知 | 持久化调度、重启补跑策略 | 本地进程直接调 `notify-send` |
| **T16** | 插件系统 | Doggie 作为 MCP client | 插件 = MCP server，任意语言、进程隔离 |
| **T17** | **数据导出/导入** | 全量导出、可重新导入 | Q3 明确承诺的未来需求 |

**T17 为什么单列**：Q3 决定不兼容旧库，代价是数据可迁移性要靠导出/导入补回来。这也是信任问题——**数据出不来的"长期记忆"，用户不会持续投入**。T3 的 schema 设计已为此预留。

**T14 好消息**：schema 不用改——`memory_items` 已有 `todo` kind、`status`、event time。缺的是语义和生命周期。

**为什么抄 org-mode**：`SCHEDULED`（什么时候开始想它）和 `DEADLINE`（什么时候必须做完）是两件事。Todoist 只有一个 due date，这正是它长期被诟病的点。

**T15 三个设计要点**：
1. 持久化调度表 + tick 循环，不是内存定时器；错过的执行要显式决定补跑/跳过/合并
2. 本地进程一直在跑，可直接发系统通知——这是本地优先相对 SaaS 的真实优势
3. **定时触发的 agent 任务必须进 `PendingAction`**，无人值守的执行不开放写权限

**其他参考**：MemGPT/Letta 的记忆分层（core 常驻 / archival 检索）、mem0 的记忆去重与合并（防长期腐烂）、Logseq 的 `LATER`/`NOW`、Todoist 的自然语言日期解析。

---

## 四、关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | **换 TypeScript**，不是 Python | 与前端同语言可共享 DTO 类型；插件 = `import()`；保住最多类型纪律；Node 已在工具链里 |
| D2 | 基分支选 `dev_rust` | S2/S3 前端是唯一可直接复用的完整资产 |
| D3 | Rust 代码**暂不删除** | 作为可运行参考做差分测试，M1 完成后统一删 |
| D4 | 依赖保持极少 | 延续原项目原则；去掉的是生态税不是纪律 |
| D5 | 无构建步骤 | `erasableSyntaxOnly` 由编译器强制 |
| D6 | 错误用 `throw` 不用 `Result` | 保留可穷尽 `kind` 判别式供 HTTP 映射；Result 在 TS 里与生态冲突 |
| D7 | 品牌类型 | 复现 Rust "验证过的值才能存在" |
| D8 | 候选构造**忽略 UI 选中项** | 跟随 Rust 而非 Python；`focus_bucket_id` 仅作兼容/审计 |
| D9 | `*.md` 排除出 Prettier | 它按 UTF-16 码元补齐表格，CJK 双宽会歪 |
| D10 | 先 MCP server 再 orchestrator | B 方向 1–2 天且已完成 80%；A 方向数周。且 B 是 A 的组件 |

---

## 五、已拍板的决策（2026-08-24）

| # | 问题 | 决定 |
|---|---|---|
| **Q1** | 协作者分工 | **他在 TS 重构完成后开始写代码。** 重写期间仍是单人，但**M1 收尾加 CI（T8b）**，在他加入之前就位。我此前「单人不需要 CI」的建议到那时作废 |
| **Q2** | 模型 provider | **保留 OpenAI 兼容端点**，当前不是关键问题，**不为此额外投入**，provider 抽象保持最小 |
| **Q3** | 是否兼容现有 `doggie.db` | **不兼容。** 现有数据量少、可随时重新自测。T3 不做 legacy 导入，物理 schema 可自由设计（仍保留 §4 全部事务语义）。**导出/导入延后到 T17** |
| **Q4** | `HEAD` 返回 404 | T7 重建路由时顺手修——正确的 HTTP 行为，成本近零 |
| **Q5** | 评测 fixture | **复用 `dev` 分支的人工标注**，不重新标注 |
| **Q6** | `renderHistory` 全量重渲染 | **推迟到 T12**，SSE 会重写这条路径 |
| **Q7** | 删除 Rust 时机 | **M1 完成后**，差分测试价值在 M1 阶段最高 |

### Q3 的两个后果

**省掉的**：不用写 `legacy_import.rs`（780 行）的等价物；schema 不必逐列复刻 Rust canonical 表。

**必须记住的**：**T17 数据导出/导入是明确承诺的未来需求**。因此 T3 的 schema 必须满足三个条件——业务 ID 稳定（不依赖 rowid）、无隐藏状态、所有派生数据可从原文重建。一个「长期记忆」产品如果数据出不来，用户不会愿意持续投入。

---

## 六、工作方式约定

沿用至今的做法，如需调整请指出：

1. **每完成一个阶段 = 一次提交 + 一份总结 + 等你确认**
2. **每条不变量都要有可执行测试**——不允许用"代码看起来做了这件事"代替
3. **能对拍就对拍**——固定测试只覆盖想得到的输入，差分测试覆盖想不到的
4. **发现规格错误就地修正**并在总结里说明（已发生 2 次：Unicode 数字、Prettier 表格）
5. **如实报告**——跑不通就说跑不通，跳过就说跳过

### 每阶段的验证门禁

```bash
npm run check      # format:check + typecheck + test + test:web
cargo test --workspace --offline    # M1 期间保持 Rust 参考可运行
```

---

## 七、参考实现随时可查

```bash
git show dev_rust:crates/doggie-domain/tests/classification.rs   # Rust 行为
git show dev:app/services/archive_service.py                     # Python 行为
git stash && git checkout dev && .venv/bin/python -m pytest tests -q   # 跑 Python
```
