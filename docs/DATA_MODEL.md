# 数据模型设计

## 1. 设计原则

- 原始输入永远保存，结构化结果可以重算。
- bucket 是核心上下文对象，不是普通文件夹。
- entry 是用户每次输入的不可变事实记录。
- TODO、证据、时间线等是从 entry 派生出来的结构化资产。
- 纠错和移动要留痕，方便以后学习用户偏好。

## 2. ERD 草图

```text
buckets 1 ── * entries
buckets 1 ── * todos
buckets 1 ── * evidences
buckets 1 ── * timeline_events
buckets 1 ── * decisions
entries 1 ── * todos/evidences/timeline_events/decisions
entries 1 ── * classification_records
corrections record before/after snapshots for changed entries
chat_messages form one independent, ordered singleton conversation timeline

planned: buckets * ── * buckets through bucket_relations
```

## 3. buckets

表示一个持续存在的工作对象。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| title | string | 标题，例如“支付回调失败排查” |
| type | enum | idea/task/incident/experiment/decision/meeting/knowledge/draft |
| status | enum | active/paused/done/archived |
| summary | text | 滚动摘要 |
| tags | json/text | 标签数组，MVP 可用 JSON 字符串 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |
| last_active_at | datetime | 最近活跃时间 |

建议索引：

- type
- status
- updated_at
- last_active_at

## 4. entries

保存用户每次输入的原始内容。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| bucket_id | string/uuid | 所属 bucket |
| raw_text | text | 用户原始输入 |
| summary | text | 本条输入摘要 |
| content_type | string | log/meeting_note/test_result/idea 等 |
| classification_confidence | float | 归档置信度 |
| classification_reason | text | 归档原因 |
| created_at | datetime | 创建时间 |
| moved_from_bucket_id | string/uuid/null | 如果被纠错移动，记录来源 |

建议索引：

- bucket_id
- created_at

## 5. todos

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| bucket_id | string/uuid | 所属 bucket |
| entry_id | string/uuid/null | 来源 entry |
| text | text | 待办内容 |
| status | enum | open/done/cancelled |
| due_date | datetime/null | 截止时间 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

## 6. evidences

证据可以是日志、指标、截图说明、测试结果、用户反馈等。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| bucket_id | string/uuid | 所属 bucket |
| entry_id | string/uuid/null | 来源 entry |
| text | text | 证据内容 |
| source | string/null | 日志、截图、监控、会议等 |
| created_at | datetime | 创建时间 |

## 7. timeline_events

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| bucket_id | string/uuid | 所属 bucket |
| entry_id | string/uuid/null | 来源 entry |
| event_time | string/datetime/null | 事件发生时间，MVP 先用字符串 |
| text | text | 事件内容 |
| created_at | datetime | 记录创建时间 |

MVP 先不强制解析成标准时间，因为用户可能输入“刚才”“下午”“10:20”。

## 8. decisions

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| bucket_id | string/uuid | 所属 bucket |
| entry_id | string/uuid/null | 来源 entry |
| text | text | 决策内容 |
| reason | text/null | 决策原因 |
| created_at | datetime | 创建时间 |

## 9. bucket_relations（规划）

用于表示 bucket 之间的关联，而不是强制单归属。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| source_bucket_id | string/uuid | 源 bucket |
| target_bucket_id | string/uuid | 目标 bucket |
| relation_type | enum | related_to/blocked_by/derived_from/duplicate_of |
| created_at | datetime | 创建时间 |

## 10. corrections

记录用户纠错，后续可用于偏好学习。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| command_text | text | 用户纠错原文 |
| action | string | move_entry/change_type/merge_bucket/new_bucket |
| target_type | string | entry/bucket/relation |
| target_id | string | 被修改对象 |
| before_json | json/text | 修改前快照 |
| after_json | json/text | 修改后快照 |
| created_at | datetime | 创建时间 |

## 11. classification_records

保存每次分类的风险证据。即使结果为 `ask_user`，也可以记录审计，但在用户确认前不创建正式 Entry。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| raw_text | text | 本次分类的原始输入 |
| action | string | append_existing/create_new/ask_user |
| bucket_id | string/uuid/null | 模型建议或最终确认的 Bucket |
| entry_id | string/uuid/null | 成功归档后关联的 Entry |
| confidence | float | LLM 主观风险信号，不是正确概率 |
| reason | text | 分类依据 |
| candidate_bucket_ids | json | 服务端候选与模型建议候选 ID |
| current_focus_bucket_id | string/uuid/null | 分类时的当前焦点 |
| prompt_version | string | Prompt 版本 |
| model_name | string | 模型名 |
| corrected | bool | 后续是否被用户纠错 |
| created_at | datetime | 创建时间 |

## 12. chat_messages

保存应用唯一长期对话中的消息。该表不按 conversation ID 分组，因为当前产品明确只有一个对话；按 `created_at` 顺序即可恢复时间线。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| role | string | user/assistant/tool |
| content | text | 用户输入、助手回答或序列化工具输出 |
| tool_name | string/null | tool 消息对应的注册工具名 |
| tool_call_id | string/null | 模型工具调用 ID，用于审计和关联 |
| details_json | json/null | 工具参数与结构化输出 |
| created_at | datetime | 消息创建时间 |

建议索引：

- role
- created_at

对话上下文默认只加载最近 40 条 `user/assistant` 消息，较早消息仍完整保存在数据库中。工具记录用于 UI 展示和审计，不作为可执行指令重新注入模型。

## 13. user_preferences（规划）

该表尚未进入当前 SQLAlchemy 模型，以下为后续偏好学习规划。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string/uuid | 主键 |
| key | string | 偏好名 |
| value | text/json | 偏好值 |
| source | string | explicit/correction/inferred |
| confidence | float | 偏好置信度 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |

例子：

```json
{
  "key": "prefer_incident_for_payment_errors",
  "value": "支付、回调、502 类输入优先归 incident",
  "source": "correction",
  "confidence": 0.72
}
```

## 14. 后续向量检索扩展

当 entries 数量变多后，可增加：

- embedding 字段或单独 embeddings 表。
- vector_store_file_id。
- 外部向量库 ID。

MVP 不需要一开始做向量库，SQLite 关键词搜索足够验证闭环。

## 15. Python/Rust SQLite 兼容、migration 与事务边界（R2a-R2o）

当前 SQLite 业务 Schema 仍由 Python SQLAlchemy 定义，生产数据库仍由 Python 独占写入。Rust `work-memory-store` 提供九张业务表的强类型只读查询、必须离线执行的 Schema 检查/基线 migration/备份恢复、仅在隔离数据库验证的可写连接和原子事务基础，以及 append/create/ask_user 的强类型归档聚合写 API、Entry 移动纠错 API、ChatMessage 追加 API、Bucket 聚合删除 API、独立 Entry 删除 API、独立 Bucket 创建 API、独立 Entry 追加 API、独立 Bucket 滚动摘要更新 API、独立 Bucket 摘要重建 API、独立提取结果保存 API 与独立分类审计保存 API；这些 API 尚未接入生产调用链。

只读查询边界：

- Rust 以 SQLite `READ_ONLY` 模式打开已有文件，并额外启用 `PRAGMA query_only=ON`；打开时九张业务表及全部读取必需列必须存在，并拒绝不受支持的 migration history。
- `buckets.tags` 和 `classification_records.candidate_bucket_ids` 在 SQLite 中是 JSON 文本，Rust 必须严格解码为 `list[string]` 等价的 `Vec<String>`；损坏 JSON 或非字符串数组应作为持久化数据错误返回。
- `corrections.before_json`、`corrections.after_json` 和 `chat_messages.details_json` 只接受 object、array 或 null；合法 JSON scalar 也必须作为类型错误拒绝。`classification_records.corrected` 只接受 SQLite integer 0/1。
- Bucket type/status、Todo status、Classification action 和 Chat role 使用 Python 契约的精确小写值，不进行 trim 或大小写纠正；未知持久化值必须报错，不能静默映射。分类 action 为 `append_existing/create_new/ask_user`，Chat role 为 `user/assistant/tool`。
- SQLAlchemy SQLite 当前通常把 UTC datetime 写为 `2026-08-04 10:20:00.000000` 一类无时区偏移文本。Rust 保留原始文本，并按“Python 由 `utc_now()` 写入的无偏移 UTC”解析；兼容层同时接受合法 RFC 3339 文本，但不会重写原值。
- 活跃 Bucket 查询保持 `status = active`、`last_active_at DESC`、`updated_at DESC` 和 `limit >= 1`；Bucket 的 Entry、Todo、Evidence、TimelineEvent、Decision 保持 `created_at ASC`。最近 ChatMessage 查询先按 `created_at DESC, id DESC` 截断，再恢复为时间线展示顺序。

R2b 增加 migration 元数据表：

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
```

当前只支持 version 1：`adopt_python_schema_v1`。无 `schema_migrations` 且九张业务表完整的数据库识别为 `LegacyPython`；升级时只创建 migration 表并登记基线，不重建或改写 `buckets`、`entries`、`todos`、`evidences`、`timeline_events`、`decisions`、`classification_records`、`corrections`、`chat_messages`。

离线管理边界：

- 检查九表必需列、`id` 主键、SQLAlchemy 显式索引及列顺序、外键目标和 `ON DELETE` 声明，并执行 `quick_check` 与 `foreign_key_check`。
- migration 前在写者保留锁下使用 SQLite Online Backup API 创建并验证一致性备份；已是当前版本时不创建备份。
- restore 前验证恢复源，并把被替换数据库保存为独立 safety backup；恢复验证失败时尝试自动回退。
- migration、backup、restore 路径必须互异，输出备份路径必须不存在，不能覆盖已有文件。
- 执行 `migrate` 或 `restore` 前必须停止 Python、Streamlit 和其他数据库连接；Python 与 Rust 不得同时写同一份生产数据库。
- 跨语言测试只在系统临时目录生成数据库，不得读取、覆盖或迁移仓库根目录的 `work_memory.db`。

R2d 可写事务边界：

- `WritableSqliteStore::open_existing` 只允许以 `READ_WRITE` 打开已有文件；不会创建新数据库，也不会改变 `SqliteStore` 的 `READ_ONLY + query_only` 保证。
- 打开时启用并验证 `foreign_keys`，检查受支持的 migration history，并执行完整九表 Schema 与完整性验证；不完整、损坏或未来版本数据库在进入事务前被拒绝。
- crate 内部统一使用 `BEGIN IMMEDIATE`，成功才 commit，操作错误显式 rollback；打开后如 `schema_version` 变化，后续事务被拒绝。
- 原始事务闭包保持 crate-private，防止调用方以任意 SQL 绕过强类型和业务不变量校验。

R2e 强类型归档写边界：

- `ArchiveWriteRequest` 把已验证的 `ClassificationResult`、可选 `ExtractionResult` 和服务端审计上下文组合为一个聚合写请求；公开入口只有 `WritableSqliteStore::persist_archive_attempt`，不暴露任意 SQL 或零散 CRUD。
- `ask_user` 只新增 `classification_records`；`append_existing` 原子写入 Entry、Todo/Evidence/TimelineEvent/Decision、Bucket tags/滚动摘要/活跃时间和关联分类审计；`create_new` 在同一事务先创建 Bucket，再执行完整归档。
- 写入值保持 Python 语义：Entry `content_type=note`、Todo 初始 `open`、Evidence source 为 `llm-extracted`、ClassificationRecord `corrected=0`，分类候选保持服务端候选在前的有序合并。
- 子记录去重只针对事务开始前已存在的 Bucket 记录，标签使用 Unicode casefold 去重，滚动摘要保留首片段和最新片段并限制为 1200 字符。
- UUID v4 与 SQLAlchemy 风格 UTC 文本由 SQLite 事务内生成；全部 ID 和关系只在事务提交后返回。
- 隔离测试覆盖 append/create/ask_user、缺失 Bucket、触发器制造的中途失败全回滚，以及 Python `archive_confirmed_input` 与 Rust 写入后的业务语义等价。

R2f Entry 移动纠错写边界：

- `MoveEntryRequest` 规范化并校验非空纠错命令；`WritableSqliteStore::move_entry` 是唯一公开入口，同一事务移动 Entry 及其 Todo/Evidence/TimelineEvent/Decision。
- Entry 保存原来源 Bucket 到 `moved_from_bucket_id`；Correction 保存包含有序子记录 ID 的前后 JSON 快照，所有关联 `classification_records` 标记为 `corrected=1`。
- 来源和目标 Bucket 同时更新活跃时间，并分别从最多八条存活 Entry 摘要重建 1200 字符缓存；缺失 Entry、缺失目标 Bucket 和原目标相同均在产生业务修改前失败。
- 隔离测试覆盖完整移动、两类缺失记录、同 Bucket 类型化错误、目标摘要重建触发器造成的晚期全事务回滚，以及 Python `move_entry` 与 Rust 最终业务语义等价。
- 所有写测试都生成到系统临时目录；这些 API 尚未接入 Python Agent、UI 或仓库根目录数据库，正式切换前继续禁止 Python 与 Rust 同时写生产数据库。

R2g ChatMessage 追加写边界：

- `ChatMessageWriteRequest` 的角色使用 `ChatRole::User/Assistant/Tool`，从类型层排除未知角色；`content` 与 Python 一样裁剪并拒绝空值。
- `tool_name` 和 `tool_call_id` 保留调用方原值，不自动 trim；details 只接受 object、array 或 null，Rust 写入时把 null 规范化为 SQL NULL，读取层同时把 Python JSON `null` 与 SQL NULL 解释为无 details。
- `WritableSqliteStore::append_chat_message` 一次只追加一条消息并独立提交或回滚，匹配当前 Python `add_chat_message` 的自有 Session 语义，不宣称完整 Agent turn 原子化。
- 新消息使用 UUID v4；时间戳至少比当前最新 ChatMessage 晚一微秒，从而保持 `created_at DESC, id DESC` 有界查询再反转后的追加/展示顺序。
- 隔离测试覆盖三种角色、校验前无写入、单行影响范围、快速连续追加、触发器失败回滚，以及 Python/Rust 忽略随机 ID 和实际时间后的消息语义等价。

R2h Bucket 聚合删除写边界：

- `DeleteBucketRequest` 保留调用方提供的精确 Bucket ID；`WritableSqliteStore::delete_bucket` 在统一 `BEGIN IMMEDIATE` 事务中拒绝缺失 Bucket，并返回被删除的 Entry 与 Bucket 自有 Todo/Evidence/TimelineEvent/Decision ID，以及被清空 Entry 外键的 ClassificationRecord ID。
- 删除依赖当前 Python Schema 的外键语义：Bucket、其 Entry 和 Bucket 自有结构化记录级联删除；关联 `classification_records.entry_id` 设为 NULL，而非外键的 `classification_records.bucket_id`、审计文本、Correction 和 ChatMessage 保持不变。
- 若其他 Bucket 的 Todo/Evidence/TimelineEvent/Decision 指向被删 Entry，这些记录继续存在并把 `entry_id` 设为 NULL；Rust 还显式刷新存活 Todo 的 `updated_at`，匹配 SQLAlchemy `onupdate=utc_now`，其余三类记录没有更新时间字段。
- 当前产品没有公开的 Python Bucket 删除服务；跨语言 fixture 直接执行 SQLAlchemy `session.delete(bucket)`，因此此处验证的是模型级级联/SET NULL 最终状态等价，而不是服务接口等价。
- 隔离测试覆盖聚合影响报告、跨 Bucket 引用存活、缺失 Bucket 无修改、触发器失败全事务回滚和 Python/Rust 最终业务状态等价；所有数据库仅位于系统临时目录。

R2i 独立 Entry 删除写边界：

- `DeleteEntryRequest` 保留精确 Entry ID；`WritableSqliteStore::delete_entry` 在统一事务中拒绝缺失 Entry，并返回原 Bucket ID 及所有被清空链接的 Todo/Evidence/TimelineEvent/Decision/ClassificationRecord ID。
- 只删除 Entry 本身；同 Bucket 与跨 Bucket 的结构化记录都继续存在并把 `entry_id` 设为 NULL，关联 ClassificationRecord 同样只清空外键，`bucket_id` 和其他审计字段不变。
- 所有受影响 Todo 同时刷新 `updated_at`，匹配 SQLAlchemy `onupdate=utc_now`；Bucket 的 summary、`updated_at`、`last_active_at` 不自动更新，Correction 与 ChatMessage 也保持不变。
- 当前产品没有公开的 Python Entry 删除服务；`tests/fixtures/apply_entry_delete_fixture.py` 直接执行 SQLAlchemy `session.delete(entry)`，用于验证模型级关系更新和最终状态等价。
- 隔离测试覆盖影响 ID、同/跨 Bucket 引用、精确 ID、缺失 Entry、删除触发器之前已执行的链接更新全事务回滚，以及除运行时时间外的 Python/Rust 最终业务状态等价。

R2j 独立 Bucket 创建写边界：

- `CreateBucketRequest` 使用强类型 `BucketType`，标题 trim 后不能为空，摘要 trim，标签逐项 trim 并丢弃空项，同时保持原顺序和重复值，匹配 Python `create_bucket` 服务。
- `WritableSqliteStore::create_bucket` 在统一事务内由 `uuid` crate 生成 UUID v4，并写入 SQLite 兼容时间，创建 status 为 active 的单个 Bucket；不创建 Entry、结构化记录、ClassificationRecord、Correction 或 ChatMessage。
- 返回完整 `StoredBucket`；插入触发器失败会回滚全部业务状态，调用方仍无法获得裸可写连接或任意 SQL 闭包。
- `tests/fixtures/apply_bucket_create_fixture.py` 调用 Python `create_bucket`；隔离测试比较忽略随机 ID 和运行时时间后的 Python/Rust 最终服务语义。

R2k 独立 Entry 追加写边界：

- `AppendEntryRequest` 保留精确 Bucket ID；`raw_text` 和 `content_type` trim 后不能为空，置信度必须在 0 到 1 之间且不能为 NaN。
- `summary` 与 `classification_reason` 保持 Python 字符串真值边界：None 或空字符串写为 SQL NULL，非空纯空白字符串 trim 后写为空字符串。
- `WritableSqliteStore::append_entry` 在统一事务内拒绝缺失 Bucket，生成 Entry UUID v4 和时间，只插入一条不可变 Entry，并把 Bucket `updated_at`、`last_active_at` 刷新为同一时间；Bucket title/type/status/summary/tags 与所有结构化、分类和纠错记录不变。
- `tests/fixtures/apply_entry_append_fixture.py` 调用 Python `append_entry`；隔离测试覆盖规范化、单行影响、精确/缺失 Bucket ID、晚期 Bucket 更新时间触发器导致 Entry 插入回滚，以及忽略随机 ID/运行时时间后的服务级最终语义等价。

R2l 独立 Bucket 滚动摘要更新写边界：

- `UpdateBucketSummaryRequest` 保留精确 Bucket ID，`entry_summary` trim 后不能为空；默认 `max_chars` 为 1200，自定义上限必须至少为 100，校验顺序与 Python `update_bucket_summary` 一致。
- 摘要按换行拆分并裁剪空白，使用 Unicode casefold 与空白折叠后的 key 避免追加语义重复片段；超限时优先保留第一段和最新片段，最终按 Unicode 字符数截断并追加省略号。
- `WritableSqliteStore::update_bucket_summary` 在统一事务内拒绝缺失 Bucket，只更新目标 Bucket 的 `summary` 与 `updated_at`；`last_active_at`、标题、类型、状态、标签、Entry、结构化记录和审计记录均保持不变。
- `tests/fixtures/apply_bucket_summary_update_fixture.py` 调用 Python `update_bucket_summary`；隔离测试覆盖默认/自定义上限、去重、精确/缺失 ID、触发器失败全事务回滚和忽略运行时时间后的服务级最终语义等价。

R2m 独立 Bucket 摘要重建写边界：

- `RebuildBucketSummaryRequest` 保留精确 Bucket ID，默认读取最新八条非 NULL Entry summary，并把 `max_entries < 1` 作为类型化校验错误；`max_chars` 默认 1200，暂时保留现有 Python 服务未校验非正值时的切片行为，而不擅自改变生产语义。
- SQL 先按 `created_at DESC` 限制窗口，空字符串和纯空白 summary 也会占用窗口；随后 trim、丢弃空片段、恢复为时间正序，并按清理后的大小写敏感精确文本保留第一次出现，区别于滚动追加 API 的 Unicode casefold 去重。
- 重建结果按 Python Unicode 字符和切片语义截断；没有存活 Entry summary 时会把旧缓存清空。事务只更新目标 Bucket 的 `summary` 与 `updated_at`，不刷新 `last_active_at`，也不修改其他业务表。
- 独立 API 与 Rust `move_entry` 共用同一重建函数，避免纠错路径和公开重建路径漂移；`tests/fixtures/apply_bucket_summary_rebuild_fixture.py` 驱动隔离 Python/Rust 最终语义等价测试，并覆盖窗口、去重、空缓存、非正字符上限、精确/缺失 ID 和触发器失败回滚。


R2n 独立提取结果保存写边界：

- `SaveExtractionRequest` 接收已验证的核心 `ExtractionResult` 并保留精确 Bucket/Entry ID；事务先查 Bucket，再验证 Entry 存在且属于目标 Bucket，缺失 Bucket、缺失 Entry 或归属不匹配都在业务修改前返回类型化错误。
- Todo/Evidence/Decision 按 Unicode casefold 与空白折叠后的文本 key 对事务前已有记录去重，TimelineEvent 按精确 `event_time` 与规范化文本组合去重；与 Python 相同，去重集合不会在处理本批输入时扩展，因此同一批中的规范化重复项仍可分别保存。
- 新 Evidence 的 source 固定为 `llm-extracted`，Todo 使用 open/无 due date，Decision reason 为 NULL；`hypotheses` 与 `entities` 当前没有持久化表，保持不落库。返回值只暴露本次新建的四类结构化记录 ID。
- 同一事务把 Entry `summary` 设为提取摘要，按 Unicode casefold 合并 Bucket 标签，并用 1200 字符滚动规则更新 Bucket `summary` 与 `updated_at`；`last_active_at`、Entry 其他字段、分类/纠错/聊天审计均不变。
- 独立 API 与归档聚合写路径共用结构化记录插入和 Bucket 缓存更新实现；`tests/fixtures/apply_save_extraction_fixture.py` 驱动隔离 Python/Rust 最终语义等价测试，并覆盖精确 ID、验证顺序、归属错误、批内重复、重复调用和晚期失败全事务回滚。

R2o 独立分类审计保存写边界：

- `SaveClassificationRecordRequest` 接收已验证的核心 `ClassificationResult`、服务端候选 ID、当前焦点、Prompt 版本和已解析模型名；只对原始输入执行 Python `strip()` 等价裁剪，空字符串仍可作为审计输入保存，其他服务端元数据保持精确值。模型配置解析仍由调用方负责，SQLite Store 不读取环境变量。
- 候选 ID 按 Python `dict.fromkeys` 语义合并：服务端候选在前、模型结果候选在后，只删除大小写敏感的精确重复并保留第一次出现；服务端传入的空值或带空白值不会被 Store 额外清理，已验证的核心模型候选则继续遵循核心规范化规则。
- 新记录使用 UUID v4、运行时 UTC 时间和 `corrected=false`；`bucket_id` 直接取分类结果且不验证该审计目标是否存在（create_new 必为 NULL，ask_user 保留已验证结果中的可选值），`entry_id` 始终为 NULL。create_new、append_existing 和 ask_user 都可独立记录，重复调用会产生独立审计行。
- 事务只新增一条 `classification_records`，不修改 Bucket、Entry、结构化记录、Correction 或 ChatMessage；独立 API 与归档聚合写路径共用候选合并和审计插入实现。`tests/fixtures/apply_save_classification_fixture.py` 驱动隔离 Python/Rust 最终语义等价测试，并覆盖精确元数据、全部 action、空输入、重复保存、缺失审计目标和插入失败回滚。

完整 migration 命令和恢复步骤见 `docs/SQLITE_MIGRATIONS.md`。R2 仍未覆盖其他剩余 CRUD 写语义，也未完成生产写路径切换。

## 16. Rust Bucket 查询与搜索服务边界（R3a-R3b）

`work-memory-service::BucketQueryService` 是首个 Rust 业务编排层，当前只持有经完整 Schema 校验、migration 历史校验和 `query_only` 保护的 `SqliteStore`：

- `list_active_buckets` 保持 Python 的 active 过滤、`last_active_at DESC, updated_at DESC` 排序和正数 limit 校验。
- `get_bucket` 使用调用方提供的精确主键，不裁剪、不创建兜底记录；缺失时返回 `None`。
- `get_bucket_detail` 仅在 Bucket 存在时组合 Bucket、Entry、Todo、Evidence、TimelineEvent 和 Decision，并保持各关系按 `created_at ASC` 的 Python 顺序；分类、纠错和聊天审计不属于当前产品详情视图。
- `tests/fixtures/export_bucket_query_fixture.py` 在同一 Python 创建的临时数据库上调用权威 Python 服务并导出完整 JSON；Rust 集成测试逐字段比较活跃列表、单 Bucket、缺失结果和详情聚合。
- `search_buckets` 对查询执行 Unicode trim 并拒绝空值，limit 必须为正数；SQLite 候选查询保持标题、摘要、`CAST(tags AS TEXT)` 和 Entry 原文四个 `contains(..., autoescape=True)` 条件，以及 `max(limit * 5, 50)` 候选窗口。
- 最终评分保持 Python 规则：标题 casefold 精确/包含分别加 100/50，任一标签包含加 30，摘要包含加 20，每条匹配 Entry 加 5 且最多计十条；结果按 score、`last_active_at` 降序稳定排序后截断。
- JSON 标签仍以 SQLite 序列化文本参与候选查询；因此 Python 默认 JSON 转义造成的非 ASCII 标签候选限制属于当前兼容语义，不在 R3b 中单方面修正。`tests/fixtures/export_bucket_search_fixture.py` 覆盖字段来源、通配符字面转义、Unicode casefold、稳定并列顺序、匹配计数和逐字段结果等价。

R3a-R3b 只证明隔离只读服务语义等价；归档、纠错、基础变更和摘要缓存写服务边界分别见 R3c、R3d、R3e、R3f。上述服务均尚未接入 Agent、UI 或生产数据库。

## 17. Rust 归档服务编排边界（R3c）

`work-memory-service::ArchiveService` 是首个 Rust 业务写服务。它持有经完整 Schema 与 migration 历史校验的 `WritableSqliteStore`，但不暴露 SQLite 连接、任意 SQL 或事务闭包：

- `archive_classified_input` 接收已验证的核心 `ClassificationResult`、可选 `ExtractionResult` 和 `ClassificationAuditContext`。服务先按 Python `strip()` 语义清理并拒绝空输入；append/create 必须携带提取结果，ask_user 必须不携带提取结果，从服务层阻止不确定内容进入正式记忆。
- `archive_confirmed_input` 构造 append_existing 分类，按 Python 语义把确认目标同时记录为唯一服务端候选和当前焦点；`archive_confirmed_new_input` 构造 create_new 分类并保持空候选、空焦点。两个入口都使用当前 `classification-v2`，模型名必须由调用方预先解析。
- Store 继续拥有单一 SQLite 事务：ask_user 只写 `classification_records`；append/create 原子写 Bucket/Entry、四类结构化记录、标签、滚动摘要、活跃时间和审计链接。缺失确认目标或晚期 SQLite 失败不会留下部分业务状态。
- `ArchiveWriteOutcome` 现在同时返回事务内权威 Bucket 标题和类型；服务据此投影核心 `ArchiveResult`。ask_user 的建议标题、类型、问题和模型候选来自已验证分类结果，已归档结果与 Python 一样不回显候选列表。
- `tests/fixtures/apply_archive_service_fixture.py` 和 `export_archive_service_fixture.py` 驱动确认追加、确认新建、ask_user 的 Python/Rust 返回值及最终数据库语义等价；所有数据库均在系统临时目录创建。

R3c 不实现或伪装完整的模型调用闭环。分类与提取结果仍由调用方提供；R4a Structured Outputs adapter core 尚未接入此服务，真实 HTTP、候选加载、风险门控接线和生产 `archive_user_input` 替换留到 R4b/后续集成。Python 仍是唯一生产数据库写入者，也不得与 Rust 并发写同一生产数据库。

## 18. Rust 纠错服务编排边界（R3d）

`work-memory-service::CorrectionService` 把 R2f 的受控聚合移动事务提升为产品服务边界。它只持有经验证的 `WritableSqliteStore`，不向调用方暴露连接、SQL 或事务闭包：

- `move_entry` 接收显式 Entry ID、目标 Bucket ID 和纠错命令；命令按 Python `strip()` 语义裁剪，空命令在服务入口拒绝。提交结果投影为 `CorrectionResult`，包含生成的 Correction ID、规范化命令、来源/目标 Bucket、被移动的四类派生记录 ID，以及被标记为已纠错的分类审计 ID。
- `move_latest_entry` 支持显式目标 Bucket ID；未提供 ID 时，复现 Python MVP 支持的中文命令形式，从最后一个“移到”或“放到”片段提取目标标题。无法识别目标时不会进入 Store。
- Store 在同一 `BEGIN IMMEDIATE` 事务中按 `created_at DESC` 选择最新 Entry、解析标题候选并执行聚合移动。标题候选保持 SQLAlchemy `contains(..., autoescape=True)` 的 `%`/`_` 字面转义，唯一精确标题优先于模糊候选；无候选或多个候选返回结构化错误。
- Entry、Todo、Evidence、TimelineEvent、Decision、两个 Bucket 的摘要/活跃时间、关联 `classification_records.corrected` 和 Correction 前后快照仍由一个事务共同提交或回滚。“最近一条”选择不在事务外预读，因此不会在选择和写入之间漂移。
- `tests/fixtures/apply_correction_service_fixture.py`、`export_correction_service_fixture.py` 和 `rust/work-memory-service/tests/correction.rs` 覆盖指定 Entry、显式目标的最近 Entry、命令解析的最近 Entry、最终目标优先、精确/模糊标题规则、空命令、缺失/歧义目标、同 Bucket 拒绝、无部分写入，以及 Python/Rust 返回值和最终数据库语义等价。

R3d 仍只在系统临时目录中的隔离数据库运行。Streamlit 的“移动最近 Entry”和其他生产调用仍使用 Python，切换前不得让 Python 与 Rust 并发写同一生产数据库。

## 19. Rust Bucket/Entry 基础变更服务边界（R3e）

`work-memory-service::MemoryMutationService` 把 R2h-R2k 已验证的独立写事务提升为产品服务边界。它持有一个经完整 Schema 与 migration 历史校验的 `WritableSqliteStore`，但调用方只能提交明确的 Bucket/Entry 变更参数：

- `create_bucket` 在服务内部构造 `CreateBucketRequest`，保持标题和摘要 trim、空标题拒绝、标签逐项 trim/丢弃空值并保留顺序与重复值，以及 active 默认状态；返回事务实际创建的 `StoredBucket`。
- `append_entry` 在服务内部构造 `AppendEntryRequest`，保持 raw text/content type 必填、可选 summary/reason 的 Python 真值与 trim 边界，以及有限 0 到 1 的分类置信度；返回事务实际创建的 `StoredEntry`，并只刷新目标 Bucket 的 `updated_at` 与 `last_active_at`。
- `delete_entry` 返回被删除 Entry 的归属 Bucket 以及清空 Entry 外键的 Todo/Evidence/TimelineEvent/Decision/ClassificationRecord ID。子记录与审计保留，Bucket 缓存不重建，Todo 按 Python/SQLAlchemy 语义刷新 `updated_at`。
- `delete_bucket` 返回被级联删除的 Entry 和 Bucket 自有结构化记录 ID，以及被清空 Entry 链接的分类审计 ID。普通 Correction/Chat 审计和非外键 Bucket 文本引用保持不变。
- 服务不暴露 `WritableSqliteStore`、请求对象、连接、任意 SQL 或事务闭包；非法字段、缺失 Bucket/Entry 和晚期 SQLite 错误沿类型化 `ServiceError::Store` 返回，Store 事务确保无部分业务修改。
- `tests/fixtures/apply_memory_mutation_service_fixture.py`、`export_memory_mutation_service_fixture.py` 与 `rust/work-memory-service/tests/mutation.rs` 分别比较四个操作的 Python/Rust 结果投影和忽略随机 UUID/运行时时间后的最终数据库语义；测试数据库均位于系统临时目录。

R3e 只接通独立基础变更服务，不把创建、追加或删除切到生产调用链，也不改变 R3c 归档和 R3d 纠错各自的聚合事务边界。Python 仍是唯一生产 SQLite 写入者，且不得与 Rust 并发写同一生产数据库。

## 20. Rust Bucket 摘要缓存服务边界（R3f）

`work-memory-service::BucketSummaryService` 把 R2l-R2m 已验证的两类摘要写事务提升为产品服务边界。服务持有经完整 Schema 与 migration 历史校验的 `WritableSqliteStore`，但调用方只提交 Bucket ID、摘要片段和可选限制：

- `update_bucket_summary` 使用 Python 默认的 1200 字符上限；`update_bucket_summary_with_max_chars` 接受至少 100 字符的显式上限。两者都在服务内部构造 `UpdateBucketSummaryRequest`，保持片段 trim/空值拒绝、Unicode casefold 加空白折叠去重、首段保留和中间旧事实淘汰规则。
- `rebuild_bucket_summary` 使用 Python 默认的最新八条非 NULL Entry summary 窗口和 1200 字符上限；`rebuild_bucket_summary_with_limits` 接受显式 Entry/字符限制。两者都在服务内部构造 `RebuildBucketSummaryRequest`，保持先限制最新窗口、再过滤空白、恢复时间正序和按清理后文本精确去重的语义。
- 四个入口都返回 Store 事务提交后的权威摘要字符串，不暴露 request、连接、SQL 或事务闭包。更新与重建只修改目标 Bucket 的 `summary` 和 `updated_at`，`last_active_at`、其他 Bucket 字段、Entry 与其余八张业务表保持不变。
- 空更新片段、过小更新字符上限、非正重建 Entry 上限和缺失 Bucket 通过 `ServiceError::Store` 返回；请求校验或 Store 事务失败不会留下部分修改。
- `tests/fixtures/apply_bucket_summary_service_fixture.py` 为 Python 权威路径提供更新、重建和仅准备 Entry 的固定场景；`export_bucket_summary_service_fixture.py` 排除运行时 `updated_at` 并规范化 JSON 字段，`rust/work-memory-service/tests/bucket_summary.rs` 比较返回摘要、九表最终语义、默认值接线、非法/缺失请求和无部分修改。数据库均位于系统临时目录。

R3f 只接通独立摘要缓存维护，不替代 R3c 归档或 R3d 纠错事务内部的摘要更新，也不切换 Agent/UI/生产调用链。Python 仍是唯一生产 SQLite 写入者，且不得与 Rust 并发写同一生产数据库。

## 21. Rust 独立提取保存服务边界（R3g）

`work-memory-service::ExtractionPersistenceService` 把 R2n 已验证的独立提取保存事务提升为产品服务边界。服务持有经完整 Schema 与 migration 历史校验的 `WritableSqliteStore`，但调用方只提交精确 Bucket/Entry ID 和已经通过核心层验证的 `ExtractionResult`：

- `save_extraction` 在服务内部构造 `SaveExtractionRequest`，不暴露 Store request、outcome、连接、SQL 或事务闭包；模型调用和 JSON/Schema 验证仍由服务外的未来 adapter 负责。
- Store 事务继续先校验精确 Bucket，再校验 Entry 存在且属于目标 Bucket；随后按调用前已有记录对 Todo/Evidence/TimelineEvent/Decision 去重，更新 Entry `summary`，按 Unicode casefold 合并 Bucket tags，并更新 1200 字符滚动摘要和 `updated_at`。
- 事务不刷新 Bucket `last_active_at`，也不修改 Entry 其他字段或 ClassificationRecord、Correction、ChatMessage；缺失 Bucket、缺失 Entry、归属不匹配或晚期数据库错误均不会留下部分修改。
- 稳定结果投影 `ExtractionSaveResult` 返回权威 Bucket/Entry ID 与本次实际新增的四类子记录 ID。重复保存同一提取结果时，这些 ID 列表为空，但 Entry/Bucket 缓存语义仍与 Python 保持一致。
- `tests/fixtures/apply_extraction_persistence_service_fixture.py`、`export_extraction_persistence_service_fixture.py` 与 `rust/work-memory-service/tests/extraction.rs` 比较首次、重复、最小和无效目标场景的 Python/Rust 结果及九表最终语义；随机子记录 ID 和运行时 `updated_at` 被规范化，数据库只位于系统临时目录且不调用真实模型。

R3g 只接通已验证提取结果的独立持久化，不替代 R3c 归档事务内部的提取保存，也不提供模型调用或切换 Agent/UI/生产调用链。Python 仍是唯一生产 SQLite 写入者，且不得与 Rust 并发写同一生产数据库。

## 22. Rust 独立分类审计保存服务边界（R3h）

`work-memory-service::ClassificationAuditService` 把 R2o 已验证的独立分类审计事务提升为产品服务边界。服务持有经完整 Schema 与 migration 历史校验的 `WritableSqliteStore`，但调用方只提交原始输入、已验证 `ClassificationResult` 和服务端拥有的审计元数据：

- `save_classification_record` 在服务内部构造 `SaveClassificationRecordRequest`，不暴露 Store request/outcome、连接、SQL 或事务闭包。分类、候选加载、风险门控、Prompt 选择和模型名解析仍由服务外的未来 adapter 负责。
- Store 保持 Python 的字段边界：只 trim 原始输入且允许空审计文本；服务端候选、焦点、Prompt 版本和模型名精确保留；候选列表按服务端在前、分类结果在后做大小写敏感的精确保序去重。
- append_existing、create_new 和 ask_user 均写入分类结果中的 action、可选 Bucket ID、置信度和原因；`entry_id` 固定为 NULL、`corrected=false`。审计 Bucket ID 不做外键存在性校验，重复调用每次新增一条记录。
- 稳定结果投影 `ClassificationAuditSaveResult` 返回事务生成的 ClassificationRecord UUID。事务只修改 `classification_records`，插入失败不会修改其他八张业务表或留下部分状态。
- `tests/fixtures/apply_classification_audit_service_fixture.py`、`export_classification_audit_service_fixture.py` 与 `rust/work-memory-service/tests/classification.rs` 比较重复 append、空文本 create_new、带建议目标的 ask_user 和插入失败场景的 Python/Rust 结果及九表最终语义；随机审计 ID/时间被规范化，数据库只位于系统临时目录且不调用真实模型。

R3h 只接通已验证分类结果的独立审计持久化，不替代 R3c 归档事务内部的分类审计，也不提供分类模型调用或切换 Agent/UI/生产调用链。Python 仍是唯一生产 SQLite 写入者，且不得与 Rust 并发写同一生产数据库。

## 23. Rust 单条聊天消息持久化服务边界（R3i）

`work-memory-service::ChatMessagePersistenceService` 把 R2g 已验证的单条 ChatMessage 追加事务提升为产品服务边界。服务持有经完整 Schema 与 migration 历史校验的 `WritableSqliteStore`，但调用方只提交 `ChatRole`、消息内容、可选工具元数据与 details：

- `append_chat_message` 在服务内部构造 `ChatMessageWriteRequest`，不暴露 Store request、连接、SQL 或事务闭包。角色从类型层限定为 user/assistant/tool；内容按 Python 规则 trim 并拒绝空值。
- details 只接受 object、array 或 null；JSON null 规范化为 SQL NULL。`tool_name` 与 `tool_call_id` 在数据库中精确保留，包括首尾空白。
- 稳定结果投影 `ChatMessageSaveResult` 返回提交后的 UUID、角色、内容、工具元数据、details 和时间。为匹配 Python `ChatMessageView` 的 Pydantic 行为，结果中的可选工具字符串会 trim；该投影不反向修改数据库中的精确值。
- 每次调用在独立事务中只新增一条 ChatMessage，由 `uuid` crate 生成 UUID v4，并保证 `created_at` 严格晚于当前最新消息，从而保持最近窗口截断再反转后的追加顺序。重复内容不会去重；非法请求在写入前拒绝，插入失败不修改九表。
- `tests/fixtures/apply_chat_message_service_fixture.py`、`export_chat_message_service_fixture.py` 与 `rust/work-memory-service/tests/chat.rs` 比较重复 user、tool、assistant、JSON null、非法输入和插入失败场景的 Python/Rust 返回结果及九表最终语义；随机消息 ID/时间被规范化，数据库只位于系统临时目录且不调用真实模型。

R3i 只接通单条聊天消息的独立持久化，不提供完整 Agent turn 的跨消息事务，也不切换 Agent/UI/生产调用链。Python 仍是唯一生产 SQLite 写入者，且不得与 Rust 并发写同一生产数据库。

## 24. Rust Structured Outputs adapter 边界（R4a）

R4a 不新增或修改 SQLite 表，而是在 `work-memory-contracts` 与 `work-memory-agent` 建立模型 JSON 的外部边界：

- `StructuredOutputContract` 为分类、提取和 Bucket 摘要结果提供固定 schema name、strict JSON Schema 以及复用现有 Rust contract 校验的解析入口。三份 Schema 由 `tests/fixtures/export_llm_adapter_fixture.py` 使用当前 Python OpenAI SDK 导出，并在 Rust 测试中逐值比较。
- `LlmEndpointConfig` 只处理非密钥 endpoint 配置：official 固定到 `https://api.openai.com/v1`；custom site 必须显式提供安全 Base URL；请求路径由 `responses` 或 `chat/completions` 模式决定。配置对象不读取 `.env`、API Key 或模型名。
- Responses 请求使用 `text.format = {type: json_schema, name, strict, schema}`；Chat Completions 请求使用 `response_format.json_schema`。模型名在请求前 trim，system/user Prompt 只检查非空并保留原始空白。
- 响应先归一化结构化文本，再执行 JSON 解析与 contract 校验。网络错误、408/409/429、5xx、非 content-filter incomplete、缺失输出、非法 JSON 和 contract error 可在调用方指定上限内重试；其他 4xx、refusal 与 content filter 不重试，最终错误保留尝试次数和最后原因。
- 普通测试注入记录请求的 fake transport，不调用真实模型、不读取密钥，也不打开 SQLite。R4a 尚未实现真实 HTTP、Authorization、timeout/proxy、分类/提取编排、Agent Harness 或 UI/生产接线。

因此 R4a 不改变数据库写入所有权：Python 仍是唯一生产 SQLite 写入者，Python 与 Rust 仍不得并发写同一生产数据库。
