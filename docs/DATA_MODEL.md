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
