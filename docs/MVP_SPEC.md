# MVP 功能规格

## 1. MVP 总目标

实现一个可以本地运行的最小闭环：

```text
输入文本 → 自动分类/新建 bucket → 结构化提取 → 保存 → 展示归档结果 → 查看 bucket
```

## 2. 功能清单

### F1：文本输入

用户可以在页面输入任意文本。

输入示例：

```text
支付回调从 10:20 开始失败，日志里第三方返回 502，影响订单确认。
```

输出：进入归档流程。

### F2：读取上下文

系统在分类前读取：

- 当前焦点 bucket。
- 最近活跃 buckets。
- 最近几条 entries。
- 用户偏好。

MVP 简化：只读取最近 20 个 active bucket。

### F3：分类决策

系统输出三种动作之一：

| action | 含义 |
|---|---|
| append_existing | 追加到已有 bucket |
| create_new | 创建新 bucket |
| ask_user | 需要确认目标或新建意图 |

置信度策略：

| 条件 | 策略 |
|---|---|
| confidence >= 0.85 且候选唯一 | 直接归档 |
| 0.55 <= confidence < 0.85 | 不写正式 Entry，先确认 |
| confidence < 0.55 | 不写正式 Entry，必须确认 |
| 多个相似候选 | 无论分数高低都先确认 |

### F4：新建 bucket

如果系统判断为新主题，则创建 bucket。

新建字段：

- title
- type
- status = active
- summary
- tags

### F5：追加 entry

每次用户输入都保存为 entry。

保存字段：

- bucket_id
- raw_text
- summary
- content_type
- created_at

### F6：结构化提取

从输入中提取：

- summary
- todos
- evidences
- timeline_events
- decisions
- hypotheses
- entities
- tags

缺失内容返回空数组，不要编造。

### F7：更新 bucket 摘要

每次归档后更新 bucket 的整体摘要。

MVP 简化：

- bucket.summary 可以先拼接/压缩最近摘要。
- 后续再引入更稳定的 rolling summary 逻辑。

### F8：归档反馈

每次归档后必须告诉用户：

```text
已归档到：支付回调失败排查
类型：incident
动作：新建 bucket / 追加已有 bucket
置信度：0.91
原因：内容描述线上支付回调失败和日志证据，符合 incident 类型。
```

确认后追加：

```text
我先放到了「支付回调失败排查」。如果不对，你可以说：“把刚才那条移到 XXX”。
```

### F9：bucket 详情

详情页展示：

- 标题
- 类型
- 状态
- 摘要
- 时间线
- TODO
- 证据
- 决策
- 原始记录

### F10：自然语言纠错，MVP 版

第一版支持四类：

| 用户说法 | 系统动作 |
|---|---|
| 刚才那条放到 XXX | 移动最近 entry |
| 这个单独新开一个 | 为最近 entry 新建 bucket |
| 这个不是 idea，是 task | 修改 bucket 类型 |
| 把 A 和 B 合并 | 合并两个 bucket |

### F11：搜索历史 bucket

用户可以通过关键词找 bucket。

MVP 搜索字段：

- bucket.title
- bucket.summary
- bucket.tags
- entry.raw_text

## 3. 页面规格

### 页面 1：主输入页

布局：

```text
左侧：活跃 bucket 列表
右侧上方：输入框
右侧下方：归档结果
```

### 页面 2：bucket 详情页

可以先在同一个 Streamlit 页面中实现，不需要独立路由。

展示区块：

```text
摘要
时间线
TODO
证据
决策
原始记录
```

## 4. API / 函数规格

MVP 可以先不做 HTTP API，直接写 Python 函数。

核心函数：

```python
archive_user_input(text: str) -> ArchiveResult
classify_input(text: str, active_buckets: list[Bucket]) -> ClassificationResult
extract_info(text: str) -> ExtractionResult
create_bucket(...)
append_entry(...)
search_buckets(query: str)
correct_last_action(command: str)
```

## 5. 验收标准

### 场景 A：incident 连续输入

输入 1：

```text
支付回调从 10:20 开始大量失败，日志里第三方返回 502。
```

期望：创建 incident bucket。

输入 2：

```text
刚才那个支付问题，10:40 切备用通道后恢复了。
```

期望：追加到同一个 bucket。

### 场景 B：experiment 连续输入

输入 1：

```text
今天压测接口 A，QPS 到 1200 后 P99 延迟 2.3s。
```

期望：创建 experiment bucket。

输入 2：

```text
把连接池从 50 调到 100 后，P99 降到了 1.4s。
```

期望：追加到同一个 bucket。

### 场景 C：纠错

用户：

```text
刚才那条不要放到支付问题，放到接口稳定性问题里。
```

期望：最近 entry 被移动，并记录 correction log。
