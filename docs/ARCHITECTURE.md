# 系统架构设计

> Rust 迁移状态（2026-08-05）：当前生产路径仍是本文件描述的 Python 单体；Rust 已具备确定性领域核心、严格 JSON 契约、九表强类型 SQLite 仓储与离线 migration/备份恢复安全层、隔离写事务及归档/纠错/聊天/删除/Bucket/Entry/摘要/提取/分类审计 API，并已在 `work-memory-service` 创建 Bucket 查询、关键词搜索、归档、纠错、基础变更、摘要缓存、独立提取保存和分类审计保存编排。R3c `ArchiveService` 只接收已验证分类/提取结果；R3d `CorrectionService` 已复现指定或最近 Entry 移动以及显式/命令文本目标选择；R3e `MemoryMutationService` 已把独立 Bucket 创建、Entry 追加和 Entry/Bucket 删除提升为不暴露 Store 的服务边界；R3f `BucketSummaryService` 已把独立滚动摘要更新和基于 Entry 的摘要重建提升为同类服务边界；R3g `ExtractionPersistenceService` 已把已验证提取结果的独立原子保存提升为稳定服务边界；R3h `ClassificationAuditService` 已把已验证分类结果和服务端元数据的独立审计保存提升为稳定服务边界。Rust LLM adapter、Agent、UI 和生产数据库仍未接入，生产运行时继续由 Python 独占写入。渐进切换边界和最终 Rust 架构见 [`RUST_MIGRATION.md`](./RUST_MIGRATION.md)，数据库运维边界见 [`SQLITE_MIGRATIONS.md`](./SQLITE_MIGRATIONS.md)。

## 1. 总体架构

MVP 使用可测试的单体服务架构：

```text
Streamlit UI
    ├─ agent_service ── llm.py ── Responses API / Chat Completions
    │      ├─ 对话历史 ───────────────────────────→ SQLite
    │      └─ 受控工具 ──→ search/bucket/archive services
    └─ archive_service
           ├─ classify_service ── llm.py
           ├─ extract_service  ── llm.py
           └─ bucket_service ─────────────────────→ SQLite

correction_service ──→ SQLite
search_service     ──→ SQLite
view_service       ──→ Streamlit 展示数据
```

普通 Python 函数足以表达当前流程，比提前引入复杂 Agent 框架更容易调试、测试和回滚。只有出现多角色协作、长流程状态机或复杂工具审批后，才需要考虑进一步编排。

当前的 `agent_service` 是一个单 Agent、显式工具注册的轻量 Harness，而不是多 Agent 框架。它持久化唯一对话的消息，每轮自动加载最多 8 个活跃 Bucket 的摘要概览，再把最近对话交给模型，并执行 `list/search/get/archive/confirmed save` 等受控工具。模型没有任意本机代码执行权限。

## 2. 对话与默认记忆流程

```text
1. 保存用户消息
2. 读取最近 40 条 user/assistant 历史
3. 自动读取最近 8 个活跃 Bucket 的标题、摘要、标签和 ID
4. 模型直接回答，或主动读取更详细的 Bucket 记忆
5. 如果输入包含长期工作事实，模型默认调用归档工具
6. 归档仍经过分类、置信度门控、确认和事务保存
7. 保存工具审计记录与最终 assistant 回答
8. UI 同屏刷新主对话和独立 Bucket 侧边栏
```

“默认记忆”不等于“保存所有消息”。纯问题、问候和未确认的助手建议不会落库；实际项目状态、进展、证据、结论和 Todo 才进入 Bucket。这样既减少用户手工操作，也避免把聊天噪声当成长期事实。

## 3. 普通归档流程

```text
1. 校验用户输入
2. 读取活跃 Bucket，并把当前焦点排在候选首位
3. classify_service 请求严格的 ClassificationResult
4. 服务端验证模型引用的 Bucket ID
5. 应用置信度与多候选门控；无候选且模型给出有效 create_new 时允许启动首个 Bucket
6. 写 classification_records 审计
7. ask_user：停止，不创建正式 Entry
8. append/create：extract_service 请求 ExtractionResult
9. 同一事务创建或追加 Entry，并写 Todo/Evidence/Timeline/Decision
10. 更新标签、滚动摘要和最近活跃时间
11. 返回 ArchiveResult
```

`archive_service` 自己创建 Session 时负责提交、回滚和关闭；调用方传入 Session 时，最终事务控制权属于调用方。

Streamlit 不再维护第二套手工归档输入状态。归档需要确认时，Agent 会在同一对话中说明候选或建议的新 Bucket；用户下一条消息确认后，Harness 调用 `save_to_existing_bucket` 或 `create_bucket_and_save` 完成操作。空工作区中的有效工作事实仍可通过 `archive_memory` 自动创建首个 Bucket。

## 4. 服务职责

### `llm.py`

统一 OpenAI 配置与 Structured Outputs 调用，处理响应不完整、拒绝、Schema 校验失败和有限重试。业务服务不直接创建 OpenAI Client。

### `classify_service`

构造有限候选，输出 `append_existing`、`create_new` 或 `ask_user`，校验模型返回的引用并执行风险门控。每次结果写入 `classification_records`，用于校准和纠错分析。Rust R3h `ClassificationAuditService` 接收已验证 `ClassificationResult`、服务端候选、焦点、Prompt 版本和已解析模型名，在服务内部构造强类型 Store request，并只返回提交后的 `ClassificationAuditSaveResult`；分类、风险门控和模型配置仍留在服务外。

### `extract_service`

从单条原始输入提取 summary、todos、evidences、timeline events、decisions、hypotheses、entities 和 tags。当前持久化前五类结构和 tags；hypotheses、entities 暂只保留在返回结果中。Rust R3g `ExtractionPersistenceService` 接收已通过核心层验证的 `ExtractionResult` 和精确 Bucket/Entry ID，在服务内部构造强类型 Store request，并把提交结果投影为 `ExtractionSaveResult`；模型调用和 JSON/Schema 校验仍留在服务外。

### `bucket_service`

负责 Bucket/Entry CRUD、结构化记录入库、精确去重、滚动摘要和详情查询。摘要可由 Entry 重新构建，不能代替原始事实。Rust R3a-R3b `BucketQueryService` 已在只读临时数据库复现活跃 Bucket 列表、精确 Bucket 查询、完整详情聚合和关键词搜索；R3e `MemoryMutationService` 在隔离可写数据库接入独立 Bucket 创建、Entry 追加、Entry 删除和 Bucket 聚合删除；R3f `BucketSummaryService` 接入独立滚动摘要更新与基于 Entry 的摘要重建；R3g `ExtractionPersistenceService` 接入四类结构化记录、Entry summary、Bucket 标签和滚动摘要的独立原子保存，并继续由 Store 保持事务与 Python 兼容去重语义。生产 Agent 与 UI 仍调用 Python。

### `archive_service`

Python 仍负责生产分类、提取、确认和 Session 生命周期。Rust R3c `ArchiveService` 已建立受控可写服务边界：裁剪并拒绝空输入，要求 append/create 携带 `ExtractionResult`，禁止 ask_user 携带提取结果，构造确认追加/确认新建分类审计，并把 `WritableSqliteStore::persist_archive_attempt` 的事务结果投影为核心 `ArchiveResult`。Bucket 标题和类型由同一写事务返回，避免服务层用未验证的调用方元数据伪造结果。当前 Rust 服务只在系统临时目录的隔离数据库运行；分类器、提取器和模型配置仍由未来 R4 adapter 提供，因此尚未替换完整生产 `archive_user_input`。

### `correction_service`

支持移动指定或最近 Entry，并同步移动其派生记录；写入 Correction 前后快照，重建两个 Bucket 的摘要，并把关联分类审计标记为已纠错。Rust R3d `CorrectionService` 持有经验证的 `WritableSqliteStore`：`move_entry` 接收显式 Entry/Bucket ID，`move_latest_entry` 在同一 `BEGIN IMMEDIATE` 事务中选择最新 Entry，并从显式 Bucket ID 或 Python MVP 支持的最终“移到/放到”命令片段解析目标。标题查询保持 SQLAlchemy `contains(..., autoescape=True)` 的字面匹配、精确标题优先和唯一模糊候选规则；空命令、无法识别、无匹配、多匹配、同 Bucket 和缺失记录均拒绝且不留下部分写入。当前 Agent 和 UI 仍调用 Python 服务。

### `agent_service` 的聊天持久化边界

Python 当前仍通过 `add_chat_message` 分别提交 user、tool 和 assistant 消息。Rust `ChatMessageWriteRequest` 与 `WritableSqliteStore::append_chat_message` 已在隔离临时数据库复现单条消息的角色、内容、工具元数据、details、UUID、时间顺序和失败回滚语义，但尚未接入 Agent Harness，也不提供完整 turn 的跨消息事务。

### `search_service` 与 `view_service`

搜索服务使用 SQLite 关键词匹配标题、摘要、标签和 Entry 原文。Rust R3b 复现 SQLAlchemy `contains(..., autoescape=True)` 候选窗口、Unicode casefold 评分、匹配 Entry 计数、稳定相关度/活跃时间排序和最终 limit；仍保留当前 JSON 标签以序列化文本参与 SQL 候选匹配的既有语义。展示服务将 ORM/Pydantic 对象转换为稳定的 UI 数据结构，避免业务逻辑散落在 Streamlit 回调中。

## 5. 当前焦点与候选范围

当前焦点来自统一 UI 侧边栏选中的 Bucket，并随每轮对话传给 Harness。Agent 默认上下文加载最多 8 个活跃 Bucket；真正进入归档分类时，分类服务仍使用当前焦点和最近活跃的有限候选，默认上限为 20。这样既减少 Token 消耗，也避免把完整历史暴露给每次调用；更旧内容通过搜索按需找回。

## 6. 风险门控

```text
confidence >= 0.85 且候选唯一 → 自动归档
0.55 <= confidence < 0.85       → 用户确认
confidence < 0.55               → 用户确认
多个相似候选                    → 用户确认
```

阈值来自 `.env`，只是保守初值。`confidence` 是模型主观信号，不是正确概率；必须用固定标注集、实际纠错和高错误代价案例持续校准。低置信度输入可写分类审计，但不得在确认前污染正式 Bucket。

## 7. 事务与错误处理

- OpenAI 配置或调用失败：明确报错，不伪造归档结果。
- 输出不符合 Schema：有限重试后失败。
- Bucket ID 无效：降级为确认，不进入持久化流程。
- 数据库任一步失败：自动归档事务整体回滚。
- 用户确认后：通过独立确认入口重新提取并保存。
- Rust R2h `delete_bucket` 仅在隔离数据库提供模型级 Bucket 聚合删除：依赖现有外键删除 Bucket 自有聚合、清空跨 Bucket 子记录和分类审计的 Entry 外键，并在任一步失败时整体回滚；当前产品没有对应的 Python 删除服务，生产路径尚未调用该 API。
- Rust R2i `delete_entry` 同样只在隔离数据库提供模型级独立 Entry 删除：Bucket、结构化记录和审计记录保留，所有相关 `entry_id` 清空，Todo 刷新 `updated_at`，Bucket 摘要与活跃时间不自动重建；该行为匹配直接 SQLAlchemy 模型删除，而非尚不存在的产品服务。
- Rust R2j `create_bucket` 在隔离数据库提供产品级独立 Bucket 创建：校验并规范化标题、摘要和标签，只创建 active Bucket，不附带 Entry、结构化记录或分类审计；事务失败不留下部分状态，行为与 Python `create_bucket` 服务等价。
- Rust R2k `append_entry` 在隔离数据库提供产品级独立 Entry 追加：校验输入并保留精确 Bucket ID，只新增原始 Entry、刷新 Bucket 更新时间和活跃时间，不运行提取、不改变摘要/标签，也不写分类审计；晚期 Bucket 更新失败会回滚 Entry。
- Rust R2l `update_bucket_summary` 在隔离数据库提供产品级独立滚动摘要更新：校验并裁剪摘要片段，以 Unicode casefold/空白规范化去重，保留首段和最新事实并按 Python 字符数限制为最多 1200 字符（或调用方提供的至少 100 字符上限）；只修改 Bucket `summary` 与 `updated_at`，失败时事务回滚。
- Rust R2m `rebuild_bucket_summary` 在隔离数据库提供产品级独立摘要重建：从按时间倒序选出的最新 Entry summary 窗口中清理空片段，再恢复时间顺序并按清理后的精确文本去重；默认最多八条、1200 字符，只更新 Bucket `summary` 与 `updated_at`，并与纠错移动共用同一实现。
- Rust R2n `save_extraction` 在隔离数据库提供产品级独立提取保存：先按精确 ID 验证 Bucket 与 Entry 归属，再原子写入按调用前已有记录去重的四类结构化记录、Entry summary、合并标签和 1200 字符滚动摘要；不刷新 Bucket `last_active_at`，并与归档聚合写路径共用子记录和缓存更新实现。
- Rust R2o `save_classification_record` 在隔离数据库提供产品级独立分类审计保存：只裁剪原始输入首尾空白，按“服务端候选在前、模型候选在后”做大小写敏感的精确保序去重，并保留已解析的焦点、Prompt 与模型元数据；单事务只新增一条 `classification_records`，不校验审计中的 Bucket ID 是否存在，也不修改 Bucket、Entry 或其他业务表。
- Rust R3a `BucketQueryService` 在 `work-memory-service` 提供首个产品级只读编排：复用受 Schema 校验和 query-only 保护的 `SqliteStore`，保持活跃列表排序/limit、精确主键查询和 Entry/Todo/Evidence/Timeline/Decision 详情关系顺序；缺失 Bucket 返回 `None`。
- Rust R3b 在同一服务增加 `search_buckets`：保持查询 trim/空值校验、正数 limit、`max(limit * 5, 50)` SQL 候选窗口、LIKE 通配符字面转义、Unicode casefold 评分、最多十条匹配 Entry 加分、稳定降序排序和紧凑结果投影；当前同样尚未接入生产调用链。
- Rust R3c `ArchiveService` 持有经验证的 `WritableSqliteStore`，不暴露可写连接或任意事务闭包；`archive_classified_input` 对已验证分类/提取结果执行 action/extraction 一致性校验，确认追加与确认新建入口复现 Python 的候选、焦点、`classification-v2` 和结果字段语义。ask_user 只提交分类审计，缺失 Bucket 或晚期数据库错误由 Store 事务整体回滚。R4 完成前，分类/提取调用仍不属于该服务，生产路径也未切换。
- Rust R3d `CorrectionService` 同样不暴露可写连接；显式 Entry 移动和“移动最近 Entry”都投影为稳定的 `CorrectionResult`。最近 Entry 选择、可选标题解析、聚合移动、摘要重建、审计修正和 Correction 快照写入在同一 Store 事务内完成，避免“最近一条”在读写间发生漂移；目前仍未接入 Agent/UI。
- Rust R3e `MemoryMutationService` 把 R2h-R2k 的独立 Bucket/Entry 基础写能力组合为稳定服务边界；服务直接接收产品参数并在内部构造强类型 Store request，返回权威 `StoredBucket`、`StoredEntry` 或删除影响 ID，不暴露 `WritableSqliteStore`、SQL 或事务闭包。创建/追加保持 Python 文本、标签、可选字段和置信度语义，删除保持外键级联/SET NULL 与 Todo 时间更新语义；缺失或非法请求不留下部分修改，目前仍未接入 Agent/UI。
- Rust R3f `BucketSummaryService` 把 R2l-R2m 的独立摘要缓存写能力组合为稳定服务边界；默认入口保持 1200 字符和八条 Entry 的 Python 默认值，显式入口保留自定义限制，服务内部构造强类型 request 并只返回提交后的摘要文本。更新/重建都只修改 Bucket `summary` 与 `updated_at`，不刷新 `last_active_at`，非法限制、空片段或缺失 Bucket 不留下部分修改，目前仍未接入 Agent/UI。
- Rust R3g `ExtractionPersistenceService` 把 R2n 的独立提取保存提升为稳定服务边界；服务接收精确 Bucket/Entry ID 和已验证 `ExtractionResult`，不暴露 Store request、连接或事务闭包，并返回包含四类新建记录 ID 的 `ExtractionSaveResult`。目标验证、子记录去重、Entry/Bucket 缓存更新和失败回滚继续由单一 Store 事务负责，目前仍未接入提取模型、Agent/UI 或生产数据库。
- Rust R3h `ClassificationAuditService` 把 R2o 的独立分类审计保存提升为稳定服务边界；服务接收已验证 `ClassificationResult` 及服务端候选、焦点、Prompt 和模型元数据，不暴露 Store request/outcome、连接或事务闭包，并返回新审计 UUID 的 `ClassificationAuditSaveResult`。原始输入 trim、空审计文本、精确元数据、候选合并、三类 action 和失败回滚继续由 Store 保持 Python 语义；分类与风险门控、Prompt 选择和模型名解析仍在服务外，目前未接入 Agent/UI 或生产数据库。

MVP 不自动创建 `inbox` 兜底，因为它会把“不确定”误解为“已归档”。

## 8. 可观测性与评估

当前持久化分类动作、分数、原因、候选、焦点、Prompt 版本、模型名和纠错状态。固定 50 条标注集负责计算分类准确率、自动归档准确率、询问召回率与严重误合并数。真实模型评估使用独立命令，普通 Pytest 全部 mock LLM。

后续可增加调用耗时、Token、成本、搜索 query、摘要重建版本和用户确认选择等指标。
