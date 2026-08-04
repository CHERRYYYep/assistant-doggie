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

## 15. Python/Rust SQLite 兼容、migration 与事务边界（R2a-R2e）

当前 SQLite 业务 Schema 仍由 Python SQLAlchemy 定义，生产数据库仍由 Python 独占写入。Rust `work-memory-store` 提供九张业务表的强类型只读查询、必须离线执行的 Schema 检查/基线 migration/备份恢复、仅在隔离数据库验证的可写连接和原子事务基础，以及 append/create/ask_user 的强类型归档聚合写 API；该 API 尚未接入生产调用链。

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
- 所有写测试都生成到系统临时目录；该 API 尚未接入 Python Agent、UI 或仓库根目录数据库，正式切换前继续禁止 Python 与 Rust 同时写生产数据库。

完整 migration 命令和恢复步骤见 `docs/SQLITE_MIGRATIONS.md`。R2 仍未覆盖纠错、删除、聊天审计等其余业务写语义，也未完成生产写路径切换。
