# 系统架构设计

## 1. 总体架构

MVP 采用简单单体架构：

```text
Streamlit UI
    ↓
archive_service
    ↓
classify_service ── llm
extract_service ─── llm
    ↓
bucket_service / correction_service / search_service
    ↓
SQLite
```

## 2. 为什么第一版不用复杂 Agent 框架

第一版目标是验证产品闭环，不是验证复杂编排能力。建议先用普通函数组织：

- 更容易调试。
- 更容易测试。
- 更容易理解数据流。
- 更适合新手。

等以下情况出现后，再考虑 Agents SDK、LangGraph 或其他编排框架：

- 有多个 specialist agent。
- 需要长流程状态机。
- 需要人工审批节点。
- 需要工具调用审计。
- 需要复杂回滚和可观测性。

## 3. 核心流程：归档文本

```text
1. 用户输入 text
2. archive_service 接收 text
3. 判断是否为纠错/搜索/普通归档
4. 如果是纠错：交给 correction_service
5. 如果是搜索：交给 search_service
6. 如果是普通归档：
   6.1 读取 current_focus_bucket 和 active_buckets
   6.2 classify_service 判断 append/create/ask
   6.3 extract_service 提取结构化信息
   6.4 bucket_service 写入 bucket、entry、todos、evidences、timeline
   6.5 view_service 生成用户可读反馈
```

## 4. 服务职责

### archive_service

总入口，负责调度。

主要函数：

```python
def archive_user_input(text: str) -> ArchiveResult:
    ...
```

### classify_service

负责判断归属。

输入：

- 用户输入。
- 当前焦点 bucket。
- 活跃 buckets。

输出：

- action。
- bucket_id 或新 bucket 信息。
- confidence。
- reason。

### extract_service

负责结构化提取。

输出：

- summary
- todos
- evidences
- timeline_events
- decisions
- hypotheses
- entities
- tags

### bucket_service

负责数据库写入和读取。

函数：

```python
create_bucket(...)
append_entry(...)
move_entry(...)
merge_buckets(...)
get_bucket_detail(...)
list_active_buckets(...)
```

### correction_service

负责自然语言纠错。

第一版先支持规则 + LLM 混合：

1. 规则判断“刚才那条”“不要放到”“改成”。
2. 复杂命令再用 LLM 提取操作意图。

### search_service

负责历史检索。

MVP：SQLite LIKE 搜索。

后续：向量检索 + 关键词混合检索。

### view_service

负责把内部结构转换成用户可读展示。

避免把 UI 文案散落在业务逻辑里。

## 5. 当前焦点 bucket

MVP 可用简单策略：

- 最近一次成功归档的 bucket 就是 current_focus_bucket。
- 当用户打开某个 bucket 详情，也可以把它设为 current_focus_bucket。
- 用户说“继续这个”时优先使用 current_focus_bucket。

后续可以增加 session_state 表。

## 6. 低置信度处理

```text
confidence < 0.45
    不写入数据库
    返回候选 bucket 和问题
```

用户确认后再归档。

MVP 可先简化：低置信度也先写入一个 `inbox` bucket，但提示用户确认。更稳妥的做法是不自动归档。

## 7. 错误处理

必须处理：

- OpenAI API 调用失败。
- LLM 返回格式不符合 schema。
- 数据库写入失败。
- 用户输入为空。
- bucket 不存在。

建议策略：

- API 失败：保存原文到 inbox 或提示重试。
- JSON 解析失败：重试一次；仍失败则保存原文但不结构化。
- DB 失败：不要假装成功，明确提示。

## 8. 可观测性

即使是 MVP，也建议记录：

- 每次分类的 action、confidence、reason。
- 每次 LLM 调用耗时。
- 每次纠错。
- 每次搜索 query。

先用日志文件即可。
