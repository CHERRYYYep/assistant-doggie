# 系统架构设计

## 1. 总体架构

MVP 使用可测试的单体服务架构：

```text
Streamlit UI
    ↓
archive_service
    ├─ classify_service ── llm.py ── OpenAI Responses API
    ├─ extract_service  ── llm.py ── OpenAI Responses API
    └─ bucket_service
          ↓
        SQLite

correction_service ──→ SQLite
search_service     ──→ SQLite
view_service       ──→ Streamlit 展示数据
```

普通 Python 函数足以表达当前流程，比提前引入复杂 Agent 框架更容易调试、测试和回滚。只有出现多角色协作、长流程状态机或复杂工具审批后，才需要考虑进一步编排。

## 2. 普通归档流程

```text
1. 校验用户输入
2. 读取活跃 Bucket，并把当前焦点排在候选首位
3. classify_service 请求严格的 ClassificationResult
4. 服务端验证模型引用的 Bucket ID
5. 应用置信度与多候选门控；无候选且模型给出有效 create_new 时允许启动首个 Bucket
6. 写 classification_records 审计
7. ask_user：停止，不创建正式 Entry
8. append/create：extract_service 请求 ExtractionResult
9. 同一事务创建或追加 Entry，并写 Todo/Evidence/Timeline/Decision
10. 更新标签、滚动摘要和最近活跃时间
11. 返回 ArchiveResult
```

`archive_service` 自己创建 Session 时负责提交、回滚和关闭；调用方传入 Session 时，最终事务控制权属于调用方。

Streamlit 会在当前会话内复用同一待确认输入的分类结果，避免用户重复点击导致置信度和建议来回变化；用户仍可通过“重新分析”明确触发一次新的模型调用。若没有可选 Bucket，界面始终展示可编辑的标题和类型表单，保证首个 Bucket 可以落地。

## 3. 服务职责

### `llm.py`

统一 OpenAI 配置与 Structured Outputs 调用，处理响应不完整、拒绝、Schema 校验失败和有限重试。业务服务不直接创建 OpenAI Client。

### `classify_service`

构造有限候选，输出 `append_existing`、`create_new` 或 `ask_user`，校验模型返回的引用并执行风险门控。每次结果写入 `classification_records`，用于校准和纠错分析。

### `extract_service`

从单条原始输入提取 summary、todos、evidences、timeline events、decisions、hypotheses、entities 和 tags。当前持久化前五类结构和 tags；hypotheses、entities 暂只保留在返回结果中。

### `bucket_service`

负责 Bucket/Entry CRUD、结构化记录入库、精确去重、滚动摘要和详情查询。摘要可由 Entry 重新构建，不能代替原始事实。

### `correction_service`

支持移动指定或最近 Entry，并同步移动其派生记录；写入 Correction 前后快照，重建两个 Bucket 的摘要，并把关联分类审计标记为已纠错。

### `search_service` 与 `view_service`

搜索服务使用 SQLite 关键词匹配标题、摘要、标签和 Entry 原文。展示服务将 ORM/Pydantic 对象转换为稳定的 UI 数据结构，避免业务逻辑散落在 Streamlit 回调中。

## 4. 当前焦点与候选范围

当前焦点来自用户最近归档或在 UI 中选择的 Bucket。分类时只发送当前焦点和最近活跃的有限候选，默认上限为 20。这样既减少 Token 消耗，也避免把完整历史暴露给每次分类调用。更旧内容通过搜索按需找回。

## 5. 风险门控

```text
confidence >= 0.85 且候选唯一 → 自动归档
0.55 <= confidence < 0.85       → 用户确认
confidence < 0.55               → 用户确认
多个相似候选                    → 用户确认
```

阈值来自 `.env`，只是保守初值。`confidence` 是模型主观信号，不是正确概率；必须用固定标注集、实际纠错和高错误代价案例持续校准。低置信度输入可写分类审计，但不得在确认前污染正式 Bucket。

## 6. 事务与错误处理

- OpenAI 配置或调用失败：明确报错，不伪造归档结果。
- 输出不符合 Schema：有限重试后失败。
- Bucket ID 无效：降级为确认，不进入持久化流程。
- 数据库任一步失败：自动归档事务整体回滚。
- 用户确认后：通过独立确认入口重新提取并保存。

MVP 不自动创建 `inbox` 兜底，因为它会把“不确定”误解为“已归档”。

## 7. 可观测性与评估

当前持久化分类动作、分数、原因、候选、焦点、Prompt 版本、模型名和纠错状态。固定 50 条标注集负责计算分类准确率、自动归档准确率、询问召回率与严重误合并数。真实模型评估使用独立命令，普通 Pytest 全部 mock LLM。

后续可增加调用耗时、Token、成本、搜索 query、摘要重建版本和用户确认选择等指标。
