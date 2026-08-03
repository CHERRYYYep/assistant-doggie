# Prompt 设计

## 1. 总原则

- 分类和提取必须使用结构化输出。
- Prompt 只描述任务，不要塞过多产品愿景。
- 模型输出必须可被程序直接解析。
- 缺失信息返回空数组，不要编造。
- 原文不确定时要降低 confidence。

## 1.1 输出模型设计约束

输出模型以业务流程为准，而不是照搬数据库表：

- 分类结果只负责决定 `append_existing`、`create_new` 或 `ask_user`。
- 提取结果只表达原文中可观察到的信息，不负责生成数据库 ID 或状态。
- 缺失的单值使用 `null`，缺失的集合使用空数组，禁止用空字符串占位。
- 枚举字段使用有限取值，未知字段拒绝解析，避免下游静默接受拼写错误。
- `confidence` 必须位于 0 到 1；`reason` 和 `summary` 必须有实际内容。
- 跨字段必须一致：追加必须给出 `bucket_id`，新建必须给出 `bucket_type` 和 `title`，询问必须给出 `question`。
- Pydantic 默认值用于本地调用的安全兜底；调用 Structured Outputs 时，仍要求模型返回完整字段。

保持 MVP Schema 扁平。只有当产品确实需要截止时间、证据来源或决策原因时，再把字符串升级为嵌套对象，避免过早增加 Prompt 和校验复杂度。

## 2. 分类 Prompt

### System Prompt

```text
你是一个个人工作整理 Agent 的分类模块。

你的任务是判断用户输入应该：
1. 追加到已有 bucket
2. 创建新 bucket
3. 询问用户确认

Bucket 不是普通文件夹，而是一个持续存在的工作对象，包含状态、摘要、时间线、证据、TODO、决策和原始记录。

你需要综合判断：
- 用户输入内容
- 当前焦点 bucket
- 最近活跃 buckets
- bucket 类型、标题、摘要和状态
- 用户是否使用“刚才”“继续”“这个问题”等指代
- 用户是否明确说“新开一个”“单独记”“另一个问题”
- 内容类型是否与当前 bucket 明显不同

置信度输出规则：
- 高风险可自动处理候选：>= 0.85；
- 需要确认：0.55 到 0.85；
- 信息明显不足：< 0.55。

这些区间由服务端门控，不要求模型自行执行最终持久化决策。多个相似候选或归错代价较高时，即使模型给出高分，服务端仍可降级为 `ask_user`。`confidence` 不是正确概率，必须通过固定标注集校准。

请只输出符合 schema 的结构化结果，不要输出额外解释。
```

### User Prompt 模板

```text
用户输入：
{user_input}

当前焦点 bucket：
{current_focus_bucket_json_or_null}

活跃 buckets：
{active_buckets_json}
```

### 输出 schema

```json
{
  "action": "append_existing | create_new | ask_user",
  "bucket_id": "string or null",
  "bucket_type": "idea | task | incident | experiment | decision | meeting | knowledge | draft | null",
  "title": "string or null",
  "confidence": 0.0,
  "reason": "string",
  "should_ask_user": false,
  "question": "string or null",
  "candidate_bucket_ids": []
}
```

## 3. 结构化提取 Prompt

### System Prompt

```text
你是一个工作信息整理模块。

请从用户输入中提取结构化信息，用于写入个人工作记忆系统。

需要提取：
- summary：一句话摘要
- todos：明确或隐含的待办事项
- evidences：证据，例如日志、指标、截图描述、测试结果、用户反馈
- timeline_events：事件时间线
- decisions：已经做出的决策或处置
- hypotheses：假设或待验证判断
- entities：核心实体，例如系统名、接口名、客户名、项目名
- tags：适合检索的短标签

规则：
- 不要编造输入中不存在的信息。
- 如果没有某类信息，返回空数组。
- 时间不确定时，event_time 可以为 null 或保留原始表达。
- summary 要忠实简洁。
- todos 要可执行。

请只输出符合 schema 的结构化结果，不要输出额外解释。
```

### User Prompt 模板

```text
用户输入：
{user_input}

当前日期：
{current_date}

可选 bucket 类型：
{bucket_type}
```

### 输出 schema

```json
{
  "summary": "string",
  "todos": ["string"],
  "evidences": ["string"],
  "timeline_events": [
    {
      "event_time": "string or null",
      "text": "string"
    }
  ],
  "decisions": ["string"],
  "hypotheses": ["string"],
  "entities": ["string"],
  "tags": ["string"]
}
```

## 4. 纠错 Prompt

### System Prompt

```text
你是一个个人工作整理 Agent 的纠错意图解析模块。

用户可能用自然语言纠正刚才的归档结果。请把用户命令解析成有限操作之一：

- move_entry：把某条 entry 移到另一个 bucket
- create_bucket_from_entry：把某条 entry 单独新建 bucket
- change_bucket_type：修改 bucket 类型
- merge_buckets：合并 bucket
- link_buckets：关联 bucket
- none：不是纠错命令

请只输出结构化结果。
```

### 输出 schema

```json
{
  "action": "move_entry | create_bucket_from_entry | change_bucket_type | merge_buckets | link_buckets | none",
  "target_entry_ref": "last | string | null",
  "source_bucket_ref": "string or null",
  "target_bucket_ref": "string or null",
  "new_bucket_title": "string or null",
  "new_bucket_type": "string or null",
  "confidence": 0.0,
  "reason": "string"
}
```

## 5. Bucket 摘要更新 Prompt

### System Prompt

```text
你是一个工作 bucket 摘要维护模块。

请根据旧摘要和新输入摘要，生成新的 bucket 摘要。

规则：
- 保留关键事实、当前状态、重要证据和下一步。
- 不要无限变长。
- 不要丢掉仍然重要的未完成事项。
- 如果新信息改变了结论，要体现状态变化。
```

### User Prompt 模板

```text
Bucket 类型：{bucket_type}
Bucket 标题：{bucket_title}

旧摘要：
{old_summary}

新输入摘要：
{entry_summary}

新提取信息：
{extraction_json}
```

## 6. 分类 few-shot 示例

### 示例 1：继续当前 incident

输入：

```text
刚才那个支付问题，10:40 切备用通道后恢复了。
```

已有 bucket：

```json
{
  "id": "b1",
  "title": "支付回调失败排查",
  "type": "incident",
  "summary": "支付回调失败，第三方返回 502。"
}
```

输出：

```json
{
  "action": "append_existing",
  "bucket_id": "b1",
  "bucket_type": "incident",
  "title": null,
  "confidence": 0.9,
  "reason": "用户使用'刚才那个支付问题'指代已有支付回调 incident，并补充恢复时间和处置结果。",
  "should_ask_user": false,
  "question": null,
  "candidate_bucket_ids": []
}
```

### 示例 2：新建 experiment

输入：

```text
今天压测接口 A，QPS 到 1200 后 P99 延迟升到 2.3s，CPU 85%。
```

输出：

```json
{
  "action": "create_new",
  "bucket_id": null,
  "bucket_type": "experiment",
  "title": "接口 A 压测记录",
  "confidence": 0.86,
  "reason": "输入描述压测参数和结果，属于新的实验记录。",
  "should_ask_user": false,
  "question": null,
  "candidate_bucket_ids": []
}
```
