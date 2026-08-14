# Doggie Canonical 数据模型

## 1. 存储原则

`doggie-storage-sqlite` 只向产品运行时暴露 Doggie-owned canonical SQLite。所有业务写入通过强类型 request 和事务完成，应用层不拿到任意 SQL 写连接。

历史 schema 只作为离线导入源：先只读校验，再把语义内容写入全新的 canonical 数据库；导入不修改源库，也不与在线写入并发共享文件。

## 2. 核心对象

### Bucket

- `id`、`title`、`kind`；
- `lifecycle`：`active`、`paused`、`archived`；
- `summary`、`created_at`、`updated_at`、`last_active_at`、`archived_at`；
- `metadata_json`：导入元数据和扩展信息。

### Entry

- `id`、`bucket_id`、`raw_text`；
- `summary`、`content_type`；
- `classification_confidence`、`classification_reason`；
- `created_at`、`updated_at`、`moved_from_bucket_id`、`archive_state`。

`raw_text` 是不可替代的证据来源，结构化提取失败不能丢失原文。

### Memory item

canonical schema 用统一 memory item 表保存 `summary`、`todo`、`evidence`、`timeline`、`decision`、`hypothesis`、`entity` 和 `tag`，并保留 kind、text、event time、status、metadata 和来源 Entry/Bucket 关系。

### 审计和对话

- `archive_attempts`：每次归档尝试、pending confirmation、最终状态和原文绑定；
- `classification_audits`：模型 action、confidence、reason、候选、prompt/model 元数据；
- `corrections`：Entry 移动前后的投影；
- `conversation_messages`：user、assistant、tool 消息和工具元数据。

## 3. 事务不变量

- `ask_user` 只能新增确认/分类审计，不得创建正式 Entry；
- `append_existing` 必须引用存在且可写的 Bucket；
- `create_new` 必须同时创建 Bucket 和第一条 Entry；
- Entry 的结构化 memory、Bucket 摘要和活动时间与归档写入同一事务提交；
- 任何外键、字段校验或后续写入失败都回滚整次业务操作；
- 删除 Entry 或 Bucket 时，关联 memory、审计和纠错关系按 canonical 外键规则处理；
- 对话确认必须匹配原始文本、pending attempt 和有效目标 Bucket。

## 4. 查询投影

查询以 Entry 为结果单元，包含：

- Bucket 标识、标题、状态和摘要；
- Entry 原文、摘要、时间和排序分数；
- 命中的 tags、entities、结构化字段；
- 去重后的 evidence 引用；
- 解析后的 `MemoryQuery` 计划和跨 Bucket 聚合信息。

读路径不会修改 Bucket 活动时间，也不会产生新的聊天或归档记录。
