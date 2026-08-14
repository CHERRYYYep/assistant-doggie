# SQLite canonical 与历史导入

## 1. 两种 schema

产品运行时只使用 Doggie canonical schema，包含 schema metadata（表名 `rust_schema_meta` 为兼容旧库保留）、canonical Bucket/Entry/memory、归档审计、纠错和对话表。canonical 数据库由 `DoggieStore::initialize` 创建并由严格 schema 校验保护。

仓库仍保留 Rust 编写的离线兼容边界，用于读取旧版九表 schema、验证完整性并导入新库。它不是在线业务写路径，也不支持双写。

## 2. 导入流程

`doggie-storage-admin import-legacy LEGACY_DB DOGGIE_DB`：

1. 以 SQLite read-only、`query_only` 和外键检查打开源库；
2. 校验表、列、主键、索引、外键、迁移历史和完整性；
3. 要求目标库为空或是空的 Doggie canonical 数据库；
4. 在目标库一个 `BEGIN IMMEDIATE` 事务中映射 Bucket、Entry、memory item、审计、纠错和对话；
5. 保留可用的源 ID，并生成导入报告；
6. 任意语义或 SQLite 错误都回滚目标事务，源库始终不变。

导入完成后，在线服务只配置 canonical 数据库。源库应停止写入并作为冻结备份保存。

## 3. 备份和恢复

`doggie-storage-admin migrate DATABASE BACKUP` 和 `restore DATABASE BACKUP SAFETY_BACKUP` 只允许在应用停止、数据库连接关闭的情况下执行。操作前检查 quick check、foreign key check、迁移版本和目标路径，拒绝覆盖已有备份或未知版本。

## 4. 运维建议

- 使用独立的 `DOGGIE_DATABASE_PATH`；
- 在升级前复制数据库并执行完整校验；
- 不要手工修改 canonical 表或 migration metadata；
- 不要把数据库、备份、日志或 API Key 提交到 Git。
