# Doggie 重构计划说明书

> 最后更新：2026-08-24 · 当前分支 `dev_ts` · 当前提交 `faf9977`

---

## 一、当前状态一览

| | 数量 |
|---|---|
| TS 代码 | 1,430 行（含测试） |
| TS 测试 | **31 通过** |
| 前端测试 | **16 通过** |
| Rust 参考实现 | **124 通过**（完好保留，可随时对拍） |
| 不变量规格总条数 | **85 条**（8 个章节） |
| 已覆盖 | **22 条**（§1 全部 13 + §2 全部 7 + §3 的 2 条） |
| 剩余 | **63 条** |

```
进度  ██████░░░░░░░░░░░░░░░░░░░░  22 / 85
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
| **S1** | `38592c9` | 服务端安全边界 | 规则保留，代码待 T7 重建 |
| **S2** | `c299b4c` | 前端还原为可审查源码 | **✅ 完全保留** |
| **S3** | `0d1ba54` | 前端拆成 10 个单一职责模块 | **✅ 完全保留** |

**S1 — 拒绝浏览器可伪造的本地请求**

修正了文档里一句错误推理（"只绑 loopback 所以不需要 CSRF"）。实际强制：`Host` 必填且必须是 loopback、跨源状态变更拒绝、`Origin: null` 拒绝、带 body 必须 `application/json`、`nosniff` + `Referrer-Policy` + CSP。真实 socket 上 8 个场景逐一验证通过。

> 这一条在接 agent 之前是**阻断性**的：agent 能执行命令之后，CSRF 从"污染记忆"升级为"任意网页触发本地 RCE"。

**S2 — 前端还原**

原前端被压成单行（`renderMarkdown` 一行 4000 字符）。引入 Prettier 后发现：**纯格式化打挂了 4 个前端测试里的 3 个**——它们断言的是源码拼写（`APP_JS.contains("escapeHtml(plain)")`），改名会红、真出 XSS 会绿。于是抽出 `markdown.js` 并写了 16 个喂真实注入载荷的行为测试。附带：删死代码、去掉内联 style 从而把 CSP 收紧到 `style-src 'self'`、加深色模式。

**S3 — 前端模块化**

415 行 `app.js` → 10 个模块。契约测试升级为真实结构不变量：每个 `import` 必须能路由到、只有 `dom.js` 能碰 DOM、只有 `api.js` 能 `fetch`、路由只在一处声明。用 stub DOM 的 Node harness 真实执行了模块图，确认无循环 import 与缺失导出。

### 阶段 B — TypeScript 重写（进行中）

| # | 提交 | 内容 |
|---|---|---|
| **T1** | `2b9e09b` | 分支 + 工具链 + **不变量规格** |
| **T2** | `faf9977` | 领域层 + 安全门控 + 差分测试 |

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

---

## 三、待完成

### 里程碑

```
M1  TS 与 Rust 功能对等           T3 → T8      ← 可以删除 Rust workspace
M2  记忆开始被日常消费             T9 → T10     ← 最高杠杆，产品开始有价值
M3  Doggie 成为 Agent 控制面      T11 → T13
M4  日常长期助手                  T14 → T16
```

### M1 — 功能对等

| # | 阶段 | 交付 | 覆盖不变量 | 依赖 |
|---|---|---|---|---|
| **T3** | 存储层 | `node:sqlite`、canonical schema、事务 | §4 全部 15 条 | T2 |
| **T4** | 应用服务 | 归档、确认、纠错、状态变更 | §3 剩余 6 条 | T3 |
| **T5** | 查询 | `MemoryQuery` 解析、检索、重排、evidence 去重 | §5 全部 11 条 | T3 |
| **T6** | LLM 适配 | 端点配置、结构化输出、重试策略 | §6 全部 12 条 | T2 |
| **T7** | HTTP 服务 | Hono 路由 + **S1 安全边界重建** | §8 全部 10 条 | T4 T5 T6 |
| **T8** | 前端接入 | S2/S3 成果改 `.ts`、前后端共享 DTO 类型 | — | T7 |

**T3 关键约束**：必须能**直接打开现有 `doggie.db`**——同一个 SQLite 文件、同一套表、数据不迁移。这是"数据是资产、代码不是"的落地检验。

**T3 差分测试方案**：让 Rust 和 TS 分别对同一个临时库执行同一串写操作，逐表比对最终状态（忽略 UUID 和时间戳）。比 T2 的单函数对拍更强。

**M1 完成后**：删除 `crates/`、`apps/`、`Cargo.*`，把前端从 `apps/doggie-local-web/frontend/` 移到 `web/`。

### M2 — 记忆被消费

| # | 阶段 | 交付 | 说明 |
|---|---|---|---|
| **T9** | 评测 harness 恢复 | 分类准确率 + 提取忠实度 | 补回规格 §9 标 `[!]` 的能力；人工标注 fixture 在 `dev` 分支可复用 |
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

## 五、需要你拍板的未决问题

| # | 问题 | 我的倾向 |
|---|---|---|
| **Q1** | **协作者的分工是什么？** 他现在写代码吗？ | 若写 → 我之前"单人项目不需要 CI"的建议作废，应加 CI + PR 流程 |
| **Q2** | 分类模型用哪家？`.env` 现在是 `OPENAI_*`，但你要接 Claude agent | 建议抽象成 provider 接口，分类用现有 OpenAI 兼容端点，agent 用 Claude CLI |
| **Q3** | TS 服务读现有 `doggie.db` 还是新建库？ | 读现有——数据是资产，且这是最好的兼容性检验 |
| **Q4** | S1 遗留：`HEAD` 请求返回 404 | 不影响浏览器，只影响 `curl -I`。T7 重建时顺手修 |
| **Q5** | 评测 fixture 是复用 `dev` 分支的人工标注，还是重新标注？ | 复用——重新标注成本高且会丢失历史可比性 |
| **Q6** | `renderHistory` 全量重渲染（确认卡片输入会丢失） | 推迟到 T12，SSE 会重写这条路径，现在改等于白改 |
| **Q7** | 删除 Rust 的时机 | M1 完成后。差分测试价值在 M1 阶段最高 |

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
