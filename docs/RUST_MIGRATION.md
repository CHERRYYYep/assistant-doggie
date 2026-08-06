# Rust 渐进重构计划

> 状态日期：2026-08-06
> 当前阶段：R2/R3 已完成隔离实现，R4a/R4b/R4c 已完成，R4d canonical runtime 与 R5a 本地 HTTP/API/UI 入口已完成并通过 fake transport、runtime 和 route smoke 回归。Rust 已具备九表 legacy 兼容边界、Rust canonical SQLite schema、一次性 legacy semantic importer、CanonicalService、Structured Outputs adapter、真实 `ureq` transport、有界 Agent Harness、完整 turn 编排和 `work-memory-server`。Python 应用仍保留用于 legacy UI、兼容回归和一次性导入；它不再是 Rust canonical 长期生产写路径。完成备份、`import-legacy`、核验和 operational cutover 后，Rust server/runtime/service/store 才成为 canonical SQLite 的唯一生产写入者。

## 1. 目标

最终让 Rust 负责领域模型、SQLite 持久化、分类与提取编排、归档事务、搜索、纠错、Agent Harness、HTTP API 和 Web UI，并在行为与数据兼容得到验证后删除 Python 运行时。

应用和服务重构不是一次性重写。迁移期间采用“绞杀者”方式，每次只切换一个可验证边界：

1. 先迁移无 I/O 的确定性规则。
2. 再建立 JSON 与 SQLite 兼容层。
3. 随后逐个迁移读服务和写事务。
4. 最后替换 Agent、API 和 UI，并移除 Python。

SQLite 存储边界例外：这不是把 Rust 长期接到 Python 的九张表上，也不是双写或原地改造。旧 Python SQLite 只作为一次性、只读的语义导入源；导入到全新的 Rust canonical SQLite 并完成核验后，才切换生产运行时和写入所有权。

## 2. 不变量

重构过程中必须持续满足以下产品约束：

- 原始 Entry 不丢失，所有派生记录可以追溯到原文。
- 低置信度、多个相似候选或无效 Bucket ID 不得自动污染长期记忆。
- Bucket、Entry、结构化记录和分类审计的写入保持单事务语义。
- 纠错移动 Entry 时同步移动派生记录，并保留前后快照。
- 普通自动化测试不调用真实 LLM。
- 现有 `work_memory.db` 在明确迁移和备份前不得由不兼容 Schema 覆盖。
- legacy Python source 必须以 SQLite read-only、`query_only` 打开并先完成 Schema/完整性校验；导入过程不得修改 source。
- source 与 target 路径必须不同；target 必须是不存在、空的 SQLite 文件，或上一次失败导入留下的无业务 rows 的 canonical 空壳。已有非内部表、索引、view 或 trigger 的 target 必须拒绝。
- canonical target 必须先初始化并验证 Rust schema；语义导入的业务 rows 在一个 `BEGIN IMMEDIATE` 事务中写入，任意失败都回滚，不得留下部分业务数据。
- 导入成功后核验 counts、原始 Entry、结构化 memory、审计和聊天顺序；失败后只能修复 source 后重试空 target，或使用新的空 target，不能在有业务 rows 的 target 上追加导入。
- Python 与 Rust 不得并发写同一个 SQLite 文件。cutover 前 Python 仍是 legacy 生产写入者；cutover 后 Rust canonical SQLite 是唯一生产写入目标，Python source/备份保持冻结只读。

## 3. 迁移架构

历史 legacy 运行路径（仍可用于兼容回归）：

```text
Streamlit UI -> Python Agent/Services -> SQLAlchemy -> SQLite
                           |
                           +-> OpenAI / compatible API
```

当前 Rust canonical 目标生产入口：

```text
Rust-served Web UI / HTTP API
        |
        +-> CanonicalRuntime -> CanonicalService -> Rust canonical SQLite
        |          |
        |          +-> AgentHarness / StructuredMemoryModel
        |          +-> OpenAI / compatible API
        |
        +-> legacy Python app（仅兼容/导入，不写 Rust canonical DB）
```

长期生产路径：

```text
Rust-served Web UI -> Rust API/CanonicalRuntime/Services -> Rust canonical SQLite
                                             |
                                             +-> OpenAI / compatible API
```

存储切换边界单独遵循“一次性导入、单一写入所有者”：

```text
Python app/runtime
        |
        v
legacy Python SQLite（冻结前的生产源）
        |
        | one-time semantic import（只读 source）
        v
Rust canonical SQLite（全新 target）
        |
        | cutover 后唯一生产写入者
        v
Rust runtime/service/UI
```

迁移期间禁止让 Python 和 Rust 同时写同一份生产数据库。导入前停止所有可能打开 source/target 的应用连接；写路径切换前，应在隔离数据库上完成契约、事务、导入 counts 和回归对比；切换时只保留一个写入所有者。

## 4. 阶段与验收门槛

### R0：Rust workspace 与确定性领域核心（已完成）

代码位置：`rust/work-memory-core/`

已迁移：

- `BucketType`、`BucketStatus`、`ClassificationAction`。
- `BucketView` 与 `ClassificationResult` 的核心校验和字符串归一化。
- 当前焦点优先、按最近活跃时间排序、去重和候选上限。
- 服务端候选 ID 校验。
- 多候选、置信度和低信息模糊指代门控。
- 空工作区允许有效 `create_new` 启动首个 Bucket 的规则。

验收命令：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pytest -q
```

R0 阶段限制：尚未接入 Python 生产路径；JSON 反序列化已在 R1 补齐，数据库和 LLM 调用仍未迁移。

### R1：跨语言契约与固定样例一致性（已完成）

代码位置：`rust/work-memory-contracts/`、`rust/work-memory-core/src/memory.rs`、`tests/fixtures/contract_cases.json`。

已迁移：

- 为分类、提取、归档、Bucket 视图、搜索结果、聊天消息和 Agent turn 增加严格 JSON adapter。
- Rust adapter 使用 `deny_unknown_fields`，并保持 Pydantic 对普通字符串、可选字符串、字符串列表、枚举和时间戳的既有边界行为。
- 迁移 `ExtractionResult`、`BucketSummaryResult`、`ArchiveResult` 领域类型，以及六个受控 Agent 工具的参数契约。
- Python 工具执行入口在调用业务函数前使用严格 Pydantic Schema 校验，未知字段、缺少必填参数和非法 Bucket 类型不会进入执行层。
- Python 与 Rust 共同读取 `tests/fixtures/contract_cases.json`；valid 案例比较规范化 JSON，invalid 案例验证拒绝行为。
- golden fixture 覆盖分类、提取、Bucket 摘要、归档、Bucket 视图、聊天消息、Agent turn、搜索结果和工具参数。

验收命令：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
pytest -q
```

限制：R1 只建立无 I/O 领域类型和 JSON 边界的一致性，Rust 尚未接入 SQLite、LLM 或 Python 生产调用链，也不会读写当前 `work_memory.db`。

### R2：Rust canonical SQLite、legacy semantic import 与兼容机制（实现已完成；operational cutover 待完成）

R2 的长期目标不是让 Rust 继续读写 Python 的九张业务表，而是建立一套由 Rust 拥有的 canonical SQLite，并把旧 Python 数据一次性语义导入进去。旧九表的读取、`adopt_python_schema_v1` 基线、备份/恢复和强类型写 API 仍保留为 legacy compatibility 与隔离回归边界；它们不代表 canonical 的长期生产 Schema 或写入目标。

#### R2 canonical schema

Rust canonical 数据库由 `RustStore::initialize` 创建，由 `RustStore::open_existing` / `RustStore::open_read_only` 验证。canonical marker 固定为：

```text
schema kind:     rust-work-memory
schema version:  1
migration:       create_rust_memory_schema_v1
```

元数据表为 `rust_schema_meta` 和 `rust_schema_migrations`；业务表只有以下七张：

```text
buckets
entries
bucket_tags
memory_items
archive_attempts
corrections
conversation_messages
```

关键聚合边界如下：

- `buckets` 保存 Bucket 的 `kind`、`lifecycle`、摘要和时间；`bucket_tags(bucket_id, tag, position)` 单独保存标签及其顺序。
- `entries` 保存不可丢失的原始 Entry、摘要、分类置信度/原因、归属 Bucket、移动来源和归档状态。
- `memory_items` 统一保存 `todo`、`evidence`、`timeline`、`decision`、`hypothesis`、`entity`、`tag` 七类结构化记忆；`entry_id` 可因独立 Entry 删除而为 NULL。
- `memory_items.occurred_at` 保持文本，不把 `timeline_events.event_time` 强制解析成标准时间，以免丢失“刚才”等用户原始表达。
- `archive_attempts` 保存每次分类/归档尝试及候选、focus、Prompt/model、确认状态和纠错状态；`ask_user` 是待确认的审计记录，不创建正式 Entry。
- `corrections` 保存纠错命令和前后快照；`conversation_messages` 保存单一长期对话，并以 canonical `sequence` 表示顺序。

canonical store 不暴露 Python SQLAlchemy schema 的裸可写连接或任意 SQL。canonical 的 Rust 读写 API、搜索排序和字段边界是独立契约；Python 九表兼容路径只用于迁移前验证、隔离测试和 legacy 备份/恢复。

#### R2 one-time semantic import

入口是 `RustStore::import_legacy_database(source, target)` 或离线命令：

```bash
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  import-legacy PYTHON_DB RUST_DB
```

导入器先以 SQLite `READ_ONLY`、`query_only` 和 `foreign_keys` 打开 Python source，在 target 创建或验证 canonical schema，然后在 target 的单一 `BEGIN IMMEDIATE` 事务中按下面的语义映射写入。source 从头到尾不被修改，source ID 尽可能保留。

| Python legacy source | Rust canonical target | 语义与限制 |
|---|---|---|
| `buckets` | `buckets` + `bucket_tags` | 保留 Bucket ID、类型、状态、摘要、时间和标签顺序；原始标签 JSON 作为导入 provenance 保存在 `metadata_json`。 |
| `entries` | `entries` | 保留原文、摘要、分类置信度/原因、Bucket 归属、`moved_from_bucket_id` 和 Entry ID。 |
| `todos` | `memory_items(kind = todo)` | 保留 status、due date、关联 Entry 和来源 ID。 |
| `evidences` | `memory_items(kind = evidence)` | 保留 source、关联 Entry 和来源 ID。 |
| `timeline_events` | `memory_items(kind = timeline)` | `event_time` 原样写入文本 `occurred_at`，包括“刚才”等表达式。 |
| `decisions` | `memory_items(kind = decision)` | 保留 reason、关联 Entry 和来源 ID。 |
| `classification_records` | `archive_attempts` | `ask_user` 映射为待确认状态且不创建 Entry；已归档记录保留审计字段。Python 没有 question 字段时 canonical `question` 为 NULL。 |
| `corrections` | `corrections` | 保留纠错前后 JSON 快照、审计字段和来源 ID。 |
| `chat_messages` | `conversation_messages` | 按 `created_at ASC, id ASC` 重新生成连续 `sequence`，保留角色、工具元数据和 details JSON。 |

迁移会明确标记下列**推断值**：Python legacy 没有 canonical 生命周期时间字段，因此 archived Bucket 的 `archived_at` 取 legacy `updated_at`；导入的 Entry 统一视为已归档，`archive_state` 为 `archived` 且 `archived_at` 取 Entry `created_at`；已纠正的分类审计记录将 `resolved_at` 取其 `created_at`。这些值表达的是迁移时可复原的语义，不是 Python 中实际记录的独立事件时间。

Python source 只有 todo/evidence/timeline/decision 四类结构化子表，因此导入不能凭空恢复历史上从未落盘的 `hypothesis`、`entity` 或 `tag`。旧 `classification_records.bucket_id` 不是可靠外键；若对应 Bucket 无法解析，canonical `archive_attempts.bucket_id` 写为 NULL，但候选 JSON、focus ID 和其余审计数据仍保留。

导入前必须满足：source 与 target 路径不同；source 是可验证的 legacy Python 九表数据库；target 不存在或没有任何非 SQLite 内部对象和业务 rows。一个此前失败导入留下的、已回滚业务 rows 的空 canonical schema 可以重试；有业务 rows 的 target 不得追加导入。导入完成后至少核对各表 counts、固定 source ID、Entry 原文、Bucket 标签顺序、Timeline 原始时间表达式、`ask_user` 状态、Correction JSON 和 Chat sequence。

任意坏 Schema、非法枚举/JSON/时间戳、外键或目标关系错误都会在提交前失败；导入事务回滚，不留下部分业务 rows。canonical DDL 可能作为空壳保留，不能把“目标文件存在”视为导入成功。修复 source 后可复用这个空壳，或改用新的空 target 重试；成功后 source/备份冻结，不能再把 Python 写入路径接回 canonical DB。

下列 R2a-R2o 继续记录 Python 九表兼容边界的实现和 Python/Rust 隔离回归；其中的 `SqliteStore`/`WritableSqliteStore`、`migrate_database` 与 `restore_database` 不改变上述 canonical 目标，也不构成生产 cutover。

R2a 只读基础已完成，代码位置为 `rust/work-memory-store/`：

- 使用 SQLite `READ_ONLY` 打开标志和 `query_only` 防护，不创建数据库、不提供写接口。
- 打开时校验 `buckets`、`entries` 表及当前查询所需全部列，区分 SQLite 错误、缺表、缺列、非法枚举、非法 JSON、非法时间戳和非法 limit。
- 强类型读取 Bucket/Entry；`tags` 解码为字符串数组，Bucket type/status 映射到核心枚举。
- `list_active_buckets` 保持 Python 的 `active` 过滤以及 `last_active_at DESC, updated_at DESC` 排序；Entry 按 `created_at ASC` 读取。
- `tests/fixtures/create_sqlite_compat_fixture.py` 只在临时路径创建固定 Python 数据库；Rust 集成测试验证 Schema、排序、过滤、字段、JSON 标签、SQLAlchemy 时间文本和只读配置。

R2b legacy migration 安全基础已完成（只针对 Python 九表兼容库）：

- 完整验证 Python 九张业务表的必需列、`id` 主键、显式索引列顺序、外键目标及 `CASCADE` / `SET NULL` 声明，并执行 `quick_check` 与 `foreign_key_check`。
- 识别无 migration 表的 `LegacyPython` Schema，以及连续且受支持的 `Versioned(1)` history；version 1 使用 `adopt_python_schema_v1` 基线登记，不重建业务表。
- `migrate_database` 在 `BEGIN IMMEDIATE` 写者保留锁下，通过独立只读连接和 SQLite Online Backup API 保存一致快照，验证备份后才在同一事务登记 version 1；重复升级不创建备份、不修改数据库。
- `restore_database` 先验证恢复源，再保存目标 safety backup；恢复后重新验证，失败时尝试自动恢复 safety backup。
- 提供 `work-memory-store-admin` 的 `inspect`、`migrate`、`restore` 离线命令；备份路径使用 create-new 语义，数据库、备份和 safety backup 路径必须互异。
- `migrate_database` 的 `adopt_python_schema_v1` 只是在旧 source 上登记兼容基线，不会把旧库转换成 canonical schema；canonical 路径必须使用 `init`/`import-legacy`/`inspect-rust`。
- Python fixture 已覆盖九表固定数据；跨语言测试比较升级前后全部业务 Schema 与行值，并覆盖升级、幂等、恢复、反向恢复、坏索引、坏外键、未来版本和已有备份拒绝。
- 操作说明见 `docs/SQLITE_MIGRATIONS.md`。命令执行前仍必须停止所有应用数据库连接。

R2c 完整强类型只读仓储已完成：

- `SqliteStore::open_read_only` 现在校验全部九张业务表及读取所需列，仍使用 SQLite `READ_ONLY` 和 `query_only` 双重只读防护。
- 新增 Todo、Evidence、TimelineEvent、Decision、ClassificationRecord、Correction、ChatMessage 的公开强类型记录与主键查询；Bucket 子记录、Entry 分类审计、目标纠错审计和最近聊天窗口均有专用查询 API。
- Todo status、分类 action、Chat role 分别映射为受控 Rust 枚举；分类 action 复用 `work-memory-core::ClassificationAction`，Chat role 复用 `work-memory-contracts::ChatRole`。
- `candidate_bucket_ids` 严格解码为字符串数组；Correction 快照和 Chat details 只接受 object、array 或 null；SQLite bool 只接受 0/1，所有 datetime 字段使用统一时间解码。
- Bucket 子记录保持 Python relationship 的 `created_at ASC`；最近聊天窗口保持 Python 的 `created_at DESC, id DESC` 截断后再反转为展示顺序。
- 跨语言 fixture 覆盖九表字段、可选值、枚举、JSON、布尔值和排序；损坏数据测试覆盖非法 Todo status、分类 action/candidate JSON/bool、Chat role、JSON 类型和时间戳。

R2d 可写事务基础已完成：

- 新增独立的 `WritableSqliteStore::open_existing`；它只以 `READ_WRITE` 打开已存在文件，不会隐式创建数据库，也不会削弱 `SqliteStore` 的只读保证。
- 可写 store 在返回前启用并验证 `PRAGMA foreign_keys=ON`，检查受支持的 migration history，并对九表执行完整列、主键、索引、外键和完整性验证。
- crate 内部事务边界使用 `BEGIN IMMEDIATE`；操作成功才 commit，任一步返回错误都显式 rollback。
- 打开时记录 SQLite `schema_version`，每次事务前重新检查连接保护、migration history 和 Schema 版本；已验证后发生 Schema 变化时拒绝写入。
- 隔离临时数据库测试覆盖成功 commit、外键失败导致完整 rollback、坏 Schema 在写前拒绝，以及验证后 Schema 漂移拒绝。
- 原始事务执行入口保持 crate-private，应用调用方只能通过受控的强类型业务写 API 进入事务；这些 API 仍只服务于 legacy 隔离回归，cutover 前 legacy 生产数据库仍只有 Python 可以写。

R2e 强类型归档聚合写 API 已完成：

- 新增 `ClassificationAuditContext`、`ArchiveWriteRequest`、`ArchiveWriteOutcome` 和 `WritableSqliteStore::persist_archive_attempt`；调用方不能获得裸可写连接或任意 SQL 闭包。
- `ask_user` 只保存 ClassificationRecord；`append_existing` 原子保存 Entry、结构化子记录、Bucket 缓存和关联审计；`create_new` 在同一事务创建 Bucket 并完成完整归档。
- 保持 Python 的默认值、候选顺序、Unicode casefold 标签/文本匹配、仅针对事务前已有子记录去重，以及 1200 字符滚动摘要规则。
- 在 Store operation 执行期间由 `uuid` crate 生成 UUID v4，并在同一 SQLite 事务内写入兼容 SQLAlchemy 读取层的 UTC 文本时间；提交结果返回全部新建 ID。
- 临时数据库测试覆盖 append/create/ask_user、缺失 Bucket、触发器在子记录写入中途失败后的完整回滚。
- `tests/fixtures/apply_archive_write_fixture.py` 使用 mock extractor 调用 Python `archive_confirmed_input`；Rust 对相同初始数据库执行同一归档后，比较忽略随机 ID 和实际时间的最终业务语义。

R2f 强类型 Entry 移动纠错 API 已完成：

- 新增 `MoveEntryRequest`、`MoveEntryOutcome` 和 `WritableSqliteStore::move_entry`；请求构造器裁剪并拒绝空纠错命令，原始可写事务仍不向调用方公开。
- 同一事务更新 Entry 的目标 Bucket 和 `moved_from_bucket_id`，同步移动 Todo/Evidence/TimelineEvent/Decision，保存 Correction 前后快照，并把全部关联 ClassificationRecord 标记为已纠错。
- 来源和目标 Bucket 的活跃时间一起更新；随后按 Python 规则分别从最多八条存活 Entry summary 重建摘要、精确去重并限制为 1200 个字符。
- 缺失 Entry、缺失目标 Bucket 和移动到当前 Bucket 均在业务修改前返回类型化错误；目标摘要更新触发器制造的晚期失败会回滚 Entry、子记录、Bucket、分类审计和 Correction。
- `tests/fixtures/apply_correction_write_fixture.py` 调用 Python `move_entry`；Rust 对相同初始数据库执行同一纠错后，比较忽略随机 Correction UUID 和实际时间的最终业务语义。

R2g 强类型 ChatMessage 追加 API 已完成：

- 新增 `ChatMessageWriteRequest` 和 `WritableSqliteStore::append_chat_message`；角色使用 `ChatRole`，内容按 Python 规则 trim 并拒绝空值，可选工具元数据保持原值。
- details 只接受 object、array 或 null；null 写为 SQL NULL，而读取层把 SQL NULL 与 Python JSON `null` 都规范化为无 details。
- 每次调用只在独立事务中追加一条消息，由 `uuid` crate 生成 UUID v4，并保证时间戳严格晚于当前最新消息，以稳定保持最近窗口的追加/展示顺序；当前没有引入完整 Agent turn 事务。
- 临时数据库测试覆盖三种角色、字段保持、校验前拒绝、单表单行影响、连续追加顺序和触发器失败全回滚。
- `tests/fixtures/apply_chat_write_fixture.py` 调用 Python `add_chat_message`；Rust 对相同初始数据库追加同一 user/tool/assistant 序列后，比较忽略随机 ID 和实际时间的最终消息语义。

R2h 受控 Bucket 聚合删除 API 已完成：

- 新增 `DeleteBucketRequest`、`DeleteBucketOutcome` 和 `WritableSqliteStore::delete_bucket`；请求保留精确 Bucket ID，缺失 Bucket 在产生业务修改前返回类型化错误，调用方仍不能获得裸连接或任意 SQL 闭包。
- 同一事务删除 Bucket，并依赖现有 Python Schema 级联删除其 Entry 和 Bucket 自有 Todo/Evidence/TimelineEvent/Decision；结果返回各类被删 ID，以及因 Entry 删除而清空外键的 ClassificationRecord ID。
- 关联 `classification_records.entry_id` 设为 NULL，但非外键的 `classification_records.bucket_id` 和其他审计字段保持不变；Correction 与 ChatMessage 不受影响。
- 其他 Bucket 中引用被删 Entry 的四类结构化记录继续存在且 `entry_id` 设为 NULL；对存活 Todo 同时刷新 `updated_at`，匹配 SQLAlchemy `onupdate=utc_now` 行为。
- 临时数据库测试覆盖聚合删除、跨 Bucket 引用、缺失 Bucket、晚期触发器失败全回滚。由于当前没有产品级 Python Bucket 删除服务，`tests/fixtures/apply_bucket_delete_fixture.py` 直接调用 SQLAlchemy `session.delete(bucket)`，用于验证模型级最终业务状态等价。

R2i 受控独立 Entry 删除 API 已完成：

- 新增 `DeleteEntryRequest`、`DeleteEntryOutcome` 和 `WritableSqliteStore::delete_entry`；请求保留精确 Entry ID，缺失 Entry 在业务修改前返回类型化错误，结果报告原 Bucket 及全部被清空链接的记录 ID。
- 事务只删除 Entry；所有同 Bucket 或跨 Bucket 的 Todo/Evidence/TimelineEvent/Decision 都保留并清空 `entry_id`，ClassificationRecord 也只清空 Entry 外键，非外键 Bucket 引用与审计内容不变。
- 所有受影响 Todo 刷新 `updated_at`；Bucket summary、更新时间和活跃时间不重建，Correction 与 ChatMessage 不受影响，匹配直接 SQLAlchemy 模型删除。
- 临时数据库测试覆盖同/跨 Bucket 链接、精确 ID、缺失记录、Entry 删除触发器造成的晚期全事务回滚，以及 `tests/fixtures/apply_entry_delete_fixture.py` 驱动的模型级 Python/Rust 最终状态等价。

R2j 强类型独立 Bucket 创建 API 已完成：

- 新增 `CreateBucketRequest` 和 `WritableSqliteStore::create_bucket`；Bucket 类型使用核心强类型，标题 trim 后不能为空，摘要 trim，标签逐项 trim、丢弃空项并保留顺序与重复值。
- 每次调用在统一事务内由 `uuid` crate 生成 UUID v4，并写入 SQLite 兼容时间，只创建一个 active Bucket 并返回完整 `StoredBucket`，不附带 Entry、结构化记录或审计记录。
- 临时数据库测试覆盖请求规范化、单行影响、无关联行副作用和插入触发器失败全回滚；`tests/fixtures/apply_bucket_create_fixture.py` 调用 Python `create_bucket`，用于比较忽略随机 ID 和运行时时间后的服务级最终语义。

R2k 强类型独立 Entry 追加 API 已完成：

- 新增 `AppendEntryRequest` 和 `WritableSqliteStore::append_entry`；请求保留精确 Bucket ID，raw text 与 content type trim 后不能为空，置信度限制为有限的 0 到 1。
- 可选 summary 和 classification reason 匹配 Python 字符串真值/trim 边界；事务只生成并插入一条 Entry，再把 Bucket 更新时间和活跃时间设为 Entry 创建时间，不修改 Bucket 摘要、标签、状态或任何派生/审计记录。
- 缺失 Bucket 在写前返回类型化错误；临时数据库测试覆盖规范化、单行影响、精确 ID、缺失目标和晚期 Bucket 更新时间触发器造成的 Entry 插入全回滚。`tests/fixtures/apply_entry_append_fixture.py` 调用 Python `append_entry`，用于比较服务级最终语义。

R2l 强类型独立 Bucket 滚动摘要更新 API 已完成：

- 新增 `UpdateBucketSummaryRequest` 和 `WritableSqliteStore::update_bucket_summary`；请求保留精确 Bucket ID，摘要片段 trim 后不能为空，默认上限为 1200 字符，自定义上限至少为 100。
- 复用归档写路径已验证的 Python 兼容滚动摘要规则：按换行清理片段、使用 Unicode casefold 和空白折叠去重、超限时保留首段与最新事实，并按 Unicode 字符数截断加省略号。
- 事务只更新目标 Bucket 的 `summary` 与 `updated_at`，不刷新 `last_active_at`，也不修改标题、类型、状态、标签、Entry、结构化记录或审计记录；缺失目标和更新触发器失败均不留下业务修改。
- `tests/fixtures/apply_bucket_summary_update_fixture.py` 调用 Python `update_bucket_summary`；临时数据库测试覆盖默认/自定义上限、规范化去重、精确 ID、缺失目标、失败回滚和服务级最终语义等价。

R2m 强类型独立 Bucket 摘要重建 API 已完成：

- 新增 `RebuildBucketSummaryRequest` 和 `WritableSqliteStore::rebuild_bucket_summary`；请求保留精确 Bucket ID，默认读取八条 Entry 并限制为 1200 个字符，`max_entries < 1` 在查询 Bucket 前返回类型化错误。
- 保持 Python 的选择顺序：只选非 NULL summary，按 `created_at DESC` 截取最新窗口；空或纯空白 summary 仍占用 SQL limit，随后才 trim、丢弃空值、恢复时间正序并按清理后的精确文本做区分大小写去重。
- 当前 Python 未校验 `max_chars`，Rust 因而保留零值与负值的既有切片/省略号结果；无可用片段时把 Bucket summary 清空。
- 事务只更新目标 Bucket 的 `summary` 与 `updated_at`，不刷新 `last_active_at`，也不修改标签、Entry、结构化记录或审计记录；缺失目标和更新触发器失败均不留下业务修改。纠错写路径复用同一重建实现。
- `tests/fixtures/apply_bucket_summary_rebuild_fixture.py` 调用 Python `rebuild_bucket_summary`；临时数据库测试覆盖窗口选择、limit 后过滤、顺序恢复、精确去重、非正字符上限、精确/缺失 ID、缓存字段隔离、失败回滚和服务级最终语义等价。


R2n 强类型独立提取结果保存 API 已完成：

- 新增 `SaveExtractionRequest`、`SaveExtractionOutcome` 和 `WritableSqliteStore::save_extraction`；请求保留精确 Bucket/Entry ID，并接收已验证的核心 `ExtractionResult`。
- 事务按 Python 顺序先验证 Bucket，再验证 Entry 存在且属于目标 Bucket；缺失和归属不匹配均在业务修改前返回类型化错误。
- 复用归档写路径的结构化记录去重与插入规则：只对事务前已有 Todo/Evidence/TimelineEvent/Decision 去重，保留同批规范化重复项；Evidence source、Todo 默认值、Decision reason 与 Python 一致，hypotheses/entities 不落库。
- 同一事务更新 Entry summary、合并 Bucket 标签并刷新 1200 字符滚动摘要与 `updated_at`，不刷新 `last_active_at`，也不修改 Entry 其他字段或分类、纠错、聊天审计；晚期 Bucket 更新失败会回滚全部子记录与 Entry 变化。
- `tests/fixtures/apply_save_extraction_fixture.py` 调用 Python `save_extraction`；临时数据库测试覆盖精确 ID、验证顺序、归属错误、既有记录去重、批内规范化重复保留、重复调用、缓存字段隔离、失败回滚和服务级最终语义等价。

R2o 强类型独立分类审计保存 API 已完成：

- 新增 `SaveClassificationRecordRequest`、`SaveClassificationRecordOutcome` 和 `WritableSqliteStore::save_classification_record`；请求接收已验证的核心 `ClassificationResult` 以及调用方已解析的候选、焦点、Prompt 版本和模型元数据。
- 保持 Python `save_classification_record` 边界：只 trim 原始输入且允许空审计文本，服务端元数据保持精确值；SQLite Store 不读取模型环境配置，调用方必须先解析最终模型名。
- 候选列表按服务端在前、模型结果在后做大小写敏感的精确保序去重；`bucket_id` 直接取分类结果而不检查目标存在性（create_new 必为 NULL，ask_user 保留已验证结果中的可选值），`entry_id` 为 NULL，`corrected=false`。
- 每次调用只新增一条 UUID v4 分类审计，重复调用不去重；事务失败不留下记录，也不修改其他八张业务表。独立 API 与归档聚合路径共用候选合并和审计插入实现。
- `tests/fixtures/apply_save_classification_fixture.py` 调用 Python `save_classification_record`；临时数据库测试覆盖精确元数据、全部 action、空输入、重复审计、缺失审计目标、单表影响、失败回滚和服务级最终语义等价。

R2 的兼容实现不属于 canonical 长期生产写路径；剩余范围：

- 迁移其他剩余 CRUD 写语义，并补齐对应跨语言等价测试。
- 当前 R2a-R2o 已完成的全部独立写 API 均已在 R3c-R3i 形成服务边界；legacy Python Agent/UI 仍可调用 Python service，canonical runtime 不调用 legacy schema writer。
- 在完成 source 备份、semantic import、核验和 operational cutover 前，Python 仍可能是旧 legacy DB 的生产写入者；Rust canonical DB 不与其双写。

R2a-R2o 当前验收：Rust 可以强类型只读读取 Python 创建的完整九表临时数据库，在临时隔离副本完成 legacy version 1 升级、备份和恢复，并以受控强类型事务 API 完成归档、Entry 移动纠错、单条 ChatMessage 追加、Bucket 聚合删除、独立 Entry 删除、独立 Bucket 创建、独立 Entry 追加、独立 Bucket 滚动摘要更新、独立 Bucket 摘要重建、独立提取结果保存和独立分类审计保存及 Python/Rust 最终状态等价演练；canonical schema 的初始化、一次性语义导入、失败回滚、空 target 重试和导入后 counts/内容核验另按本节 R2 canonical 规则验收。测试不会打开或修改仓库根目录的 `work_memory.db`。完整 R2 验收仍要求其余写语义、服务层集成和生产切换准备完成。

### R3：归档、搜索、纠错、基础变更、摘要、提取、分类审计与聊天持久化服务（实现已完成；hardening/cutover 待完成）

R3a-R3i Bucket 查询、搜索、归档、纠错、基础变更、摘要缓存、独立提取保存、分类审计保存与聊天持久化服务边界已完成：

- 创建 `rust/work-memory-service/` 并加入 Cargo workspace；`BucketQueryService` 只能由经验证的 `SqliteStore` 构造或直接打开只读数据库，不暴露 SQLite 连接和任意 SQL 执行入口。
- `list_active_buckets` 与 `get_bucket` 复用 R2c 强类型仓储，保持 Python 的 active 排序、limit 和精确 ID 语义。
- `get_bucket_detail` 组合 Bucket 与 Entry/Todo/Evidence/TimelineEvent/Decision，保持 Python relationship 顺序；缺失 Bucket 返回 `None`，不合成空详情。
- `tests/fixtures/export_bucket_query_fixture.py` 调用 Python `list_active_buckets`、`get_bucket` 和 `get_bucket_detail`；Rust 测试在同一临时数据库逐字段比较完整 JSON，并覆盖 limit、排序、缺失记录和全部详情集合。
- R3b `search_buckets` 保持 Python 查询 trim/空值与 limit 校验、SQLAlchemy LIKE 自动转义、`max(limit * 5, 50)` 候选窗口、Unicode casefold 评分、匹配 Entry 计数，以及 score/`last_active_at` 稳定降序排序。
- `tests/fixtures/create_bucket_search_fixture.py` 和 `export_bucket_search_fixture.py` 在 Python 创建的隔离数据库覆盖标题/摘要/标签/Entry、精确与包含评分、Unicode casefold、LIKE 通配符字面量、并列稳定顺序、结果 limit 和当前 JSON 标签序列化候选语义；Rust 逐字段比较完整搜索投影。
- R3c 新增 `ArchiveService`，只能由经验证的 `WritableSqliteStore` 构造或直接打开现有兼容数据库；服务不暴露可写连接和任意事务闭包。
- `archive_classified_input` 对已验证分类与可选提取执行输入 trim/空值和 action/extraction 一致性校验，再调用 R2e 原子归档事务；ask_user 只写审计，append/create 返回包含权威 Bucket 标题/类型的核心 `ArchiveResult`。
- `archive_confirmed_input` 和 `archive_confirmed_new_input` 复现 Python 的确认分类、候选/焦点、`classification-v2`、模型元数据和用户可见结果；提取结果仍由调用方提供，不在没有 R4 adapter 时伪造模型调用。
- `tests/fixtures/apply_archive_service_fixture.py`、`export_archive_service_fixture.py` 与 `rust/work-memory-service/tests/archive.rs` 覆盖确认追加、确认新建、ask_user、空输入、缺失/多余提取、缺失 Bucket 和失败无部分状态，并逐字段比较 Python/Rust 返回值与最终数据库语义。
- R3d 新增 `CorrectionService`，只能由经验证的 `WritableSqliteStore` 构造或打开现有兼容数据库；`move_entry` 接入显式 Entry/Bucket 聚合移动，`move_latest_entry` 支持显式目标 ID，或从最后一个“移到/放到”命令片段解析标题目标。
- 最新 Entry 选择、标题候选解析、聚合移动、两个 Bucket 摘要重建、分类审计修正和 Correction 快照写入保持同一 `BEGIN IMMEDIATE` 事务；标题查询复现 SQLAlchemy `contains(..., autoescape=True)`、精确标题优先和唯一模糊候选规则。
- `CorrectionResult` 返回事务权威的来源/目标 Bucket、移动的派生记录 ID 和已纠正审计 ID；`tests/fixtures/apply_correction_service_fixture.py`、`export_correction_service_fixture.py` 与 `rust/work-memory-service/tests/correction.rs` 覆盖指定/最近 Entry、显式/命令目标、最终目标优先、无匹配/多匹配/同 Bucket/空命令和失败无部分写入，并比较 Python/Rust 返回值与最终数据库语义。
- legacy-compatible R3 服务继续通过 Python-schema fixture 在隔离数据库验证；canonical wrappers 已通过 `CanonicalService`、`CanonicalRuntime` 和 `work-memory-server` 接入 Agent/UI 目标路径。剩余工作是 operational cutover、正式运营 hardening、请求幂等和跨步骤失败恢复；在切换完成前，Python 仍可能是旧 legacy DB 的生产写入者。
- R3e 新增 `MemoryMutationService`，把独立 Bucket 创建、Entry 追加、Entry 删除和 Bucket 聚合删除接入产品服务层；调用方直接提交领域参数，服务内部构造强类型 Store request，并返回权威 Bucket/Entry 或删除影响 ID。
- R3e 保持 Python 的文本/标签/可选字段/置信度规范化，以及删除时的 CASCADE、SET NULL、Todo `updated_at` 和 Bucket 缓存隔离语义；非法输入、缺失目标和事务失败不会留下部分写入。`apply_memory_mutation_service_fixture.py`、`export_memory_mutation_service_fixture.py` 与 Rust 集成测试比较四类操作的返回投影和最终数据库语义。
- R3f 新增 `BucketSummaryService`，把独立滚动摘要更新和摘要重建接入产品服务层；默认入口分别复用 Python 的 1200 字符上限以及八条 Entry/1200 字符上限，显式入口保留自定义限制，服务内部构造 R2l-R2m 强类型 request 并返回事务提交后的摘要文本。
- R3f 保持更新时 Unicode casefold/空白去重和首段/最新事实裁剪，以及重建时最新窗口、limit 后清理、时间正序恢复和精确去重；两条路径都只修改 Bucket `summary`/`updated_at`，不刷新 `last_active_at`。`apply_bucket_summary_service_fixture.py`、`export_bucket_summary_service_fixture.py` 与 Rust 集成测试比较返回摘要和排除运行时 `updated_at` 后的九表最终语义。
- R3g 新增 `ExtractionPersistenceService`，把 R2n 独立提取保存接入产品服务层；调用方只提交精确 Bucket/Entry ID 和已验证的核心 `ExtractionResult`，服务内部构造 `SaveExtractionRequest`，不暴露 Store request、连接、SQL 或事务闭包。
- `ExtractionSaveResult` 返回提交后的 Bucket/Entry ID 与本次新增的 Todo/Evidence/TimelineEvent/Decision ID。Store 继续负责精确目标归属校验、既有记录去重、Entry summary、Bucket tags/滚动摘要更新和全事务回滚，并保持 `last_active_at` 不变。`apply_extraction_persistence_service_fixture.py`、`export_extraction_persistence_service_fixture.py` 与 Rust 集成测试比较首次/重复/最小保存结果、无效目标无修改和排除随机子记录 ID/运行时更新时间后的九表最终语义。
- R3h 新增 `ClassificationAuditService`，把 R2o 独立分类审计保存接入产品服务层；调用方提交原始输入、已验证 `ClassificationResult`、服务端候选、焦点、Prompt 版本和已解析模型名，服务内部构造 `SaveClassificationRecordRequest`，不暴露 Store request/outcome、连接、SQL 或事务闭包。
- `ClassificationAuditSaveResult` 只返回事务生成的分类审计 UUID。Store 保持原始输入 trim 且允许空值、服务端/模型候选精确保序合并、三种 action、未校验审计目标、精确元数据、重复审计和单表事务语义。`apply_classification_audit_service_fixture.py`、`export_classification_audit_service_fixture.py` 与 Rust 集成测试比较重复 append、create/ask、插入失败及排除随机审计 ID/时间后的九表最终语义。
- R3i 新增 `ChatMessagePersistenceService`，把 R2g 单条聊天消息追加接入产品服务层；调用方直接提交 `ChatRole`、内容、可选工具元数据与 object/array/null details，服务内部构造 `ChatMessageWriteRequest`，不暴露 Store request、连接、SQL 或事务闭包。
- `ChatMessageSaveResult` 返回 UUID、角色、内容、工具元数据、details 和时间；返回工具字符串按 Python `ChatMessageView` 裁剪，而数据库继续精确保留调用方元数据。每次调用独立提交一条消息，Store 保持内容校验、JSON null 归一、UUID v4、严格递增时间顺序、重复追加和失败回滚。`apply_chat_message_service_fixture.py`、`export_chat_message_service_fixture.py` 与 Rust 集成测试比较三种角色、重复消息、null/非法 details、插入失败及排除随机消息 ID/时间后的九表最终语义。

R3 实现完成后的剩余范围：

- canonical runtime/server 已提供稳定的详情、搜索、归档、纠错、状态变更和聊天投影；后续只在明确产品需求时定义新的编辑或跨操作事务，不提前虚构接口。
- canonical runtime 已把候选加载、分类、风险门控、提取和 R3c 写服务接成完整 archive/tool 闭环；后续补充跨步骤事务、请求幂等和工具副作用后的恢复边界。
- 当前 R2a-R2o 已完成的独立写能力均已有 R3c-R3i 服务编排；legacy 兼容服务仍只承担迁移/回归职责，canonical 长期写路径不回退到 legacy schema writer。
- 使用同一输入和隔离数据库对比 Python/Rust 最终状态。

验收：正常、确认、失败回滚和纠错场景均达到数据库状态等价；legacy 兼容写路径继续只在隔离库验证，canonical runtime/server 在 Rust canonical DB 上验证。完成一次性导入并切换到 canonical DB 后，Rust 才能成为生产写入的唯一所有者，随后才移除对应 Python 业务逻辑。

### R4：LLM adapter 与 Agent Harness

R4a transport-independent Structured Outputs adapter core 已完成：

- 创建 `rust/work-memory-agent/` 并加入 Cargo workspace；R4a 不依赖 HTTP client，不读取环境变量或 API Key。
- `LlmEndpointConfig` 解析 official/custom site、规范化 Base URL，并支持 `responses`/`response` 与 `chat`/`chat_completions`/`chat-completions` aliases；官方站点固定使用 `https://api.openai.com/v1`，远程 custom URL 必须使用 HTTPS，本机 loopback 可使用 HTTP。
- `StructuredOutputContract` 为 `ClassificationContract`、`ExtractionContract` 和 `BucketSummaryContract` 暴露 schema name、strict JSON Schema 与现有 contract 反序列化入口；fixture 使用当前 Python OpenAI SDK 的 `to_strict_json_schema` 逐值比较三份 Schema。
- `StructuredOutputAdapter` 构造 Responses `text.format` 或 Chat Completions `response_format.json_schema` 请求，归一化 output text、refusal、incomplete/content filter、非法 JSON 和 contract error。
- 注入式 `StructuredOutputTransport` 让普通测试只使用 fake transport。网络错误、408/409/429、5xx 以及可恢复的输出错误执行有限重试；其他 4xx、refusal 和 content filter 不重试。

R4b 基于社区 crate 的真实 HTTP transport 已完成：

- `UreqStructuredOutputTransport` 复用 `ureq` `3.3.0` 的 `Agent`、rustls、JSON body、timeout 和 proxy 实现，不自写 HTTP/TLS/连接池/proxy 协议；crate MSRV 为 Rust 1.85，与本 workspace 保持一致，选型取舍和来源见 [`DECISIONS.md`](./DECISIONS.md) 的 ADR-007。
- `LlmHttpTransportConfig` 只承载 timeout/proxy mode 等非密钥配置，默认 timeout 为 30 秒；可显式关闭环境 proxy 以保证 loopback 测试确定性。`from_env` 只读取 `OPENAI_API_KEY`，不隐式读取 `.env`。
- 默认 `ureq` 配置读取 `ALL_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY` 及小写 aliases，并遵守 `NO_PROXY`；启用 `socks-proxy` 后，Python 当前的 `socks://` 语义由 crate 解析为 SOCKS5，不修改进程环境。
- 每次请求发送 JSON POST 和 `Authorization: Bearer <API_KEY>`，HTTP 4xx/5xx 映射为现有 `LlmTransportError::HttpStatus`；响应 body 由 crate JSON reader 解码，网络/timeout/非法 JSON 使用不包含 URL、body 或 key 的固定 transport error。
- API Key 存在 transport 私有字段，`Debug` 显式脱敏；R4b 由 R4d canonical runtime/server 使用，Python 仍只负责 legacy UI/兼容路径。

R4 验收：

- `rust/work-memory-agent/tests/structured_output.rs` 继续验证 request/schema/retry mock 回归；`tests/http_transport.rs` 使用 loopback mock server 验证 POST、Bearer header、JSON body、200、401、429、500、非法 JSON 和 timeout；R4c `tests/agent_harness.rs` 验证 Responses/Chat 工具循环、参数拒绝、错误回传和轮数上限。
- 普通测试不调用真实模型、不读取真实 API Key；真实模型验证仍保持独立命令，完整报告必须保留站点、模型、Prompt 版本和结构化结果，且密钥不能进入日志或 Git。

R4c Agent Harness 已提交并由 canonical runtime 接入：

- `rust/work-memory-agent/src/agent_harness.rs` 提供 Responses 与 Chat Completions 两种工具循环，固定六个 memory tool，工具参数先通过 `work-memory-contracts` 严格校验；未知工具、非法 JSON、未知字段和非法 Bucket type 不会进入执行器。
- 工具错误以 JSON 数据回传模型，工具轮数有上限；历史中的 `ChatRole::Tool` 暂不作为新的 provider turn 重放，memory context 以 `user` role 注入，避免低信任记忆获得 system 指令优先级。
- `wire_response.rs` 复用 `async-openai` 的 Responses/Chat wire 类型；Harness 只做应用级 continuation、allow-list 和错误策略，不重新定义完整 provider response model。
- `AgentToolExecutor` 仍保持调用方注入，但 `CanonicalAgentToolExecutor` 已在 `work-memory-runtime` 接到 `CanonicalService`；`CanonicalRuntime` 负责 user/history/tool/assistant 消息持久化，`work-memory-server` 提供 API/UI 入口。跨工具副作用、工具消息和 assistant 消息仍不是一个覆盖所有步骤的单一原子事务。

R4c/R4d 进入正式对外部署前的审查项：

- 明确并测试 redirect 的 host/scheme 安全策略，避免 endpoint 跳转泄露 prompt 或记忆上下文。
- 写操作幂等边界、请求重试去重和 Agent 工具副作用后的恢复策略仍需补齐；单轮 tool call 数、参数/输出/累计上下文大小、重复 call ID 和最大轮数已有硬限制。
- 收紧 Responses/Chat wire 状态、choice、role 和 function-call 完成态校验，并重新划分确定性错误与可重试错误。
- 继续补齐正式对外部署前的工具调用安全和资源边界；工具 metadata、provider schema 与参数契约已集中到 `work-memory-contracts::AGENT_TOOL_DEFINITIONS`，并有 Responses/Chat parity 测试。

R4 后续范围：

- 把分类/提取 Prompt、候选加载、风险门控和 R3c 写服务接成完整归档闭环（已由 R4d 完成，后续做语义回归和幂等增强）。
- 将 `AgentToolExecutor` 接到 R3 查询/归档/变更服务，并定义完整 turn 的聊天消息与工具审计事务（服务接线和消息持久化已完成；跨步骤原子性仍是后续增强项）。
- 复用分类与提取离线评估集，真实模型验证保持独立命令；完成上述安全边界后再考虑生产切换。

### R5：Rust API 与 UI 切换（R5a 已完成，R5b 待正式运营）

- `work-memory-server` 已提供本地 HTTP API、健康检查、清晰 JSON 错误响应和内嵌 Web UI，覆盖长期对话、Bucket 列表/搜索/详情、确认聊天和纠错/状态变更入口。
- `Server` 使用标准库单请求/单连接 HTTP 实现，默认只绑定 `127.0.0.1:8787`，请求体上限 1 MiB；当前仍是单用户、无认证 MVP，不应直接暴露公网。
- `cargo test -p work-memory-server` 已覆盖 health/UI、active/search/detail、无效 chat、纠错/状态路由 smoke；正式运营仍需认证、TLS、限流、端到端浏览器回归和请求幂等。
- Streamlit 仍保留为 legacy UI；它不是 Rust canonical DB 的长期生产写入入口。
- 在应用 cutover 前完成 Python source 备份/冻结、`import-legacy`、canonical counts/内容核验和隔离回归；Rust runtime/service/UI 只配置到 Rust canonical SQLite。
- cutover 时停止 Python/Streamlit 旧写路径；不能通过双写、原地改造或让 Python 继续写 canonical DB 来“渐进”完成存储切换。

验收：新部署的用户可见 MVP 流程可通过 Rust server/runtime 完成，不依赖 Python 业务 service；完成备份、导入、核验和 operational cutover 后，Rust canonical SQLite 是唯一生产写入目标；legacy Python/Streamlit 仅保留兼容和回归用途。

### R6：移除 Python 运行时

- 删除失去调用方的 Python 服务、SQLAlchemy 模型、Pydantic Schema 和 Streamlit UI。
- 将剩余固定样例与必要文档迁到 Rust 测试体系。
- 更新安装、运行、备份、恢复和发布文档。

最终验收：仓库的产品运行、测试和后续数据维护不再要求 Python；历史 Python SQLite 已经过备份并一次性语义导入 fresh Rust canonical SQLite，导入源作为冻结历史源/备份保留，生产运行和所有未来写入只使用 Rust canonical DB，不再对旧库执行泛化的原地 canonical migration。

## 5. 当前代码映射

| 能力 | 当前 Python 来源 | Rust 目标 | 状态 |
|---|---|---|---|
| 分类枚举与结果校验 | `app/schemas.py` | `work-memory-core::domain` | R0 已迁移核心部分 |
| 候选排序与风险门控 | `app/services/classify_service.py` | `work-memory-core::classification` | R0 已迁移 |
| JSON/Structured Outputs 契约 | `app/schemas.py`, `app/llm.py` | `work-memory-contracts` | R1 已完成 JSON 解析；R4a 增加与当前 Python OpenAI SDK 等价的三份 strict JSON Schema |
| Python legacy SQLite 模型、Session 与兼容边界 | `app/models.py`, `app/db.py` | `work-memory-store::{schema,migration,read,write}` | R2a/R2c 九表强类型只读仓储、R2b `adopt_python_schema_v1`/备份恢复、R2d-R2o 受控隔离写 API 已完成；这些能力只用于 legacy source 验证和 Python/Rust 语义对照，不是 canonical 长期生产 Schema |
| 一次性 legacy semantic import | `app/models.py`, `app/db.py`（导入源） | `work-memory-store::legacy_import` | `RustStore::import_legacy_database` / `work-memory-store-admin import-legacy` 已实现 source read-only、source/target distinct、空 target、ID 保留、语义映射、单事务提交/回滚、counts 核验和空壳重试边界 |
| Rust canonical SQLite Schema 与 store | Python 九表是 source，不是长期目标 | `work-memory-store::canonical_schema`, `work-memory-store::canonical` | `rust-work-memory` version 1 / `create_rust_memory_schema_v1`、七张 canonical 业务表、`RustStore::initialize/open_existing/open_read_only` 和 canonical 读写 API 已实现；只供 canonical service/runtime/server 长期写入，legacy API 只做兼容回归 |
| Bucket/Archive/Search/Correction/Chat | `app/services/` | `work-memory-service` + `work-memory-runtime` | R3a-R3i 服务编排与 R4d canonical runtime 已接入 Bucket 列表/详情/搜索、分类/提取/归档、确认保存、纠错、状态变更和 chat/tool/assistant 持久化 |
| LLM Structured Outputs adapter | `app/llm.py` | `work-memory-agent` | R4a core 与 R4b `ureq` HTTP/API Key/timeout/proxy 已完成，并由 `StructuredMemoryModel` 接入 canonical runtime |
| Agent Harness | `app/services/agent_service.py` | `work-memory-agent` + `work-memory-runtime` | R4c Harness 与 `CanonicalAgentToolExecutor` 已接 service/store；有界 turn 由 `CanonicalRuntime` 编排，普通测试使用 fake transport |
| Rust HTTP/UI | `ui/streamlit_app.py` | `rust/work-memory-server` | R5a 本地 API、health、内嵌 UI 和 route smoke 已完成；正式对外运营 hardening 与 operational cutover 待办 |

## 6. 目录约定

```text
Cargo.toml                         # Rust workspace
rust/work-memory-core/            # 无 I/O 的领域契约和确定性规则
rust/work-memory-contracts/       # R1 已完成：严格 JSON/API 契约
rust/work-memory-store/           # legacy 九表兼容读取/migration/隔离事务；canonical schema/store；一次性 legacy_import；归档/纠错/聊天/删除/Bucket/Entry/提取/分类审计/摘要写 API
rust/work-memory-service/         # R3a-R3i：canonical Bucket 查询/搜索、归档、纠错、基础变更、摘要缓存、提取/分类审计和聊天持久化 facade
rust/work-memory-agent/           # R4a-R4c Structured Outputs、ureq HTTP 和有界 Agent Harness
rust/work-memory-runtime/         # R4d：StructuredMemoryModel、canonical tool executor 和持久化 Agent turn
rust/work-memory-server/          # R5a：标准库 HTTP、health、API 路由和内嵌 Web UI
```

后续 crate 只有在进入对应阶段时才创建，避免提前搭建无人使用的骨架。

## 7. Git 与文档规则

- 每个阶段性提交只迁移一个清晰边界，并使用祈使句提交信息。
- 每次提交前同时运行受影响的 Rust 测试和现有 Python 回归。
- 行为、接口、Schema 或运行命令变化时，同步更新本文件、`README.md`、`ARCHITECTURE.md`、`DATA_MODEL.md` 或 `TEST_PLAN.md` 中受影响的部分。
- canonical Schema、legacy-to-canonical 字段映射、source/target 校验、导入事务/重试/回滚边界或 cutover 写入所有权变化时，必须同步更新 `DATA_MODEL.md`、`SQLITE_MIGRATIONS.md` 与本文件；不能只更新兼容层实现。
- 未完成切换的能力必须明确标注“仅基础实现”或“未接入生产路径”，不能把代码存在误写成重构完成。
