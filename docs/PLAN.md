# Doggie 重构计划说明书

> 最后更新：2026-11-26 · 基线集成分支 `dev_ts`；当前实施分支 `codex/natural-conversation` · T13、T14、本地任务、后端修缮 R0–R5 和后续修复 A1–A3 已交付；B0–B3、C0–C4、N0–N3 与自然对话修复 A–D（schema v13）及 React 19 UI 重设计（方案 B）均已验收，自然对话已设为网页默认入口

---

## 一、当前状态一览

| | 数量 |
|---|---|
| TS 代码 | 以 `src/`、`web/`、`tests/` 为当前源码边界（含测试、React UI 源码与 Unicode 映射） |
| TypeScript 后端测试 | **627 通过**（2026-11-26，A–D + C4-1～C4-5 修复、方案 B 静态产物 CSP 校验与 schema v13 当前门禁） |
| 前端测试 | **70 通过**（同一门禁，另含 `typecheck:web` 与 `build:web`） |
| 历史参考实现 | 当前分支已移除 Rust workspace；参考保留在 Git 历史，见第九章 |
| 不变量规格总条数 | **85 条**（8 个章节） |
| 已覆盖 | **85 条**（§1–§8 全部，§7 已由 T13 补齐） |
| 重构剩余 | **0 条**；T14–T17 不属于语言迁移验收 |

```
进度  ██████████████████████████████  85 / 85
```

**M1–M3 已闭环，TypeScript 重构完成。** T13 补齐只读模型 Harness、三表 Agent 控制面、显式批准后的 Claude/Codex CLI 编排和浏览器入口。删除前后均通过 TS 全量门禁，已按第九章移除当前分支的 Rust workspace。只读 CLI、真实账号 smoke 与进程隔离的实际边界见 [AGENT_CONTROL.md](AGENT_CONTROL.md)，验收记录见 [TS_ACCEPTANCE.md](TS_ACCEPTANCE.md)。

### 既有执行决定与交付（2026-11-03 起）

当前以个人助手为主，保留单入口、多 Bucket；多人协作只记录远期假设。个人多设备指手机安全接入电脑端，现阶段仅预留文档接口，不实现远程服务、配对或认证。完整决定见 [PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)，远程边界见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md)。

Q1–Q4 代码与自动验收已收口，有限真实浏览器 smoke 的范围和待人工事项见 [CORE_FLOW_ACCEPTANCE.md](CORE_FLOW_ACCEPTANCE.md)；完整实施记录见 [QUALITY_IMPLEMENTATION.md](QUALITY_IMPLEMENTATION.md)。阶段结果：

1. **Q1：T13 基线收口（完成）**——已审查现有实现、补修 session 恢复/队列清理边界，完整门禁通过，保留本地数据和用户文件。
2. **Q2：Entry 撤销（完成）**——逻辑撤销、存储/检索/HTTP/UI、模型历史和 CLI session 失效已实现并回归；[合同与限制](ENTRY_REVOCATION.md)。彻底清除另行设计。
3. **Q3：API 与架构规范（完成）**——30 个业务 method/path 统一请求/响应/错误/SSE schema、派生 DTO 与浏览器验证，生成 OpenAPI 3.1 并加入漂移门禁；[接口规范](API_CONTRACT.md)、[架构决策](ARCHITECTURE_DECISIONS.md)。保持 Hono 和单机 SQLite。
4. **Q4：核心流程联合验收（自动验收完成）**——三项真实 socket/API 模块集成测试与有限浏览器 smoke，输入、四种确认、查询、纠错/撤销、任务批准/取消及重启恢复通过；原生弹窗、触控/软键盘等人工体验未签收。

Q1–Q4 和 T14 可工作功能链路已完成，2026-11-12 完成前端视觉与工作区结构初版，见 [FRONTEND_DESIGN.md](FRONTEND_DESIGN.md)。真实自用验收、视觉细化和 T15–T17 仍在后续决定。远程接入不自动进入下一实现阶段。上一轮六项修复与验证见 [REVIEW_FIXES.md](REVIEW_FIXES.md)。

### 任务与记忆接入设计（2026-11-18，D3 L0 恢复与检索对照）

本轮先完成 [腾讯记忆接入前的本地任务实施](LOCAL_TASK_IMPLEMENTATION.md)：WorkItem、目标/执行关联、schema v8、严格 HTTP/OpenAPI 和长期对话中的目标卡片已交付；未交付自动自然语言分发、MemoryCore 接入或真实数据迁移。D3 已完成 [L0 词法冒烟](D3_L0_SMOKE_REPORT.json)、[L1 隔离提取](D3_L1_CORE_REPORT.json) 和 [首轮 D3.4 故障与撤销验证](D3_FAULT_MATRIX_PLAN.md)；真实 Core 的部分 L0 代次检查已通过，完整 D3 尚未验收，当前没有生产适配器。[真实 L0 恢复和范围清理](D3_L0_RECOVERY_PLAN.md)已通过合成场景。固定自然语言查询中 Core 找回更多目标，但无证据查询误入更多，暂不进入 D4b。若重启 D3 研究，先验证相关性与弃答规则，再单独验证向量/混合检索和 L1 来源生命周期。

核心方向为个人助手统一入口、任务与执行会话分离、单任务单执行者，以及仅同步现有规则接受的有效 Entry。保留本地审批、TODO 和撤销权威；独立 MemoryCore 作为候选派生引擎，逐层验证来源、撤销、同步未知结果和故障降级。T15/T16 不自动提前，T17 导出/导入承诺保留；远程接入与多人协作边界不变。前端沿用 11 月 12 日初版，仅增加本地目标表单和卡片；全面视觉重做不是腾讯接入前置。

### 后端修缮 R0–R5（已完成）

后端修缮 R0–R5 的实施与架构边界见 [验收记录](BACKEND_REPAIR_ACCEPTANCE.md)。R1 修复事务、标题完整性与历史窗口；R2 统一聊天轮次；R3 拆出对话存储和中立只读记忆能力；R4 减少检索重复关联、将恢复移出正常 GET。完整门禁为 471 后端 + 60 前端通过。检索仍同步线性扫描且峰值内存增加，旧 Store 仍保留兼容门面；这些限制已列明。

### 后端后续修复阶段 0–3（已完成）

后端修缮 R0–R5 与后续 A1–A3 的提交、行为合同和逐阶段验收见[后端修缮验收记录](BACKEND_REPAIR_ACCEPTANCE.md)：跨范围 WorkItem 最近尝试摘要同步；传输层按实际响应体字节限制为 1 MiB；归档投影只查询当前 Entry 的有效 Memory ID，历史卡片只查 Bucket 元数据。A1/A2/A3 提交分别为 `0dcce2d`、`8652db8`、`8b7c2d6`。B1 Agent 终态合同、B2 结构化模型重试已独立提交并完成验收；最新前置门禁为 550 后端 + 60 前端通过，详见[C0 前计划](PRE_C0_BACKEND_PLAN.md#9-当前执行记录)。索引/分页 D1 与 Store 职责 D2 仍未实施，不自动阻塞 C0。

### 主对话澄清与本地续做（C0–C3、N0–N3 与 A–D 自动化验收完成，C4 待评估）

后端 R0–R5、A1–A3 与 B0–B3 已完成；[C0 行为基线](MAIN_CONVERSATION_C0_ACCEPTANCE.md)已验收。产品目标仍是用原请求绑定补充、复用 WorkItem 和有效 Entry，需要检查工作区才走受批准的只读执行。[C1 用途分流](MAIN_CONVERSATION_C1_ACCEPTANCE.md)已在 ChatService 中完成，旧 API 与默认网页保持兼容。[C2](MAIN_CONVERSATION_C2_ACCEPTANCE.md) 已交付可恢复的澄清卡；[C3](MAIN_CONVERSATION_C3_ACCEPTANCE.md) 已接入本地上下文、证据引用和受批准只读执行。[N0–N3](NATURAL_CONVERSATION_ACCEPTANCE.md) 与自然对话审查修复 **A–D（F1–F9，schema v13）** 已完成自动化验收，并已补齐 F1、F2/F3、F4、F7、F8、F9 的隔离浏览器 smoke；网页自然续接仍是默认关闭的预览。下一步冻结真实模型配置/预算，做 C4 真实质量与操作体验评估，再决定是否切换默认入口。保留 Bucket；腾讯 D3 是已有隔离证据，D4b 不是本阶段前置。

2026-11-25：N0–N3 历史验收见[历史验收记录](NATURAL_CONVERSATION_ACCEPTANCE.md)；随后发现的 F1–F9 已按[修复计划](NATURAL_CONVERSATION_REPAIR_PLAN.md)及[测试矩阵](NATURAL_CONVERSATION_REPAIR_TESTS.md)完成 A–D 实现，并通过完整自动化门禁（619 后端 + 70 前端，schema v13）与隔离浏览器 smoke（F1、F2/F3、F4、F7、F8、F9）。主输入可续接已观察的澄清，从有效 Entry 或本轮材料消息定位材料且不预建 WorkItem，失败后支持受绑定重试；卡片仍是可选快捷入口。普通聊天不自动归档，归档/执行批准边界不变。真实模型质量评估和 C4 默认入口决策尚未完成。

### 阶段冻结与未完成事项（2026-11-25）

**当前代码基线**：`codex/natural-conversation` 已在 B0–B3（`5ec83c6`）之上交付 C0–C3、N0–N3 与自然对话修复 A–D（`884d882`、`b9d6ea1`、`7c726f9`，schema v13），并补齐隔离浏览器 smoke；全量门禁 619 项后端测试、70 项前端测试通过。当前工作树中的用户 PDF 与 SQLite sidecar 是未跟踪本地文件，保留原状，不纳入提交。

| 状态 | 未完成事项 | 后续依据 |
|---|---|---|
| 已完成 | React 19 + Vite + Tailwind CSS v4（方案 B）三栏 UI 实施并通过 `npm run check`（627 后端 + 70 前端）与隔离浏览器 7/7 验收 | [UI 架构设计](UI_ARCHITECTURE_DESIGN.md)、[C4 评估报告](MAIN_CONVERSATION_C4_EVALUATION.md) |
| 延后设计门 | D1 检索规模/分页/性能测量；D2 Store 职责与跨层依赖渐进收敛 | [C0 前修缮计划 §7](PRE_C0_BACKEND_PLAN.md#7-d1d2明确保留的后续设计门) |
| 未验收、非当前链路前置 | 腾讯记忆 D3 完整评测及 D4b 生产接入 | [主对话实施计划 §7](MAIN_CONVERSATION_PLAN.md) 与 D3 计划 |
| 明确延后 | 真实自用长周期验收、深色模式视觉细化、远程多设备接入和多人协作 | 需要独立需求/验收依据；远程边界见 [REMOTE_ACCESS.md](REMOTE_ACCESS.md) |
| 尚无本阶段实施设计 | T15–T17 的后续功能 | 保留后续规划；开始前另行确定目标、范围和验收条件 |

C0 已固定旧入口行为并整理 11 组样本。C1 验收后的完整门禁为 561 项后端和 60 项前端通过；当前 A–D 修复后门禁为 619 项后端和 70 项前端通过。详细设计见 [主对话实施计划](MAIN_CONVERSATION_PLAN.md)。

### 分支布局

| 分支 | 内容 | 状态 |
|---|---|---|
| `main` | 原始 Python 实现 | 冻结 |
| `dev` | Python + Rust 并存 | **Python 参考**，`128 passed in 6.18s` |
| `dev_rust` | 纯 Rust workspace | **Rust 参考**，124 测试 |
| `dev_ts` | TypeScript 集成基线分支 | 包含 R0–R5、A1–A3、B0–B3 和 C0 开工前交接 |
| `codex/main-conversation-backend` | 主对话实施基线 | 包含 C0–C3 自动化验收 |
| `codex/natural-conversation` | ← **当前实施分支** | 包含 N0–N3、A–D（schema v13）、C4 真实模型对照/复验与默认入口切换（可随时切回旧聊天） |

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

### 阶段 B — TypeScript 重写与本地产品收口（T1–T10b 已完成）

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
| **T9** | `d2fdf0e` | 分类/提取评测 harness 与 live 报告 |
| **T9b** | `fb79763` | HTTP 连接、header 和 request 资源上限 |
| **T10** | `ac0dbd8` | MCP 只读工具与待确认 `propose_entry` |
| **T10b** | `4bc7b69` | TypeScript Web production bootstrap 与浏览器/MCP 共库 E2E |

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
M1  TS 与 Rust 功能对等         T3 ✅ → T8b ✅   ← 已完成，CI 就位
M2  记忆开始被日常消费           T9 ✅ → T9b ✅ → T10 ✅  ← 已完成
M3  Doggie 成为 Agent 控制面    T11 ✅ → T12 ✅ → T13   ← §7 在此覆盖完
       ↓
    ⚑ 删除 Rust workspace（前置条件见第九章）
       ↓
Q   当前质量与契约收口          Q1 → Q2 → Q3 → Q4
       ↓
M4  日常长期助手                T14 → T17（顺序在 Q 阶段后复核）
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

**关于删除 Rust**：原计划写的是"M1 完成后就删"。**这个判断已修正**——M1 完成时 §7 还没覆盖，
而 §7 的行为唯一活的参考就在 `crates/doggie-agent-runtime`。完整的前置条件和执行清单见**第九章**。

### M2 — 记忆被消费

| # | 阶段 | 交付 | 说明 |
|---|---|---|---|
| **T9** ✅ | 评测 harness 恢复 | 分类准确率 + 提取忠实度 + live 报告 | 已补回规格 §9 标 `[!]` 的能力；人工标注 fixture 已从 `dev` 分支复用 |
| **T9b** ✅ | HTTP 资源上限 | `maxConnections` + 收紧 `headersTimeout` / `requestTimeout` | `fb79763`，见 D11 |
| **T10** ✅ | **MCP server** | 只读工具 + `propose_entry` | `ac0dbd8`，开始覆盖 §7 |
| **T10b** ✅ | **TypeScript Local Web 收口** | 生产 bootstrap + `.env` + `npm start` + 浏览器/MCP 共库 E2E | `4bc7b69`；M2 产品链路闭环 |

**T9b 的范围刻意很小**。已实测确认（见 D11）：TS 版的 HTTP 层**不存在** Rust 版那种"慢请求占用整个服务循环"的问题，
所以这里只补真正缺的资源上限。**请求级取消不在 T9b**——它属于 T12，理由见 D11。

**T10 为什么最高杠杆**：它让已有的存储+查询层**每天在你用 Claude Code 工作时被调用**，而不是只有侧边栏在用。`AGENT_TOOL_DEFINITIONS` 已经是 JSON Schema 形状，MCP 的 `tools/list` 返回的就是这个——缺的只是协议传输层。

```bash
claude mcp add doggie -s user -- <doggie-mcp 路径>
```

> **安全约束**：第一版只暴露只读工具。写操作走 `propose_entry` → 返回"已提交待确认" → 你在 Doggie UI 里批准。**agent 不得绕过确认门控直接写。**

> **必须尽早加 `propose_entry`**：否则 MCP 越好用，记忆越贫瘠——你和 agent 的整段对话对 Doggie 不可见，长期记忆会退化成只读档案馆。

**T9b 已完成**（`fb79763`）：`src/http/server.ts` 现在默认限制 32 个连接，将 header timeout 从 Node 默认 60 秒收紧到 10 秒，将 request timeout 从 300 秒收紧到 120 秒；保留 `maxRequestsPerSocket = 1`。配置只接受正安全整数，测试不需要真实监听端口即可固定这些资源属性。请求级取消仍按计划留给 T12。

**T10 已完成**（`ac0dbd8`）：

- 使用官方 `@modelcontextprotocol/server` v2 和 stdio transport，入口为 `bin/doggie-mcp` / `npm run mcp`；
- 暴露 `list_active_buckets`、`search_memory`、`get_bucket_detail` 三个只读工具；
- 暴露 `propose_entry`，但只创建 durable `needs_confirmation` attempt，不创建正式 Bucket、Entry 或 memory；
- proposal 同时写入一张聊天历史确认卡片，Web UI 刷新后继续复用现有 `/api/chat/confirm` 四分支确认流程；
- MCP schema 严格拒绝未知字段，限制 query 500 字符、Bucket ID 200 字符、proposal 16,000 字符、stdio 消息和工具输出 64 KiB；
- 未注册的直接写工具不在 `tools/list` 中，并由官方协议层拒绝；
- `@modelcontextprotocol/client` 仅作为 devDependency，通过官方 in-memory transport 验证 `tools/list` / `tools/call`；
- `package-lock.json` 已纳入版本控制，使 T8b 的 `npm ci` 具备可复现输入；
- 使用说明见 `docs/MCP_SERVER.md`。

T10 提供的是 MCP 工具边界，不是完整的多轮模型 Harness：tool round、上下文/历史预算和 Responses/Chat parity 仍属于 T13。因此 §7 仍保持“未全部完成”，不能提前删除 Rust oracle。

**T10b — TypeScript Local Web 启动与浏览器端到端收口（已完成，`4bc7b69`）**

T8 已完成前端 TypeScript 化、共享 DTO、静态资源 type stripping 和 headless Chrome 资源 smoke test；T7 已完成 Hono API 与 Node HTTP adapter。T10b 现已补齐两者之间的 production composition root，使仓库可直接启动完整 TypeScript Web MVP；该阶段只收口 M1/M2 产品验收，不扩展 T11–T13 的 Agent 控制面范围。

交付范围：

- 新增 TypeScript production bootstrap，组装 SQLite、LLM endpoint/transport、`StructuredMemoryModel`、`ArchiveRuntime`、`ConcreteDoggieHttpApi` 和 Node HTTP server；
- 使用 Node 24 标准能力加载当前工作目录 `.env`，保持进程环境变量优先，并严格校验必填模型配置、timeout、数据库路径和 loopback 监听地址；
- 在 `package.json` 提供稳定的 `npm start`，启动后输出实际 loopback URL，支持 SIGINT/SIGTERM 有界关闭并关闭数据库；
- Web 与 MCP 使用同一个 canonical SQLite 路径；`propose_entry` 产生的 durable confirmation card 必须能从 Web `/api/chat/history` 恢复并通过现有确认路由处理；
- 普通测试只用 fake model/transport 和临时数据库，覆盖配置优先级/脱敏、真实 Node socket、前端静态资源、归档写入、重启恢复及 MCP→Web 共库链路；
- 增加独立进程 smoke test，证明 `npm start` 能读取 `.env`、监听 loopback、响应 `/health`，且测试不调用真实模型；
- 更新 README、`.env.example`、`AGENTS.md` 和 MCP 文档，删除“TS Web 尚无入口”以及 Rust 仍是产品启动方式的过时描述。

T10b 的完成标准：

```text
npm ci
cp .env.example .env
chmod 600 .env
# 填写 OPENAI_API_KEY / OPENAI_MODEL
npm start
# 浏览器打开 http://127.0.0.1:8787/
```

在该流程下，用户可以完成聊天归档、低信息确认、Bucket/Entry 查看与纠错、自然语言查询，并处理 Claude/Codex 通过同一数据库提交的 MCP pending proposal。模型回答阶段的完整只读工具循环、上下文预算和 Claude/Codex 任务编排仍分别属于 T13，不在 T10b 提前实现。

T10b 最终实现与验证：

- `src/main.ts`、`src/runtime/config.ts`、`src/runtime/local-web.ts` 形成 production 启动、配置和生命周期边界；
- 监听仅接受字面量 `127.0.0.1` / `[::1]`，绑定后再次验证实际地址；模型 timeout 限制为 1–300 秒，API Key 在配置对象检查输出中脱敏；
- 进程关闭会取消生产模型请求、停止 HTTP server 后再关闭 SQLite；重复 `close()` 共享同一个 Promise，监听失败会释放数据库；
- SQLite 启动先验证数据库所有权再切换 WAL，校验 schema identity/shape/migration ledger，并用 `BEGIN IMMEDIATE` 序列化 Web/MCP 首次并发迁移；
- `npm run check` 通过：204 个 TypeScript 测试 + 23 个前端测试，共 227 个；独立 `npm start` smoke、真实浏览器 HTTP 链路、进程关闭和 MCP→Web 共库确认均已覆盖。

### M3 — Agent 控制面

| # | 阶段 | 交付 |
|---|---|---|
| **T11** ✅ | `PendingAction` 泛化 | 把 `ArchiveAttempt` 抽象成通用待批准动作，顺带合并两套并行归档流 |
| **T12** ✅ | 任务队列 + 后台执行器 + SSE + **请求级取消** | Node 原生 async，不需要 tokio 那种重构 |
| **T13** ✅ | Agent 编排（只读 MVP） | `agent_workspaces` / `agent_sessions` / `agent_tasks` 三表 + spawn `claude`/`codex` |

**T11 的关键洞察**：`ask_user` → 确认卡片 → 服务端执行，**已经是 agent action approval 的正确形态**。扩展不需要发明新安全模型，只需泛化：

```
PendingAction
  ├─ kind: archive | agent_task | scheduled_run | bulk_mutation
  ├─ proposed_by: model | schedule | user
  ├─ payload / binding（防伪造）
  └─ status: pending | approved | rejected | executed | failed
```

**T11 已完成（2026-10-08）**：采用增量、无新增依赖的轻量实现，不一次性重写现有 API 或 UI。

- `src/domain/pending-action.ts`：严格 Zod 判别联合，四类 payload、来源和五态状态机；未知字段/类型拒绝，proposal 只有数据权限。
- `src/storage/pending-actions.ts`：持久化读取校验、原文 binding、单次 CAS 状态转换，批准时记录用户选择，结果仅存稳定 ID；失败仅存稳定错误码。
- schema v3 新增 `pending_actions` 和不可改写 proposal 的 trigger；v2→v3 在迁移事务中按旧确认 ID 回填 pending / executed / rejected，聊天卡片 ID 不变。
- `archive_attempts` 保留为原有归档审计和 HTTP DTO projection，**不是独立授权路径**；所有确认同时校验 generic action 和旧审计。删除这个表会破坏历史审计、纠错和 DTO，因此本阶段不强行重命名全部业务对象。
- 自动归档仍遵循领域门控；`ask_user`、MCP proposal、用户显式 append/create 共用批准流程。显式保存先登记 `proposed_by=user` 的 proposal，再使用用户给定选择执行；不额外弹出第二次确认。
- 归档 `pending→approved→executed` 与 Bucket/Entry/Memory/attempt 在**一个 SQLite 事务**中完成；失败全部回滚，原动作保留 pending。通用 approve/reject/finish 方法不能处理 archive，避免旁路绕过写入门控。
- 非归档三类动作仅提供持久化 proposal 和状态转换，不新增 HTTP/MCP 写接口，不启动真实 agent / schedule / bulk executor；这些执行能力分别留给 T13–T15，T12 只运行现有后台聊天服务。
- 显式保存先完成模型提取，再登记用户 proposal 并复用确认事务；提取失败不留下隐形 pending，正式写入失败的无 UI 卡片 proposal 自动终结为 rejected。既有 UI 卡片确认失败仍保留 pending。
- HTTP / runtime / store 的 pending 前置校验统一；并发确认可各自提取，但只有一次事务写入成功。取消已在 T12 覆盖；同一确认的重复提取暂不做共享 Promise，仍由单次事务阻止重复写入（请求级 signal 不共享）。

**同期 TS 解耦**：前端搬到 `web/`，更新共享 DTO import、静态加载路径、`test:web` glob 和 typecheck include。生产启动、MCP、CI 和普通测试不读 Rust 源码、不调用 Cargo；保留人类可读的历史 fixture。Rust Web oracle 仅调整资源定位到 `web/`，无功能修改，避免搬迁将冻结参考的构建路径弄断。

T11 验收覆盖：原文防伪造、单次/并发确认、拒绝、非法状态转换、事务故障注入回滚、v2 migration、数据库重开、不可修改 proposal、输入资源上限及 MCP 只提案。`npm run check`（真实 socket 需沙箱外权限）通过，222 个后端 + 23 个前端测试；未运行真实模型或访问用户数据库。详见 `docs/TEST_PLAN.md` 的 T11 项。

**T12 已完成（2026-10-08）**：采用标准库 + SQLite 的轻量化后台聊天任务，不新增依赖，不提前启动 Claude/Codex 进程。

- schema v4 新增 `background_tasks` / `background_task_executor`；严格 128 KiB payload、32 个 outstanding、最多 200 个保留任务；不可变单调 sequence 保证同毫秒 FIFO，claim/终态 CAS，单 Web worker ownership。
- queued 重启继续，running 重启变为 `failed / interrupted`，不自动重放；正常 shutdown 取消当前工作并等实际 handler/worker 后才关 SQLite。ownership 对活 PID / 不确定 PID fail closed。
- 新增任务 submit/list/get/cancel/events HTTP 路由，后台执行现有 `ConcreteDoggieHttpApi.chat`；低信息门控、T11 pending confirmation 和 MCP 四工具权限不变。不会把 generic agent/schedule/bulk payload 作为可执行命令。
- SSE 即时分块、socket backpressure、有界快照合并、心跳和断线 reader/listener 清理；连接断线不取消持久化后台任务，显式 cancel/deadline/shutdown 才取消。
- Request signal 传播至 API / archive runtime / structured output / fetch；模型 await 两侧和写入前检查，取消不重试且 abort reason 脱敏。正式归档已提交后不承诺撤销，不写入晚模型工具消息。
- 终态持久化失败与 executor 失败区分：不伪报已提交效果为 cancelled，不自动重放，worker 停止接收并在 close 报告稳定错误。startup 清理即使 queue close 出错也必须释放 DB，保留原启动错误。
- 浏览器聊天改为后台 submit，任务列表/取消/刷新恢复；严格 SSE parser，断线只 GET 有界轮询，POST 结果不明不自动重发；keyed history 渲染保留未改变确认表单和滚动位置。
- 原 `/api/chat` / archive / confirm 同步路由保留；SSE 是任务状态，不是 token 流式回答。AbortSignal 为协作取消，永不返回的非协作执行器仍会阻止安全 shutdown。

最终 `npm run check`（真实 socket / subprocess 需沙箱外权限）通过：**299 后端 + 50 前端，共 349 个**；格式、最高严格度 typecheck、`git diff --check` 均通过。审查发现并修复终态存储故障误标 cancelled、worker fault 丢失、同毫秒 FIFO 和 startup 清理及 drain 后探测故障问题，并补故障注入测试。全部 fake model / 临时库，未访问真实数据库/密钥、未调用真实模型。详细说明：[TASK_QUEUE.md](TASK_QUEUE.md)。


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

**T13 已完成（2026-11-03）**：

- `src/agent/harness.ts`：生产聊天回答进入有界多轮检索；固定只读工具表、严格参数、数据错误、写工具过滤；Responses / Chat Completions 对等，保留无状态 reasoning 数据且不接受模型伪造系统角色。§7 九条已有可执行测试。
- schema v5：三张 agent 表和 `buckets.workspace_id`；工作区 Git 内容基线和 session/task proposal 不可变；批准与 PendingAction、后台队列单事务绑定，禁止跳过或重复批准。
- `WorkspacePolicy`：真实路径、白名单、存在性、Git HEAD/状态/内容摘要、跨基线同路径互斥和 session↔工作区一致性。过大快照/子模块 fail closed。
- `AgentService` + `CliAgentRunner`：后台 worker 调用固定 CLI，指令只通过 stdin；独立配置、只读工具、有限 JSONL、显式远端 session 恢复、取消/超时回收。无目录任务关闭文件工具并使用稳定私有 cwd。
- 浏览器侧栏提供登记目录、关联 Bucket、选择 CLI/工作区、恢复会话、创建提案、批准/拒绝、最终结果和取消；复用 T12 SSE，刷新不自动重复提交。
- 重启不重放 running，失败会话不复用；成功落盘故障停止 worker，不误报取消。默认不启用任何 CLI；本阶段不开放 coding 写入、自动提交、部署或调度。

删除前完整门禁 **329 后端 + 51 前端 = 380 测试通过**，无失败/跳过。新增验证含真实 HTTP runtime（fake runner）、进程组强制取消、输出预算、v4→v5 数据保留、工作区变化、绑定防伪造、只读 MCP 和 XSS。未调用真实模型或访问真实用户数据。CLI 参数依据当前 `--help` 和官方接口核对，旧计划的 `--permission-mode manual`、同时传 `--session-id/--resume` 已纠正；详见 [AGENT_CONTROL.md](AGENT_CONTROL.md)。

### M4 — 日常长期助手

| # | 阶段 | 交付 | 参考实现 |
|---|---|---|---|
| **T14** | TODO 生命周期 + agenda | `SCHEDULED` / `DEADLINE` / repeater | **org-mode / org-agenda** |

T14 的实现规划见 [T14_PLAN.md](T14_PLAN.md)。T14-A–B 已冻结并实现五状态、显式时间计划、受限重复规则、schema v7、迁移和 Store；T14-C–D 已实现严格 HTTP/OpenAPI 契约和功能性 Agenda MVP；T14-E 联合验收与阶段提交已完成。
| **T15** | 调度器 + 系统通知 | 持久化调度、重启补跑策略 | 本地进程直接调 `notify-send` |
| **T16** | 插件系统 | Doggie 作为 MCP client | 插件 = MCP server，任意语言、进程隔离 |
| **T17** | **数据导出/导入** | 全量导出、可重新导入 | Q3 明确承诺的未来需求 |

**T17 为什么单列**：Q3 决定不兼容旧库，代价是数据可迁移性要靠导出/导入补回来。这也是信任问题——**数据出不来的"长期记忆"，用户不会持续投入**。T3 的 schema 设计已为此预留。

**T14 当前判断**：现有 `memory_items` 继续作为 TODO 权威对象；schema v7 已增加 `scheduled_at`、`todo_rule_json`、`todo_raw_time_json` 和 `todo_occurrence`，旧 `due_at` 保持原义。Agenda、状态/计划变更、重复推进、重新打开和 Entry 撤销后的有效性均通过 Store 与 HTTP 契约暴露。

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
| D3 | Rust 代码**暂不删除** | ~~M1 完成后统一删~~ → **已修正**：改为按 §7 覆盖情况判定，见第九章 |
| D4 | 依赖保持极少 | 延续原项目原则；去掉的是生态税不是纪律 |
| D5 | 无构建步骤 | `erasableSyntaxOnly` 由编译器强制 |
| D6 | 错误用 `throw` 不用 `Result` | 保留可穷尽 `kind` 判别式供 HTTP 映射；Result 在 TS 里与生态冲突 |
| D7 | 品牌类型 | 复现 Rust "验证过的值才能存在" |
| D8 | 候选构造**忽略 UI 选中项** | 跟随 Rust 而非 Python；`focus_bucket_id` 仅作兼容/审计 |
| D9 | `*.md` 排除出 Prettier | 它按 UTF-16 码元补齐表格，CJK 双宽会歪 |
| **D11** | **HTTP adapter 保持自研，不换 `@hono/node-server`** | 见下方展开 |
| **D12** | **排序一律用码点比较，禁用 `localeCompare`** | 见下方展开 |
| D10 | 先 MCP server 再 orchestrator | B 方向 1–2 天且已完成 80%；A 方向数周。且 B 是 A 的组件 |

---

### D11 展开 — HTTP 层的六个担心，实测后只剩三个

2026-08-25 对当前 TS 实现做了实测（不是推断）：

| 担心 | 实测 | 判定 |
|---|---|---|
| 一个 LLM 慢请求占用整个服务循环 | 1.5s 慢请求在飞时，并发读 **16ms 返回** | ❌ 不成立 |
| 慢客户端影响后续请求 | 同上，`node:http` 事件驱动 | ❌ 不成立 |
| 并发能力很弱 | 单进程 Node 对单用户本地应用够用 | ❌ 不成立 |
| 没有请求级取消 | 当时客户端 abort 后 handler 仍跑完全程 | ✅ **T12 已修复**：Request signal 传播 + 写入前门控 |
| 没有连接数限制 | `maxConnections` 未设置 | ✅ **T9b 已修复**：默认 32 |
| 没有任务配额 | 当时无后台队列 | ✅ **T12 已修复**：队列容量和 payload/订阅上限 |

前三条在 **Rust 版是真问题**（`for stream in listener.incoming()` 串行 + `ureq` 阻塞式 HTTP），
换到 `node:http` + `await fetch` 之后自动消失。**这是换语言一个此前未记录的收益。**

Node 默认值已提供部分保护：`headersTimeout` 60s（基本 slowloris 防护）、
`requestTimeout` 300s，代码另外显式设了 `maxRequestsPerSocket = 1`。

**是否造轮子——分三层看：**

| 层 | 判定 |
|---|---|
| Hono 路由 / 中间件 | ✅ 没造轮子，`app.ts` 在用 |
| `node:http` | ✅ 不是造轮子，它是标准库，所有框架底下都是它 |
| adapter 层（`server.ts` 361 行） | ⚠️ **约一半重复了 `@hono/node-server`** |

重复的是 `toFetchRequest` / `writeFetchResponse` / `readRequestBody`。
**另一半是 S1 安全边界特有的**，官方 adapter 不提供：重复 `Host`/`Origin` 检测（请求走私信号）、
头部大小上限、HEAD 响应在 socket 错误路径上也不能带 body。

**决定不换**，三个理由：它能工作且有 37 个 HTTP 测试覆盖边界；换 adapter 要把安全规则
重新嫁接到中间件层，是**有风险的改动而收益只是代码变少**；当前瓶颈在 T10 而不在这里。

**限流为什么也推迟**：对 loopback 单用户，限流真正防的是"前端 bug 导致的请求风暴"，不是攻击。
T12 已把任务配额落在**队列层**，保留 Node adapter 的连接/请求字节限制；没有额外引入通用 HTTP 限流框架。

### D12 展开 — 排序必须与 locale 无关

`tests/storage-parity-snapshot.ts` 曾用 `localeCompare` 给快照记录排序。本机 locale 是 `zh-CN`，
它把两条 CJK 记录判成与码点顺序**相反**，导致 parity 测试红灯——而两边内容其实完全一致。

**真正的问题不是测试红了，是测试结果取决于机器**：CI runner 的 locale 通常是 `C`/`en_US`，
会得到与本地不同的排序。刚加的 CI（T8b）本会因此与本地长期不一致。

**规则**：任何进入断言、快照或稳定排序的比较，一律用码点比较（`a < b ? -1 : a > b ? 1 : 0`）。
`localeCompare` 只允许用于**面向用户展示**的排序。已修三处并在 `C` / `en_US` / `zh-CN` 三种
locale 下验证（提交 `8d8f3ae`）。

> 附带教训：UUID 也不能用 `localeCompare` 做 tiebreak——某些 collation 会忽略标点，而 UUID 全是 `-`。

---

## 五、已拍板的决策（2026-08-24）

| # | 问题 | 决定 |
|---|---|---|
| **Q1** | 协作者分工 | **他在 TS 重构完成后开始写代码。** 重写期间仍是单人，但**M1 收尾加 CI（T8b）**，在他加入之前就位。我此前「单人不需要 CI」的建议到那时作废 |
| **Q2** | 模型 provider | **保留 OpenAI 兼容端点**，当前不是关键问题，**不为此额外投入**，provider 抽象保持最小 |
| **Q3** | 是否兼容现有 `doggie.db` | **不兼容。** 现有数据量少、可随时重新自测。T3 不做 legacy 导入，物理 schema 可自由设计（仍保留 §4 全部事务语义）。**导出/导入延后到 T17** |
| **Q4** | `HEAD` 返回 404 | T7 重建路由时顺手修——正确的 HTTP 行为，成本近零 |
| **Q5** | 评测 fixture | **复用 `dev` 分支的人工标注**，不重新标注 |
| **Q6** | `renderHistory` 全量重渲染 | **T12 已完成**：keyed 增量更新、表单和滚动位置保留 |
| **Q7** | 删除 Rust 时机 | **M1 完成后**，差分测试价值在 M1 阶段最高 |

### Q3 的两个后果

**省掉的**：不用写 `legacy_import.rs`（780 行）的等价物；schema 不必逐列复刻 Rust canonical 表。

**必须记住的**：**T17 数据导出/导入是明确承诺的未来需求**。因此 T3 的 schema 必须满足三个条件——业务 ID 稳定（不依赖 rowid）、无隐藏状态、所有派生数据可从原文重建。一个「长期记忆」产品如果数据出不来，用户不会愿意持续投入。

---

## 六、风险登记

| # | 风险 | 当前影响 | 何时会变严重 | 应对 |
|---|---|---|---|---|
| R1 | **`node:sqlite` 是同步的**，查询期间阻塞事件循环 | 微秒级，无影响 | T5 查询在真实数据量下变慢时——它会同时拖慢所有并发请求，且**不像 LLM 调用那样能 await 让出** | 有真实数据后测一次 p99；必要时把重查询移进 worker thread |
| R2 | Rust oracle 已冻结、CI 不跑，会静默腐烂 | 无 | 拖太久之后 `cargo test` 跑不起来，删除前的最后一次对拍就做不成了 | 第九章条件 1/4 满足即删，不无限期留 |
| R3 | 删除 Rust 后 parity fixture 不可自动再生 | 无 | 需要有意修改被冻结的行为时 | fixture 保持人类可读；改动必须在提交信息里写明理由（见 9.5） |
| R4 | 协作者加入时仓库里有两套实现 | 无 | 他加入那天 | 尽量在他加入前完成删除；否则第九章 9.2 的"允许/不允许"表要先给他 |
| R5 | 前端目录耦合在 Rust crate 下 | 无 | 删除 Rust 时 | 与删除同批 `git mv` 到 `web/`（见 9.4 步骤 ②） |

## 七、工作方式约定

沿用至今的做法，如需调整请指出：

1. **每完成一个阶段 = 一次提交 + 一份总结**；在用户已授权的连续实施范围内继续下一阶段，新增范围或关键产品歧义才另行讨论
2. **每条不变量都要有可执行测试**——不允许用"代码看起来做了这件事"代替
3. **能对拍就对拍**——固定测试只覆盖想得到的输入，差分测试覆盖想不到的
4. **发现规格错误就地修正**并在总结里说明（已发生 2 次：Unicode 数字、Prettier 表格）
5. **如实报告**——跑不通就说跑不通，跳过就说跳过

### 每阶段的验证门禁

```bash
npm run check      # format:check + typecheck + test + test:web
```

---

## 八、参考实现随时可查

```bash
git show dev_rust:crates/doggie-domain/tests/classification.rs   # Rust 行为
git show dev:app/services/archive_service.py                     # Python 行为
git stash && git checkout dev && .venv/bin/python -m pytest tests -q   # 跑 Python
```

---

## 九、Rust 退出验收（已完成，2026-11-03）

| 条件 | 验证 |
|---|---|
| §7 全部九条有 TS 可执行测试 | `src/agent/harness.test.ts`，双 API mode，含 32/64 KiB 预算、100 条历史和写权限过滤 |
| 历史 fixture 保留且生成来源可追溯 | `tests/fixtures/README.md`，两份 parity fixture 原样保留，另迁出 protocol fixture |
| 前端独立与本地 CI 同命令门禁通过 | `web/` + `npm run check`；远程 CI 需推送后运行，不声称已执行 |
| 最近连续两阶段不依赖 Cargo 裁决 | T11、T12 及 T13 都以 TS 测试验收 |

满足条件后，删除当前分支 Git 跟踪的 `crates/`、`apps/`、`Cargo.toml`、`Cargo.lock`，清理配置中的旧目录排除和文档中的运行指引。未删除用户未跟踪 PDF、忽略的本地文件、数据库或任何其他分支。

参考源码仍可从移除前提交 `bc88675` 或既有历史分支读取，不需要在当前产品目录重新安装 Rust 工具链。`tests/fixtures/README.md` 记录在隔离历史工作树中的再生成方式。fixture 是历史合同快照；有意改变行为时同时更新测试并说明原因。

验收结论及现实限制见 [TS_ACCEPTANCE.md](TS_ACCEPTANCE.md)。后续 T14 TODO、T15 调度通知、T16 插件、T17 导入导出是新增产品能力，语言迁移不再等待它们。
