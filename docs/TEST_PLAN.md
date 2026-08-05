# 测试与验收计划

## 1. 测试目标

MVP 的测试重点不是覆盖所有代码，而是验证核心闭环稳定：

```text
单会话输入 → 直接回答或工具调用 → 记忆读取/写入 → 历史展示
归档输入 → 分类 → 提取 → 保存 → 展示 → 纠错 → 搜索
```

## 2. 测试类型

### 2.1 单元测试

覆盖：

- 数据库 CRUD。
- bucket_service。
- search_service。
- correction_service 的规则部分。
- schema 校验。
- Agent 工具参数解析、工具白名单和历史消息装配。
- Rust `work-memory-core` 的领域校验、候选排序和风险门控。
- Rust `work-memory-store` 的九表必需表/列校验，以及非法 Bucket/Todo/分类/Chat 枚举、JSON 语法与类型、SQLite bool、时间戳和 limit 错误。
- Rust migration history 的版本、名称、连续性和主键校验，以及备份路径互斥与不覆盖规则。
- Rust 强类型归档写请求的字段组合、候选合并、Unicode casefold 去重和 1200 字符滚动摘要规则。
- Rust Entry 移动请求的命令规范化、同 Bucket 类型化拒绝，以及摘要 Unicode 字符截断。
- Rust ChatMessage 写请求的内容裁剪、空值拒绝、JSON null 规范化和 scalar details 拒绝。
- Rust Bucket 与 Entry 删除请求保留精确 ID，缺失目标使用类型化错误且不会产生业务修改。
- Rust Bucket 滚动摘要更新请求的摘要裁剪、至少 100 字符上限、默认 1200 字符上限、精确 Bucket ID 和 Python 兼容校验顺序。
- Rust Bucket 摘要重建请求的默认/自定义 Entry 与字符上限、`max_entries` 提前拒绝、精确 Bucket ID，以及 Python 当前未校验非正 `max_chars` 的切片/省略号语义。
- Rust 独立提取保存请求保留精确 Bucket/Entry ID 和已验证 `ExtractionResult`，并按 Bucket 优先、Entry 归属随后检查的 Python 校验顺序拒绝无效目标。

### 2.2 集成测试

覆盖：

- archive_user_input 完整流程。
- LLM mock 后的分类和提取。
- 创建 bucket + entry + structured records。
- Responses API 与 Chat Completions 的多轮工具调用。
- 单一对话在多次请求之间的上下文复用。
- Python SQLAlchemy 在临时路径创建完整九表数据库后，由 Rust 强类型只读验证全部记录字段、可选值、枚举、JSON、布尔值、时间格式、Bucket 子记录顺序和最近聊天窗口顺序。
- Python SQLAlchemy 九表数据库到 Rust version 1 的升级、重复升级、已提交 WAL 数据备份、完整业务数据不变性、legacy 恢复、safety backup 和反向恢复。
- 缺索引、外键损坏、未来 migration 版本、错误 migration 主键、已有备份文件和无效恢复源必须在修改目标前被拒绝。所有数据库和备份仅使用系统临时目录，不接触仓库根目录的 `work_memory.db`。
- Rust 可写 store 只打开完整受支持的已有 Schema，强制 `foreign_keys`，并在隔离临时数据库验证成功 commit、外键错误后的完整 rollback，以及打开后 Schema 漂移拒绝。
- Rust `persist_archive_attempt` 在临时 Python Schema 上覆盖 append/create/ask_user、缺失 Bucket、决策写入中途失败全事务 rollback；固定 Python helper 与 Rust 对同一 confirmed append 比较忽略随机 ID/时间后的 Bucket、Entry、子记录和分类审计最终语义。
- Rust `move_entry` 在临时 Python Schema 上覆盖 Entry 与四类子记录移动、Correction 快照、关联分类纠错标记、双 Bucket 活跃时间与摘要重建、缺失记录、同 Bucket 拒绝和晚期触发器全事务 rollback；固定 Python helper 与 Rust 比较忽略随机 Correction UUID/实际时间后的最终业务语义。
- Rust `append_chat_message` 在临时 Python Schema 上覆盖 user/assistant/tool、内容裁剪、工具元数据与 details、UUID、单行影响、连续追加顺序和触发器失败全事务 rollback；固定 Python helper 与 Rust 比较忽略随机 ID/实际时间后的最终消息语义。
- Rust `delete_bucket` 在临时 Python Schema 上覆盖 Bucket/Entry/自有结构化记录级联、ClassificationRecord Entry 外键清空、跨 Bucket 结构化记录存活、Todo `updated_at` 刷新、缺失目标无修改和触发器失败全事务 rollback；由于没有产品级 Python 删除服务，固定 helper 直接执行 SQLAlchemy 模型删除，并对比除运行时时间外的最终业务状态。
- Rust `delete_entry` 在临时 Python Schema 上覆盖仅删除 Entry、同/跨 Bucket 结构化记录与审计保留、全部 Entry 外键清空、Todo `updated_at` 刷新、Bucket 缓存不变、精确/缺失 ID 和晚期失败全事务 rollback；固定 helper 直接执行 SQLAlchemy Entry 模型删除并比较最终业务状态。
- Rust `create_bucket` 在临时 Python Schema 上覆盖标题/摘要/标签规范化、active 默认值、UUID、单 Bucket 行影响、无关联记录副作用和插入失败全事务 rollback；固定 helper 调用 Python `create_bucket` 并比较忽略随机 ID/运行时时间后的服务级最终语义。
- Rust `append_entry` 在临时 Python Schema 上覆盖 raw text/content type/可选字段规范化、置信度、UUID、单 Entry 行影响、Bucket 活跃时间刷新、精确/缺失 Bucket ID 和晚期失败全事务 rollback；固定 helper 调用 Python `append_entry` 并比较服务级最终语义。当前写测试不代表业务写路径已切换。
- Rust `update_bucket_summary` 在临时 Python Schema 上覆盖 Unicode casefold/空白去重、默认与自定义字符上限、只更新 Bucket summary/`updated_at`、不刷新 `last_active_at`、精确/缺失 Bucket ID 和触发器失败全事务 rollback；固定 helper 调用 Python `update_bucket_summary` 并比较忽略运行时时间后的服务级最终语义。当前写测试不代表业务写路径已切换。
- Rust `rebuild_bucket_summary` 在临时 Python Schema 上覆盖最新非 NULL summary 窗口、limit 后空白过滤、时间正序恢复、清理后精确区分大小写去重、空结果清除缓存、非正字符上限、只更新 Bucket summary/`updated_at`、精确/缺失 Bucket ID 和触发器失败全事务 rollback；固定 helper 调用 Python `rebuild_bucket_summary` 并比较忽略运行时时间后的服务级最终语义。当前写测试不代表业务写路径已切换。
- Rust `save_extraction` 在临时 Python Schema 上覆盖 Bucket/Entry 归属校验顺序、事务前既有记录去重、批内规范化重复保留、四类结构化默认值与 UUID、Entry summary、Bucket 标签/滚动摘要、`last_active_at` 与审计隔离、重复调用和晚期失败全事务 rollback；固定 helper 调用 Python `save_extraction` 并比较忽略随机 ID/运行时时间后的服务级最终语义。当前写测试不代表业务写路径已切换。
- Rust `save_classification_record` 在临时 Python Schema 上覆盖原始输入裁剪与空值保留、服务端元数据精确保留、服务端/模型候选精确保序去重、三种 action、缺失审计目标、UUID 与默认字段、重复审计、单表影响和插入失败全事务 rollback；固定 helper 调用 Python `save_classification_record` 并比较忽略随机 ID/运行时时间后的服务级最终语义。当前写测试不代表业务写路径已切换。
- Rust `BucketQueryService` 在 Python 创建的临时九表数据库上覆盖 active 列表排序与 limit、精确/缺失 Bucket 查询、Entry/Todo/Evidence/TimelineEvent/Decision 完整详情和关系顺序；固定 helper 调用 Python `list_active_buckets`、`get_bucket`、`get_bucket_detail` 并逐字段比较完整 JSON。当前只读服务测试不代表 Agent、UI 或生产查询路径已切换。
- Rust `search_buckets` 在 Python 创建的临时九表数据库上覆盖查询 trim/空值、正数 limit、标题/摘要/JSON 标签/Entry 候选、LIKE `%`/`_`/`/` 字面转义、Unicode casefold 精确与包含评分、匹配 Entry 计数、稳定 score/活跃时间排序和最终截断；固定 helper 调用 Python `search_buckets` 并逐字段比较完整结果。当前只读搜索测试不代表 Agent、UI 或生产查询路径已切换。
- Rust `MemoryMutationService` 在 Python 创建的隔离九表数据库上覆盖独立 Bucket 创建、Entry 追加、Entry 删除和 Bucket 聚合删除；验证服务参数规范化、UUID/权威返回字段、删除影响 ID、缺失/非法请求无部分修改，以及 `apply_memory_mutation_service_fixture.py`、`export_memory_mutation_service_fixture.py` 驱动的 Python/Rust 返回投影和最终数据库语义等价。当前服务测试不代表 Agent、UI 或生产写路径已切换。
- Rust `BucketSummaryService` 在 Python 创建的隔离九表数据库上覆盖滚动摘要更新与基于 Entry 的摘要重建；验证默认/显式限制接线、返回摘要、去重/窗口/顺序语义、只更新 `summary`/`updated_at`、不刷新 `last_active_at`、缺失/非法请求无部分修改，以及 `apply_bucket_summary_service_fixture.py`、`export_bucket_summary_service_fixture.py` 驱动的 Python/Rust 返回值和九表最终语义等价。当前服务测试不代表 Agent、UI 或生产写路径已切换。
- Rust `ExtractionPersistenceService` 在 Python 创建的隔离九表数据库上覆盖首次、重复和最小提取保存；验证稳定 `ExtractionSaveResult` 计数与 UUID v4、四类结构化记录去重、Entry summary、Bucket tags/滚动摘要、`last_active_at` 隔离、精确/缺失/归属错误目标无部分修改，以及 `apply_extraction_persistence_service_fixture.py`、`export_extraction_persistence_service_fixture.py` 驱动的 Python/Rust 结果和九表最终语义等价。测试不调用真实模型，也不代表 Agent、UI 或生产写路径已切换。
- Rust `ClassificationAuditService` 在 Python 创建的隔离九表数据库上覆盖重复 append、空文本 create_new、带建议 Bucket 的 ask_user 和插入失败；验证稳定 `ClassificationAuditSaveResult` UUID v4、输入 trim、精确服务端元数据、候选精确保序合并、全部 action、重复审计、单表影响和无部分修改，以及 `apply_classification_audit_service_fixture.py`、`export_classification_audit_service_fixture.py` 驱动的 Python/Rust 结果和九表最终语义等价。测试不调用真实模型，也不代表 Agent、UI 或生产写路径已切换。
- Rust `ChatMessagePersistenceService` 在 Python 创建的隔离九表数据库上覆盖重复 user、tool、assistant、JSON null、非法输入和插入失败；验证稳定 `ChatMessageSaveResult` UUID v4、内容裁剪、返回工具字符串裁剪与数据库精确保留、object/array/null details、严格递增时间顺序、单表影响和无部分修改，以及 `apply_chat_message_service_fixture.py`、`export_chat_message_service_fixture.py` 驱动的 Python/Rust 结果和九表最终语义等价。测试不调用真实模型，也不代表 Agent、UI 或生产写路径已切换。

### 2.3 手动测试

使用 `tests/fixtures/sample_inputs.md` 逐条输入。

## 3. 样例场景

### 场景 0：单会话回答与工具调用

先输入：

```text
我在排查支付回调 502，先帮我分析可能原因和检查顺序。
```

期望：

- 助手直接给出问题分析和可执行步骤。
- 因为输入包含正在发生的故障状态，模型同时主动调用归档工具。
- `chat_messages` 保存 user、tool 和 assistant 消息。

单独输入一个没有新增工作事实的问题：

```text
Python 的上下文管理器是什么？
```

期望：

- 助手正常回答。
- 不调用写入工具，不创建无意义 Bucket。

继续输入：

```text
查一下之前支付问题的记录，再结合历史告诉我下一步。
```

期望：

- 模型调用 `search_memory`，必要时继续调用 `get_bucket_detail`。
- 工具调用及结果作为 tool 消息保存并在 UI 中可展开查看。
- 最终回答结合本轮问题与已持久化的上一轮上下文。

再输入：

```text
请记住：支付回调问题已定位为第三方证书过期。
```

期望：

- 模型调用受控写入工具，而不是声称已保存但不执行。
- 写入仍经过现有 Bucket 分类、提取和事务逻辑。

### 场景 1：Incident 新建与追加

输入：

```text
支付回调从 10:20 开始大量失败，日志里第三方返回 502，影响订单确认。
```

期望：

- 创建 bucket。
- type = incident。
- evidence 包含第三方 502。
- timeline 包含 10:20。

继续输入：

```text
刚才那个支付问题，10:40 切到备用通道后恢复了，后面要补复盘。
```

期望：

- append_existing。
- bucket 仍是同一个。
- todo 包含补复盘。
- decision/处置包含切备用通道。

### 场景 2：Experiment 新建与追加

输入：

```text
今天压测接口 A，QPS 到 1200 后 P99 延迟升到 2.3s，CPU 85%。
```

期望：

- 创建 experiment。
- evidence 包含 QPS、P99、CPU。

继续输入：

```text
把连接池从 50 调到 100 后，P99 降到了 1.4s。
```

期望：

- 追加到接口 A 压测 bucket。
- evidence 包含参数调整和结果变化。

### 场景 3：Meeting

输入：

```text
下午和设计同学讨论了首页改版，结论是先保留搜索入口，卡片布局下周再验证。
```

期望：

- type = meeting 或 decision。
- decision 包含保留搜索入口。
- todo 包含下周验证卡片布局。

### 场景 4：纠错

前置：最近一条被放入支付 bucket。

输入：

```text
刚才那条不要放到支付问题，放到接口稳定性问题里。
```

期望：

- 最近 entry 被移动。
- corrections 表新增记录。
- 两个 bucket 更新时间变化。

### 场景 5：搜索

输入：

```text
帮我找之前支付回调失败的问题。
```

期望：

- 返回支付回调相关 bucket。
- 显示摘要和最近更新时间。

## 4. 评估指标

### 分类评估集

维护不少于 50 条人工标注案例，目标逐步扩充到 100 条。案例必须固定输入、候选 Bucket、当前焦点、期望 action、期望 bucket_id、是否应询问和错误代价。不要让待评估的同一次 LLM 调用生成标准答案。

### 分类核心指标

分别统计：

```text
action 准确率
已有 Bucket 选择准确率
自动归档准确率
ask_user 覆盖率
严重误合并数量
```

MVP 目标：

- action 准确率 >= 85%。
- 已有 Bucket 选择准确率 >= 80%。
- 高置信度自动归档准确率 >= 90%。
- 标注集中的严重误合并为 0；出现时必须单独分析。

### 置信度校准

`confidence` 是 LLM 的主观信号，不直接等于正确概率。按 `<0.55`、`0.55-0.85`、`>=0.85` 分桶，统计每档实际正确率、询问率和纠错率。只有评估数据支持时才调整自动归档阈值。

### 结构化提取

分别检查 Summary 忠实性、Todo Precision/Recall、Evidence 事实准确性、Timeline 时间保持和严重编造。`tests/fixtures/extraction_cases.json` 保存人工定义的必需术语与禁止事实；`app.extraction_evaluation` 自动计算各字段术语召回，并标记禁止事实和原文不存在的数字。

自动检查不能判断改写后的语义、因果关系、否定表达、单位变化或无数字编造。每份真实报告仍需人工逐条回答：

1. Summary 是否只包含原文事实；
2. Todo 是否真的是未完成动作，是否有遗漏或误报；
3. Evidence 是否能直接在原文定位；
4. Decision 与 Hypothesis 是否被混淆；
5. 时间表达是否被错误确定化。

MVP 目标：

- 提取内容人工可用率 >= 80%。
- Evidence 严重编造为 0。
- Todo Precision >= 85%，Recall >= 70%。
- 固定必需事实术语召回率单独按字段报告，不合成为虚假的“总体置信度”。

### 纠错与搜索

- 最近 Entry 移动成功率 >= 95%。
- 10 条固定搜索 query 的目标 Bucket 召回率 >= 80%。

## 5. LLM 测试建议

LLM 输出不稳定，所以测试分两层：

1. mock LLM 输出，测试业务逻辑；
2. 少量真实 LLM 调用，测试 Prompt 和模型效果。

不要让普通单元测试依赖真实 API，否则测试慢且花钱。常用命令：

```bash
pytest -q
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
python -m app.evaluation --baseline
python -m app.live_evaluation \
  --limit 3 \
  --output /tmp/classification-live-report.json
python -m app.live_extraction_evaluation \
  --limit 3 \
  --reference-date 2026-08-03 \
  --output /tmp/extraction-live-report.json
```

`pytest`、Cargo 检查和规则基线不调用真实 API。两个 `live` 命令会使用 `.env` 中选定站点的 Base URL、Key、API 模式和模型，并可能产生费用。报告必须保存站点名、Base URL、API 模式、模型名、Prompt 版本、日期、案例路径、完整预测和指标。真实调用失败时，应保留错误原因，不能用 mock 或规则基线冒充真实模型结果。中转站需分别验证其是否支持 Responses API 或 Chat Completions Structured Outputs。

离线复算已有报告：

```bash
python -m app.evaluation /tmp/classification-live-report.json
python -m app.extraction_evaluation /tmp/extraction-live-report.json
```

## 6. 回归测试清单

自动化映射：

- `tests/test_llm.py`：Structured Outputs 封装和错误分支；
- `tests/test_agent_service.py`：单会话持久化、Responses/Chat Completions 工具循环、工具白名单和严格参数校验；
- `tests/test_contract_fixtures.py`：Python 对共享 JSON golden fixture 的规范化和拒绝行为；
- `tests/test_classify_service.py`、`tests/test_evaluation.py`：分类、门控和指标；
- `tests/test_live_evaluation.py`：真实分类运行器的版本化元数据和报告落盘；
- `tests/test_extraction_evaluation.py`、`tests/test_live_extraction_evaluation.py`：提取遗漏、编造风险提示和真实报告结构；
- `tests/test_archive_service.py`、`tests/test_extraction_and_bucket_memory.py`：事务归档和长期记忆；
- `tests/test_correction_service.py`：纠错移动和审计；
- `tests/test_search_and_view.py`、`tests/test_ui.py`：搜索、展示和 Streamlit；
- `tests/test_mvp_regression.py`：Incident、Experiment、Meeting、纠错和搜索串联回归。
- `rust/work-memory-core/tests/classification.rs`：Rust 分类契约、候选排序与风险门控回归；
- `rust/work-memory-contracts/tests/contract_fixtures.rs`：Rust 对同一共享 JSON golden fixture 的规范化和拒绝行为。
- `rust/work-memory-store/tests/store_validation.rs`：Rust SQLite 九表必需 Schema，以及损坏枚举、JSON、bool 和时间戳的错误分类。
- `rust/work-memory-store/tests/python_sqlite_compat.rs`：Python 九表建库到 Rust 强类型只读查询的跨语言兼容回归，覆盖字段、可选值、JSON、枚举和排序；数据库只允许位于系统临时目录。
- `rust/work-memory-store/tests/python_migration_compat.rs`：九表 Schema、legacy → version 1、幂等、业务数据不变性、恢复、safety backup 和损坏输入拒绝回归；所有路径只位于系统临时目录。
- `rust/work-memory-store/src/write.rs` 单元测试：可写连接保护、`BEGIN IMMEDIATE` 成功提交、外键失败全事务回滚、坏 Schema 和 Schema 版本漂移拒绝；fixture 只位于系统临时目录。
- `rust/work-memory-store/tests/archive_write.rs`：强类型 append/create/ask_user 归档、UUID/关系、Python 去重与摘要语义、缺失目标和触发器中途失败回滚，以及 `tests/fixtures/apply_archive_write_fixture.py` 驱动的 Python/Rust 最终业务状态等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/correction_write.rs`：强类型 Entry 移动、全子记录同步、Correction 快照、分类纠错标记、双 Bucket 摘要/活跃时间、事务内最近 Entry 选择、精确标题优先、无 Entry、缺失/同 Bucket 错误、晚期触发器回滚，以及 `tests/fixtures/apply_correction_write_fixture.py` 驱动的 Python/Rust 最终业务状态等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/chat_write.rs`：强类型 ChatMessage 追加、三种角色、字段规范化与保持、UUID、单行影响、连续追加顺序、触发器回滚，以及 `tests/fixtures/apply_chat_write_fixture.py` 驱动的 Python/Rust 最终消息语义等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/delete_write.rs`：受控 Bucket 聚合删除、影响 ID、跨 Bucket 引用的 SET NULL 与 Todo 更新时间、缺失目标、晚期失败回滚，以及 `tests/fixtures/apply_bucket_delete_fixture.py` 驱动的 SQLAlchemy/Rust 模型级最终状态等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/entry_delete_write.rs`：受控独立 Entry 删除、清空链接的影响 ID、同/跨 Bucket 子记录存活、Todo 更新时间、Bucket/审计保持、精确与缺失 ID、晚期失败回滚，以及 `tests/fixtures/apply_entry_delete_fixture.py` 驱动的 SQLAlchemy/Rust 模型级最终状态等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/bucket_create_write.rs`：强类型独立 Bucket 创建、Python 规范化、active 默认值、UUID、单行影响、无关联副作用、插入失败回滚，以及 `tests/fixtures/apply_bucket_create_fixture.py` 驱动的 Python/Rust 服务级最终语义等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/entry_append_write.rs`：强类型独立 Entry 追加、Python 可选字符串边界、置信度、UUID、Bucket 活跃时间、精确/缺失目标、晚期失败回滚，以及 `tests/fixtures/apply_entry_append_fixture.py` 驱动的 Python/Rust 服务级最终语义等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/bucket_summary_rebuild_write.rs`：强类型独立 Bucket 摘要重建、最新窗口与 limit 后过滤、时间正序、精确去重、非正字符上限、缓存字段隔离、精确/缺失目标、晚期失败回滚，以及 `tests/fixtures/apply_bucket_summary_rebuild_fixture.py` 驱动的 Python/Rust 服务级最终语义等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/extraction_write.rs`：强类型独立提取结果保存、精确 Bucket/Entry ID、验证顺序与归属、既有记录去重、批内规范化重复保留、四类结构化默认值、Entry/Bucket 缓存更新、重复调用、审计隔离、晚期失败回滚，以及 `tests/fixtures/apply_save_extraction_fixture.py` 驱动的 Python/Rust 服务级最终语义等价；数据库只位于系统临时目录。
- `rust/work-memory-store/tests/classification_write.rs`：强类型独立分类审计保存、输入裁剪与空值、服务端元数据、精确候选合并、三种 action、缺失目标、UUID/default、重复调用、单表影响、插入失败回滚，以及 `tests/fixtures/apply_save_classification_fixture.py` 驱动的 Python/Rust 服务级最终语义等价；数据库只位于系统临时目录。
- `rust/work-memory-service/tests/bucket_query.rs`：首个 Rust 服务层 Bucket 列表、精确查询和完整详情聚合，以及 `tests/fixtures/export_bucket_query_fixture.py` 驱动的 Python/Rust 逐字段 JSON 等价；数据库只位于系统临时目录。
- `rust/work-memory-service/tests/bucket_search.rs`：Rust 服务层关键词搜索验证、候选字段、通配符转义、Unicode casefold 评分、匹配计数、稳定排序和 limit，以及 `tests/fixtures/create_bucket_search_fixture.py`、`export_bucket_search_fixture.py` 驱动的 Python/Rust 逐字段 JSON 等价；数据库只位于系统临时目录。
- `rust/work-memory-service/tests/archive.rs`：Rust `ArchiveService` 的输入裁剪、action/extraction 一致性、确认追加、确认新建、ask_user 仅审计、权威 Bucket 结果投影、缺失目标和无部分写入；`tests/fixtures/apply_archive_service_fixture.py`、`export_archive_service_fixture.py` 驱动 Python/Rust `ArchiveResult` 与最终数据库语义逐字段等价，数据库只位于系统临时目录且不调用真实模型。
- `rust/work-memory-service/tests/correction.rs`：Rust `CorrectionService` 的指定 Entry 移动、最近 Entry 原子选择、显式 Bucket ID、最终“移到/放到”命令目标解析、精确标题优先、唯一模糊候选、空命令、无法识别、无匹配、多匹配、同 Bucket 和失败无部分写入；`tests/fixtures/apply_correction_service_fixture.py`、`export_correction_service_fixture.py` 驱动 Python/Rust `CorrectionResult` 与最终数据库语义逐字段等价，数据库只位于系统临时目录。
- `rust/work-memory-service/tests/mutation.rs`：Rust `MemoryMutationService` 的 Bucket 创建、Entry 追加、Entry 删除和 Bucket 聚合删除，覆盖 Python 兼容规范化、权威返回值、删除影响 ID、非法/缺失目标无部分修改；`tests/fixtures/apply_memory_mutation_service_fixture.py`、`export_memory_mutation_service_fixture.py` 驱动四类操作的 Python/Rust 结果与最终数据库语义等价，数据库只位于系统临时目录且不调用真实模型。
- `rust/work-memory-service/tests/bucket_summary.rs`：Rust `BucketSummaryService` 的默认/显式滚动摘要更新和 Entry 摘要重建，覆盖返回摘要、更新去重与字符边界、重建窗口/过滤/顺序/精确去重、缓存字段隔离、非法/缺失目标无部分修改；`tests/fixtures/apply_bucket_summary_service_fixture.py`、`export_bucket_summary_service_fixture.py` 驱动 Python/Rust 返回值与排除运行时 `updated_at` 后的九表最终语义等价，数据库只位于系统临时目录且不调用真实模型。
- `rust/work-memory-service/tests/extraction.rs`：Rust `ExtractionPersistenceService` 的首次、重复和最小提取保存，覆盖稳定结果投影、UUID v4、四类子记录去重、Entry/Bucket 缓存更新、`last_active_at` 隔离、精确/缺失/归属错误目标和失败无修改；`tests/fixtures/apply_extraction_persistence_service_fixture.py`、`export_extraction_persistence_service_fixture.py` 驱动 Python/Rust 结果与排除随机子记录 ID/运行时 `updated_at` 后的九表最终语义等价，数据库只位于系统临时目录且不调用真实模型。
- `rust/work-memory-service/tests/classification.rs`：Rust `ClassificationAuditService` 的重复 append、create_new、ask_user 和插入失败，覆盖稳定审计 UUID、输入/元数据边界、候选合并、三类 action、重复调用、单表影响和失败无修改；`tests/fixtures/apply_classification_audit_service_fixture.py`、`export_classification_audit_service_fixture.py` 驱动 Python/Rust 结果与排除随机审计 ID/时间后的九表最终语义等价，数据库只位于系统临时目录且不调用真实模型。
- `rust/work-memory-service/tests/chat.rs`：Rust `ChatMessagePersistenceService` 的重复 user、tool、assistant、JSON null、非法输入和插入失败，覆盖稳定消息 UUID、产品返回投影、精确数据库工具元数据、details 边界、严格递增时间和失败无修改；`tests/fixtures/apply_chat_message_service_fixture.py`、`export_chat_message_service_fixture.py` 驱动 Python/Rust 结果与排除随机消息 ID/时间后的九表最终语义等价，数据库只位于系统临时目录且不调用真实模型。

每次改 Prompt 或分类逻辑后，至少手动跑：

- incident 新建。
- incident 追加。
- experiment 新建。
- experiment 追加。
- meeting 提取 TODO。
- 纠错移动最近 entry。
- 搜索历史 bucket。

## 7. bug 记录模板

```md
## Bug 标题

### 输入

### 当前结果

### 期望结果

### 判断
- 分类错 / 提取错 / 保存错 / 展示错 / 搜索错

### 修复方案
```
