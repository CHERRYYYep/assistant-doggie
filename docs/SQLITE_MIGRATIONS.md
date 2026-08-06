# SQLite 迁移、备份与恢复

> 状态日期：2026-08-06
> 当前实现：旧 Python Schema 兼容管理、Rust canonical SQLite 一次性语义导入、CanonicalRuntime 和 work-memory-server 均已实现；现有部署仍需完成 operational cutover。

## 1. 两条不同的存储路径

仓库现在明确区分 **legacy Python SQLite** 与 **Rust canonical SQLite**。它们不是同一套长期 Schema，也不能让 Python 和 Rust 并发写同一个文件。

```text
旧 Python SQLite（冻结前的生产源）
        -- 一次性、只读、语义导入 -->
全新 Rust canonical SQLite
        -- cutover 后唯一生产写入者 -->
Rust store/service/runtime
```

### Legacy Python Schema

旧数据库的九张业务表为：

```text
buckets
entries
todos
evidences
timeline_events
decisions
classification_records
corrections
chat_messages
```

旧命令 `inspect`、`migrate`、`restore` 只适用于这套 Schema：

- `inspect` 检查 legacy Python Schema 或已登记的兼容 version 1；
- `migrate` 在源库中登记 `adopt_python_schema_v1`，并先创建一致性备份；它不把数据转换成 Rust canonical Schema；
- `restore` 验证并恢复 legacy Python 备份，使用 safety backup 做失败回退。

这些命令不是 canonical 数据迁移，也不会让 Rust 成为旧数据库的长期写入者。

### Rust canonical Schema

canonical 数据库由 `work-memory-store-admin init` 创建，标记为：

```text
schema_kind    = rust-work-memory
schema_version = 1
migration      = create_rust_memory_schema_v1
```

业务表为：

```text
buckets
entries
bucket_tags
memory_items
archive_attempts
corrections
conversation_messages
```

`rust_schema_meta` 和 `rust_schema_migrations` 是 canonical 元数据表，不是 Python 兼容 migration 表。canonical schema 使用 `memory_items.kind` 统一保存：

```text
todo | evidence | timeline | decision | hypothesis | entity | tag
```

canonical schema 与 Python 九表不保证搜索评分、排序或字符串边界完全相同；Rust canonical 服务拥有自己的读写和搜索契约。

## 2. 一次性语义导入

导入入口：

```bash
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  import-legacy /absolute/path/to/python.db \
  /absolute/path/to/rust-canonical.db
```

也可以先显式初始化目标，再检查：

```bash
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  init /absolute/path/to/rust-canonical.db

cargo run -p work-memory-store --bin work-memory-store-admin -- \
  inspect-rust /absolute/path/to/rust-canonical.db
```

导入前必须满足：

1. 停止 `python -m app.main`、Streamlit、Rust 服务和所有可能打开 source/target 的进程；
2. 先对 Python source 做独立、可恢复的文件备份，并在隔离副本上演练；
3. source 与 target 是不同路径，不能原地导入；
4. source 是可验证的 legacy Python 九表数据库；
5. target 不存在、是没有任何非 SQLite 内部对象的空 SQLite 文件，或是上一次失败导入留下的、Schema 完整且没有业务 rows 的 canonical 空壳；有业务 rows、未知对象或不完整 canonical marker 的 target 都会被拒绝；
6. 确认磁盘空间足够，并保留源库作为冻结历史源/备份。

导入器打开 source 时使用 SQLite read-only 与 `query_only`，不会修改 source。导入顺序和语义映射如下：

| Python legacy | Rust canonical | 说明 |
|---|---|---|
| `buckets` | `buckets` + `bucket_tags` | 保留 Bucket ID、类型、状态、摘要、时间和标签顺序；原始标签 JSON 放入 `metadata_json` 作为导入 provenance |
| `entries` | `entries` | 保留原文、摘要、分类置信度/原因、来源 Bucket 和 `moved_from_bucket_id`；保留 Entry ID |
| `todos` | `memory_items(kind = todo)` | 保留 status、due date 和来源 ID |
| `evidences` | `memory_items(kind = evidence)` | 保留 source 和来源 ID |
| `timeline_events` | `memory_items(kind = timeline)` | `event_time` 原样保存到 `occurred_at`，包括“刚才”等表达式 |
| `decisions` | `memory_items(kind = decision)` | 保留 reason 和来源 ID |
| `classification_records` | `archive_attempts` | `ask_user` 映射为 `needs_confirmation`；有 Entry 的记录映射为 `archived`；Python 没有 question 字段，因此 question 保持 NULL |
| `corrections` | `corrections` | 保留前后 JSON 快照、Unicode 和来源 ID |
| `chat_messages` | `conversation_messages` | 按 `created_at ASC, id ASC` 重建 canonical `sequence`，保留角色、工具元数据和 details JSON |

迁移中的生命周期时间是语义推断而非 Python 原始事件时间：archived Bucket 的 `archived_at` 取 legacy `updated_at`；每个导入 Entry 的 `archive_state` 为 `archived`，其 `archived_at` 取 Entry `created_at`；`classification_records.corrected = 1` 时，canonical `resolved_at` 取该记录的 `created_at`。

历史 Python 数据库只有四类结构化子表，因此导入不能凭空恢复未落盘的 `hypothesis`、`entity` 或 `tag` memory item。Bucket 标签仍会进入 canonical `bucket_tags`。

Python `classification_records.bucket_id` 在旧 Schema 中不一定是外键。若该 ID 在目标 Bucket 中无法解析，导入器将 canonical `archive_attempts.bucket_id` 写为 NULL，同时保留候选 JSON、focus ID 和其余原始审计字段；不会为了保留无效外键而破坏 canonical 数据库。

## 3. 事务、回滚与验证

source 预校验通过且 target 为空后，导入器初始化 canonical DDL，并在导入业务 rows 时使用单一 `BEGIN IMMEDIATE` 事务：

1. 先写 Bucket、标签和 Entry；
2. 再写 `memory_items`、`archive_attempts`、`corrections` 和聊天消息；
3. 所有外键、枚举、JSON、时间戳和目标关系在写入时验证；
4. 全部成功后一次性 commit。

任意一行失败、外键冲突、坏 JSON、非法状态或 commit 失败都会回滚导入事务，不留下部分业务 rows。目标文件本身可能保留空的 canonical schema（便于诊断和重试），不能把“目标文件存在”误认为导入成功；应以 `inspect-rust`、counts 和逐项业务核验为准。

建议至少核验：

```text
buckets=4
entries=3
memory_items=8
archive_attempts=2
corrections=2
chat_messages=3
```

并核对固定源 ID、Entry 原文、Timeline 时间表达式、Bucket 标签顺序、`ask_user` 状态、Correction JSON 和 Chat sequence。只有核验通过，才执行应用 cutover。

## 4. Cutover 与写入所有权

推荐顺序：

```text
1. 停止 Python/Streamlit，备份并冻结 Python DB。
2. 在隔离副本执行 import-legacy。
3. 用 inspect-rust、counts 和回归测试验证 Rust DB。
4. 将 Rust runtime/service/UI 配置到 Rust DB。
5. 启动 Rust runtime，确认健康检查、读写和备份策略。
6. 只保留 Rust 作为 canonical DB 的生产写入者。
```

在 cutover 完成前，Python 仍可作为旧数据库的生产运行路径，但 Rust 只能在隔离数据库或 canonical 目标上验证，不能与 Python 同时写同一生产文件。cutover 后不得让旧 Python 服务继续写 Rust canonical DB；Python 数据库保留为只读历史源或备份，直到完成既定保留周期。

## 5. Legacy 兼容命令与恢复

检查和旧 Schema 基线登记：

```bash
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  inspect /absolute/path/to/python.db

cargo run -p work-memory-store --bin work-memory-store-admin -- \
  migrate /absolute/path/to/python.db \
  /absolute/path/to/python.before-v1.db
```

旧库恢复：

```bash
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  restore /absolute/path/to/python.db \
  /absolute/path/to/python.before-v1.db \
  /absolute/path/to/python.before-restore.db
```

三个路径必须不同；输出备份和 safety backup 路径必须尚不存在，工具使用 create-new 语义，不覆盖已有文件。执行 `migrate` 或 `restore` 前仍必须停止所有数据库连接。canonical 数据库当前不使用 `schema_migrations/adopt_python_schema_v1`，不要对 canonical 文件运行旧 `migrate` 或 `restore`。

## 6. 自动化覆盖与限制

Rust 测试在系统临时目录覆盖：

- canonical marker/version、未知用户对象拒绝、legacy DB 不能直接作为 canonical 打开；
- `create_new`、`append_existing`、`ask_user`、七类 memory kind、canonical 搜索、Chat sequence、Entry move、Correction 快照和 archive corrected 状态；
- Python fixture 的完整语义导入、固定 ID/count、四类 legacy memory 映射、Timeline 时间表达式、审计/聊天 JSON、非空 target 拒绝和导入失败回滚；
- legacy `inspect`/`migrate`/`restore` 的 Schema、备份、外键、WAL、未来版本和失败恢复边界。

普通测试不调用真实 LLM，也不读取仓库根目录的 `work_memory.db`。Rust Agent、service、UI 已接到 Rust canonical DB；现有 Python 部署仍需完成 source 备份/冻结、`import-legacy`、counts/内容核验、配置切换和健康检查，生产运行路径与写入所有权的切换仍是独立的 operational cutover 任务。
