# 后端修缮验收记录

2026-11-18 · 专用分支 `codex/main-conversation-backend` · R0–R5 完成；R4 实现提交为 `891cd49`。

本文同时承接 2026-11-19 已验收的 A1–A3 修复证据。C0 前新增修复与验收结果见 [PRE_C0_BACKEND_PLAN.md](PRE_C0_BACKEND_PLAN.md)；旧计划/审查文件已退役，其阶段事实不代表本次新增问题已解决。

## 检索对照

基线为 R3 提交 `7e0b4fb`；候选为同提交基础上的 R4。基线通过 `git archive` 在临时目录展开，复制同一基准脚本，复用同一 Node 依赖；两个版本分别启动独立 Node 进程，不启动 Web 或模型。机器为 Intel Core i7-14650HX，Linux x64，Node v24.18.0。数据全部合成且写入新建内存库：3,000 Entry、18,000 Memory；每十条撤销一条，故有效来源 2,700 Entry / 16,200 Memory。比较单大桶与 100 桶两种分布。

每个场景预热一次，测量九次；计时覆盖 MemoryQueryService 的候选读取、过滤、评分、排序、top-k 和结果投影。对照包含零命中、宽匹配、Unicode、仅撤销来源命中以及状态加 metadata 筛选。所有场景的完整响应 SHA-256 相同（包括顺序、分数、证据与回答），原始数据见 [JSON](BACKEND_REPAIR_BENCHMARK.json)。这证明这批样本等价，不能代替所有输入的语义证明。

| 分布 | 场景 | 返回数 | 同步中位 ms（前 → 后） | setImmediate 等待中位 ms（前 → 后） | 同步最大 ms（前 → 后） |
|---|---|---|---|---|---|
| 单桶 | miss | 0 | 468.1 → 91.0 | 468.2 → 91.1 | 484.5 → 105.1 |
| 单桶 | wide | 12 | 469.4 → 102.3 | 470.0 → 102.3 | 513.4 → 104.0 |
| 单桶 | unicode | 12 | 457.4 → 84.0 | 458.0 → 84.0 | 500.0 → 87.3 |
| 单桶 | revoked-only | 0 | 469.1 → 82.8 | 469.1 → 82.9 | 484.0 → 91.5 |
| 单桶 | filtered | 12 | 463.9 → 76.7 | 464.2 → 77.0 | 527.4 → 83.2 |
| 100 桶 | miss | 0 | 105.6 → 89.9 | 105.8 → 90.3 | 111.0 → 116.6 |
| 100 桶 | wide | 12 | 141.0 → 109.3 | 141.4 → 109.3 | 157.4 → 118.1 |
| 100 桶 | unicode | 12 | 105.8 → 87.0 | 105.9 → 87.1 | 106.5 → 105.3 |
| 100 桶 | revoked-only | 0 | 103.7 → 84.1 | 104.6 → 84.1 | 105.7 → 90.2 |
| 100 桶 | filtered | 12 | 105.9 → 71.4 | 106.0 → 71.5 | 124.1 → 74.0 |

`setImmediate` 在同步查询前注册，完成时间包含本次同步查询及调度开销，反映这一回合事件循环至少等待多久；它不是生产 p99，也不是整段运行的事件循环直方图。上表的同步最大值只是九次样本的最大值。

进程峰值 RSS（包含造数、预热、全部场景和 GC 行为）单桶为 **303,872 → 396,452 KiB**，100 桶为 **293,064 → 390,596 KiB**。批量关联减少 CPU 消耗，但本次进程的峰值内存更高，不能宣称全面降低资源占用；这些数字不是单次检索的净分配量。

复现候选：

```bash
node scripts/benchmark-memory-read.ts single
node scripts/benchmark-memory-read.ts multiple
```

脚本只创建内存库，不接受用户数据库路径；普通测试链不运行性能计时。比较基线时，把相同脚本复制进 `git archive 7e0b4fb` 的临时目录，安装/链接相同依赖后运行上述命令。

## 成本与匹配边界

Entry 候选读取现在为五条批量 SELECT（无词项时四条），不随 Bucket 数增加。一次按 entryId 建立 Memory 分组，取消逐 Entry 的整桶 filter，关联工作由近似 E×M 降为 E+M；Bucket 文本只折叠一次。命中后再构造公共 Entry/Memory 结果；仍会读取有效来源 Memory 的所有查询字段，不提前 LIMIT 丢弃全局 top-k。

原 SQL LIKE 与 Unicode casefold 扫描均保留。SQL 可匹配 metadata 的原始 JSON 格式，而折叠语料使用重新序列化后的 JSON；删除 SQL 会改变旧候选合同。字面量 `% _ /`、Straße、希腊 sigma、土耳其字母、跨字段词项和 SQL 独有 metadata 格式均有回归。

剩余成本包括一次全量有效 Entry/Memory 读取、Unicode 文本扫描、SQL LIKE 的匹配及结果排序。SQLite 和字符串处理仍同步阻塞事件循环。零命中也约 90ms，不能称为有界索引检索；本地大型语料/多请求并发需要下一次独立设计可重建搜索索引或 worker 隔离。旧的 Bucket 级兼容搜索仍逐桶读取完整详情，未把本轮 Entry 检索数据当成它的性能证明。

## 状态投影与恢复

| 入口 | 正常工作与恢复合同 |
|---|---|
| 批准 / 拒绝 / 启动 / Agent 完成 | 沿用同事务更新审批、Agent 与关联 WorkItem。 |
| 排队取消 / queue 失败或取消 | queue 终态、Agent 失败/取消、审批终结、WorkItem 投影同事务提交；失败一起回滚。只处理当前 queueId。 |
| queue 成功但 Agent 未完成 | 新写入当场拒绝并回滚 queue；遗留不可能状态使启动和后续入队失败，不推断成功结果。 |
| 启动取得执行所有权 | 所有权、running → interrupted、Agent 与 WorkItem 恢复在一次事务内。queued 保持待执行；不重新运行 interrupted CLI。 |
| 入队 pruning 前 | 保留一次显式异常 Agent 恢复并投影关联目标，避免队列淘汰后失去失败证据；入队失败也回滚恢复。 |
| 显式 AgentStore.reconcile | 维护/测试入口，一次事务完成 Agent 恢复与落后 WorkItem 投影；重复调用无重复事件。 |
| Agent / WorkItem GET | 仅查询已提交投影；不恢复、不为轮询启动写事务。 |
| Agent 成功已提交、queue 未终结时崩溃 | 保留 Agent 成功和已提交证据，queue 重启后为 interrupted；目标仍等待用户验收。两个提交不是跨阶段原子事务。 |

旧版四个 HTTP GET（Agent/WorkItem 列表和详情）开启 **10 次 BEGIN**；同一回归在修复后为 **0**，业务快照不变。故障覆盖：排队/运行取消、目标取消意图、启动中断、孤立 queue 引用、队列淘汰 200 条后引用清空、审批/目标投影失败回滚、不可能成功、成功后 queue 间隙、恢复幂等和执行器所有权回滚。测试用 fake runner 与临时库。

部分旧测试曾借正常 `queue.finish` 制造“不同步”的旧状态；新实现会当场同步或拒绝，因此改用临时库 SQL 明确注入遗留漂移。保留原来的防复用、恢复、脱敏和失败断言，并增加对新原子写入的断言。


## R5 交接与完整门禁

| 阶段 | 已提交的交付 |
|---|---|
| R0 | R1/R2 固定 F1–F4 复现；R4 固定 GET 副作用回归与可复现检索基准。回归先证明失败，再随修复通过。 |
| R1 `5fab9b2` | 保护 COMMIT 与失败清理、隔离故障连接；完整标题查询；模型历史先筛选再限量及上界。 |
| R2 `4689219` / `80c0864` | ChatService 抽取与有界 FIFO；直接/后台/确认共享轮次；source_message_id 关联，终结消息原子提交。 |
| R3 `7e0b4fb` | ConversationStore / MemoryReadStore，中立 MemoryTools / 投影，HTTP SSE 编码，应用层目标文案和传递依赖门禁。 |
| R4 `891cd49` | 批量检索与对照报告；正常终态同步投影，启动/pruning 恢复，GET 无写事务及完整故障回归。 |
| R5 | 本文、修缮计划、总路线图、主对话计划及测试/不变量更新，交接下一产品阶段。 |

最后运行 `npm run check`：Prettier、TypeScript、OpenAPI/浏览器 schema 漂移、**471 项后端 + 60 项前端测试全部通过，0 失败/跳过**。`git diff --check` 通过。普通测试和基准使用 fake model/runner、临时或内存 SQLite，没有真实模型调用、凭据读取或真实用户数据库操作。新增 schema 迁移为零；现有 schema 仍为 v8。HTTP/DTO/SSE、MCP allow-list 与浏览器合同保留。

主要回归位置：

- `src/storage/transactions.test.ts`、`src/runtime/local-web.test.ts`：COMMIT/ROLLBACK 失败、连接隔离及 shutdown drain。
- `src/storage/store.test.ts`、`src/storage/work-items.test.ts`：过滤后历史窗口、上界、完整标题、固定批量查询及目标投影/取消/恢复。
- `src/application/chat.test.ts`、`src/runtime/local-web.test.ts`：并发、确认等待、等待取消、直接与后台交错、消息组回滚和撤销晚结果。
- `tests/architecture/backend-dependencies.test.ts`：受改聊天/记忆/队列/Harness 路径的传递依赖，包括 type imports。
- `src/agent/control.test.ts`：真实 HTTP GET 无写事务、原批准/会话安全、遗留漂移、恢复拒绝不可能成功。
- 既有 HTTP/MCP/browser/runtime 回归持续覆盖响应形状、安全请求头、SSE、背压和断连取消。

## A1–A3：2026-11-19 后续修复验收

这三项均在独立提交中实施，并各自保留缺陷复现与相关回归。本节只记录 A1–A3 的签收；B1/B2 后续验收与待推进的 D1/D2 见 [C0 前计划](PRE_C0_BACKEND_PLAN.md)。

| 项目 | 提交 | 已交付语义 | 验收记录 |
|---|---|---|---|
| A1 WorkItem/Attempt 历史摘要 | `0dcce2d` | 修改范围、完成或取消时，pending 提案拒绝、WorkItem 最近历史尝试摘要和事件在同一事务更新；旧 scope 的晚状态不改变当前生命周期；显式恢复只修正摘要，不重复事件。 | 14 项新增回归；阶段定向 55 项；完整门禁 485 后端 + 60 前端。覆盖拒绝投影和事件回滚、旧 scope 恢复、重开、非最新晚投影及 sequence 顺序。 |
| A2 LLM response body 字节上限 | `8652db8` | Fetch transport 按接收 body 的实际字节限制成功响应为 1 MiB；超限取消读取并以不可重试错误结束；caller/process abort、timeout、非 2xx 脱敏及清理行为保持。 | 阶段定向 76 项；完整门禁 512 后端 + 60 前端。覆盖分块、缺失/错误 Content-Length、边界、取消、解析错误、两个 API mode 和 Harness 不执行超限工具。限的是累计保留/解析体，不是进程 RSS 或可抢占解析 deadline。 |
| A3 归档投影按 Entry 窄查询 | `8b7c2d6` | 归档执行/确认与历史卡片仅读取当前 Entry 的有效 Memory ID；按 Entry 与 Bucket 双绑定并保持原排序；历史卡片只读取 Bucket 元数据。 | 阶段定向 69 项；完整门禁 514 后端 + 60 前端。覆盖空/多项顺序、绑定错误、移动、撤销、删除、确认与历史卡片；查询计划使用现有 `ix_memory_items_entry`。不代表搜索与 Bucket detail 已有索引或分页。 |

这三阶段不改变 schema、OpenAPI 或响应形状。当前 `npm run check` 在 `628256b` 之后再次通过 514 后端 + 60 前端；该结果是 B1/B2 实施前的基线，不可记为它们的验收。

## 剩余兼容门面和限制

本轮收窄变化原因，没有完成全库抽象化。以下保留项供后续实施参考：

| 保留项 | 实际边界与后续处理 |
|---|---|
| Store | 仍承担归档、确认、撤销、TODO 等原子写入，并为旧调用委派 conversation/memory 方法；公共行类型仍在 store.ts，部分窄模块通过 type import 引用。不是两套存储实现。 |
| ChatService | 构造仍接收 Store 和 ArchiveRuntime；内部聊天持久化改用 ConversationStore。归档和来源校验仍经窄 Pick 及旧运行时，暂不为已有事务增加通用 repository/unit-of-work。 |
| 应用投影 | archive-view/memory-view 保留原 wire 字段以兼容；HTTP contracts 显式委派。未来新产品 DTO 需独立演进，不把所有协议字段集中成万能 contracts。 |
| WorkItem/Agent/TaskStore | 共享同一个 SQLite 事务，同步投影仍由具体 store 协作；不是独立微服务。AgentService 和队列的执行回调是生产组装，不代表可任意并行运行 CLI。 |
| process.ts → mcp/main.ts | CLI 子进程使用实际 MCP 入口，是预期集成边界；不属于 Harness/聊天应用依赖 MCP adapter 的旧问题。 |
| TODO | 原状态校验与原子写入仍在原模块，本次没有借拆分改变 T14 行为，也未完成所有 TODO 规则搬移。 |
| 旧 Bucket 搜索 | 仍逐桶读取详情；本轮性能结论只针对 Entry 级 MemoryQueryService，不能外推。 |
| 跨进程聊天与幂等 | 轮次 FIFO 只约束单 Web 所有者；旧 /api/chat 无 durable requestId，网络重试不能保证恰好一次。 |
| 检索规模 | 有效语料仍线性读取，同步处理可阻塞，批量峰值 RSS 较高。后续索引/worker 需另做语义与迁移设计。 |
| 真实体验与模型质量 | 本轮未做真人自用验收或真实模型质量实验；fake 测试证明合同，不证明自然语言理解率。 |

## 下一阶段的明确起点

R0–R5 与 A1–A3 已通过验收；随后也完成了 [C0 前修缮](PRE_C0_BACKEND_PLAN.md#9-当前执行记录) 的 B0–B3，可进入 [主对话 C0–C4](MAIN_CONVERSATION_PLAN.md)。C0 在现有回归上增加多轮歧义样本；C1 直接复用 ChatService 增加用途判定，不重复抽取 HTTP；C2 才增加持久澄清、请求幂等、严格新接口和最小卡片；C3 接已有来源和批准链；C4 对照验收后再切默认入口。

优先保留「统一入口、Bucket 主题记忆、WorkItem 目标、AgentSession 执行上下文」各自职责。下一阶段不以腾讯接入、向量库、框架迁移、多人、远程或视觉大改作为前置。真实数据升级或新的 schema 设计需要独立备份/恢复方案；本轮没有授权或执行真实库迁移。
