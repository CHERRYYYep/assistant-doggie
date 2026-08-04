# SQLite Migration、备份与恢复

> 状态日期：2026-08-04
> 当前实现：`work-memory-store` R2b 离线管理基础；尚未接管 Python 生产写路径。

## 1. 适用范围

本说明覆盖 Rust `work-memory-store` 对现有 Python SQLAlchemy SQLite 数据库提供的：

- 完整九表 Schema、索引、主键、外键和完整性检查；
- legacy Python Schema 到 migration version 1 的基线登记；
- migration 前一致性备份；
- 恢复前 safety backup 和失败后的自动回退；
- 离线管理员命令。

当前九张业务表为：

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

本阶段不会重建或改写这些业务表，也不会把 Rust 接入应用写请求。Python 仍是生产数据库的唯一写入者。

## 2. Schema 状态与 version 1

Rust 只接受两类已验证状态：

- `LegacyPython`：九张 Python 业务表完整，但不存在 `schema_migrations`；
- `Versioned(1)`：九张业务表完整，且 migration history 从 version 1 连续、名称和时间戳合法。

version 1 使用以下元数据表：

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
```

基线记录为：

```text
version = 1
name = adopt_python_schema_v1
```

这是一项“采用现有 Python Schema”的基线 migration：只在同一事务中创建 `schema_migrations` 并登记 version 1，不重建、不复制、不清空九张业务表。未知未来版本、空 history、非连续版本、错误 migration 名和缺少 `version` 主键都会被拒绝，Rust 不会猜测或降级打开。

## 3. 迁移前验证

`inspect`、`migrate` 和 `restore` 会按各自阶段验证：

1. 九张业务表及全部必需列存在；
2. 每张业务表的 `id` 主键正确；
3. SQLAlchemy 当前创建的显式索引存在，且索引列和顺序正确；
4. 外键目标及 `ON DELETE CASCADE` / `SET NULL` 行为声明正确；
5. `PRAGMA quick_check` 返回 `ok`；
6. `PRAGMA foreign_key_check` 不返回违规记录；
7. 如存在 `schema_migrations`，其表结构、连续 history、名称、时间戳和最高版本均受支持。

验证失败时不会创建 migration 记录。已有备份文件也不会被覆盖。

## 4. 管理命令

从仓库根目录运行：

```bash
cargo run -p work-memory-store --bin work-memory-store-admin -- \
  inspect /absolute/path/to/work_memory.db

cargo run -p work-memory-store --bin work-memory-store-admin -- \
  migrate /absolute/path/to/work_memory.db \
  /absolute/path/to/work_memory.before-v1.db

cargo run -p work-memory-store --bin work-memory-store-admin -- \
  restore /absolute/path/to/work_memory.db \
  /absolute/path/to/work_memory.before-v1.db \
  /absolute/path/to/work_memory.before-restore.db
```

三个路径必须指向不同位置。`migrate` 的备份路径和 `restore` 的 safety backup 路径必须尚不存在；工具使用 create-new 语义，绝不覆盖已有文件。

## 5. 安全迁移流程

在执行 `migrate` 前：

1. 停止 `python -m app.main`、Streamlit 和所有可能连接该数据库的 Python/Rust 进程；
2. 确认目标是预期数据库，先运行 `inspect`；
3. 选择同一受信任磁盘上的全新备份路径，并确认有足够空间；
4. 不要拿仓库内的开发数据库做演练，先在隔离副本验证完整流程。

`migrate` 内部流程：

1. 以 read-write existing 模式打开数据库，并启用外键检查和 5 秒 busy timeout；
2. 使用 `BEGIN IMMEDIATE` 占用写者资格，阻止迁移快照与其他写入竞争；
3. 验证当前 Schema；如已经是 version 1，则直接返回 `AlreadyCurrent`，不创建备份、不修改数据库；
4. 在写者保留锁存在期间，通过独立只读连接和 SQLite Online Backup API 创建一致性备份；
5. 重新检查备份的 Schema 状态与源状态一致；
6. 在原事务中登记 version 1，再执行完整性和 migration history 验证；
7. 验证成功后提交事务。

这里使用 SQLite Online Backup API，而不是对活动数据库执行普通文件复制，因此能够把 WAL 中已提交的状态纳入一致快照。即使如此，运维流程仍要求先停止应用，不能把锁和 timeout 当作在线迁移承诺。

如果 migration 在提交前失败，事务会回滚；本次新建的未采用备份会被清理。源业务表不会被 migration 代码重建。

## 6. 恢复流程

`restore` 会先完整验证恢复源，之后才接触目标数据库：

1. 验证恢复源是受支持的 `LegacyPython` 或 `Versioned(1)`；
2. 以 exclusive locking mode 打开目标并验证其当前状态；
3. 使用 SQLite Online Backup API 把目标当前状态保存到全新的 safety backup；
4. 将指定备份恢复到目标；
5. 再次验证完整 Schema、migration history 和数据库完整性；
6. 如恢复或验证失败，自动尝试用 safety backup 恢复原目标状态；
7. 如果自动回退也失败，返回同时包含 restore 与 rollback 原因的复合错误，必须停止使用该目标文件并进行人工恢复。

恢复成功后不会删除 safety backup。确认应用启动、读取和回归检查均正常后，再按既定保留策略归档或删除旧备份。

## 7. 推荐操作清单

### 升级

```text
[ ] 停止所有应用进程
[ ] 记录数据库绝对路径和文件大小
[ ] inspect 返回 legacy-python
[ ] 选择不存在的备份路径
[ ] migrate 返回 legacy-python -> version-1
[ ] inspect 返回 version-1 和 adopt_python_schema_v1
[ ] 运行 Rust/Python 回归或在隔离副本启动应用
[ ] 保留升级前备份
```

### 回退

```text
[ ] 停止所有应用进程
[ ] inspect 当前目标和准备恢复的备份
[ ] 选择不存在的 safety backup 路径
[ ] restore 返回预期状态变化
[ ] inspect 恢复后的目标
[ ] 验证业务数据和应用读取
[ ] 同时保留原备份与 safety backup，直到故障关闭
```

## 8. 自动化覆盖与限制

`rust/work-memory-store/tests/python_migration_compat.rs` 只在系统临时目录中：

- 调用 Python SQLAlchemy 创建九表固定数据库；
- 验证 legacy 识别、version 1 migration、重复 migration 幂等；
- 比较 migration 前后全部业务 Schema 和九表行值，并验证已提交 WAL 数据进入备份；
- 验证 legacy backup、恢复、safety backup 以及反向恢复；
- 验证缺索引、外键损坏、未来版本、错误 migration 主键、已有备份路径和无效恢复源会被拒绝。

自动化测试不会打开、复制、迁移或恢复仓库根目录的 `work_memory.db`。完整 R2 仍需实现其余七张表的强类型仓储、安全写事务和级联写入语义；在这些工作完成并正式切换所有权之前，Python 与 Rust 不得同时写同一个生产数据库。
