# 第 4～10 天实现说明

## 1. 阶段目标与结论

本阶段把仓库从“数据库与 Schema 骨架”推进到可运行的 MVP：系统能评估分类、调用 LLM 返回严格结构、根据风险决定自动归档或请求确认、提取并保存长期记忆、纠正误归档、在 Streamlit 中查看结果，并通过关键词找回 Bucket。

核心数据流如下：

```text
用户输入
→ 候选 Bucket 构造
→ LLM 分类 + 服务端 ID 校验 + 置信度门控
→ 低置信度：只写分类审计，等待确认
→ 高置信度：LLM 提取
→ 同一事务写 Bucket / Entry / 派生记录
→ 展示、搜索或纠错
```

这样安排的原因是：长期私人事务 Agent 最危险的问题不是“少提取一个标签”，而是把内容错误合并进长期 Bucket。先建立分类评估、确认和纠错能力，可以减少记忆污染，并为后续优化积累真实反馈。

## 2. 第四天：分类评估基线

新增 `app/evaluation.py` 和 `tests/fixtures/classification_cases.json`。50 条人工标注案例覆盖追加、新建、询问、明确另开主题、模糊指代、相似 Bucket 和高错误代价。指标包括 action 准确率、已有 Bucket 准确率、自动归档准确率、询问召回率和严重误合并数。

透明关键词基线命令：

```bash
python -m app.evaluation --baseline
```

当前结果为：action accuracy `84%`、existing Bucket accuracy `73.33%`、auto archive accuracy `96.55%`、ask-user recall `93.33%`，严重误合并 `1`。这是规则基线，不代表真实 LLM 效果；严重误合并仍应继续压低。

## 3. 第五天：Structured Outputs 与分类

`app/llm.py` 统一封装 `client.responses.parse(..., text_format=PydanticSchema)`，处理配置缺失、响应截断、拒绝、Schema 校验和有限重试。普通测试通过注入 fake client 隔离真实 API。

`app/services/classify_service.py` 只向模型提供当前焦点和有限的活跃 Bucket，并在模型返回后再次验证 Bucket ID。模型编造或引用无效 ID 时，系统不会写库，而是降级为 `ask_user`。这种“双重校验”很重要：Structured Outputs 保证字段形状正确，但不能保证业务引用真实存在。

官方参考：[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 4. 第六天：置信度门控与审计

初始策略由环境变量控制：

```text
confidence >= 0.85 且候选唯一：允许自动归档
0.55 <= confidence < 0.85：要求用户确认
confidence < 0.55：必须确认
多个相似候选：无论分数多高都要求确认
```

`confidence` 只是 LLM 的主观风险信号，不是“正确概率”。是否可信必须结合固定标注集的真实正确率、候选数量、当前焦点、错误代价和后续纠错率评估。

新增 `classification_records` 保存输入、动作、候选 ID、焦点、分数、原因、Prompt 版本、模型名和纠错标记。它是后续校准阈值和分析高置信度错误的依据。

## 5. 第七天：提取、入库与滚动摘要

`extract_info()` 返回 `ExtractionResult`，`save_extraction()` 将字段映射为长期记忆：

```text
summary         → Entry.summary + Bucket.summary
todos           → Todo
evidences       → Evidence
timeline_events → TimelineEvent
decisions       → Decision
tags            → Bucket.tags
```

每条派生记录保留 `bucket_id` 和来源 `entry_id`，因此可以追溯到原始输入。Todo、Evidence、Decision、Timeline 和标签已实现 MVP 级精确去重。Bucket 摘要是有长度上限、可从 Entry 重建的缓存；原始 `Entry.raw_text` 才是事实来源。

当前 `hypotheses` 和 `entities` 已存在于输出 Schema，但尚未持久化，应在确定查询方式和生命周期后再增加表，避免过早扩张数据模型。

## 6. 第八天：事务归档与纠错

`archive_user_input()` 将分类、审计、提取和写库串成闭环。自动归档时，Bucket、Entry、派生记录和分类审计位于同一事务；任一步失败都不会返回成功。低置信度输入只保存审计记录，不创建正式 Entry。

确认入口包括：

- `archive_confirmed_input()`：确认追加到已有 Bucket；
- `archive_confirmed_new_input()`：确认创建新 Bucket。

`move_entry()` 和 `move_latest_entry()` 会同时移动 Entry 及 Todo、Evidence、TimelineEvent、Decision，写入 `corrections` 前后快照，重建来源与目标摘要，并把关联分类审计标为 `corrected=true`。

当调用方传入 SQLAlchemy Session 时，由调用方决定最终提交或回滚；服务只在自行创建 Session 时负责事务提交、回滚与关闭。

## 7. 第九天：Streamlit UI

`ui/streamlit_app.py` 提供活跃 Bucket、当前焦点、输入框、分类理由、置信度提示、确认流程、Bucket 详情和最近 Entry 纠错。详情按 Todo、Evidence、Timeline、Decision 和原始 Entry 分区展示。

UI 不隐藏不确定性：`needs_confirmation` 状态不会伪装成成功归档，用户必须明确选择已有 Bucket 或确认新建。

## 8. 第十天：搜索与回归

`search_buckets()` 使用 SQLite 兼容的关键词查询，范围包括标题、摘要、标签和 Entry 原文，并按标题、标签、摘要和匹配 Entry 数量进行简单排序。它优先解决“能否找回”的 MVP 问题，语义检索留到数据量和真实查询样本增长后再做。

自动化检查：

```bash
pytest -q
python -m app.evaluation --baseline
git diff --check
```

真实模型评估与普通 Pytest 分离，避免测试不稳定和意外 API 费用：

```bash
python -m app.live_evaluation --limit 3 --output /tmp/classification-live.json
```

## 9. 当前边界与下一步

- 先用真实分类结果校准阈值，不把 LLM 自报分数直接解释为概率。
- 为 `hypotheses`、`entities`、Todo 状态合并和决策替代关系设计持久化策略。
- 增加摘要质量与事实忠实性评估，而不只验证 JSON 合法。
- 用真实纠错数据统计 Bucket 混淆对，改进候选召回和 Prompt。
- 数据增长后再引入语义检索、冷热记忆和摘要快照。

## 10. 2026-08-03 验收记录

已完成：

```text
Pytest：40 passed
Python compileall：通过
git diff --check：通过
50 条规则分类基线：成功执行
```

真实模型分类已按 `--limit 3` 尝试，但 OpenAI 返回 HTTP 401 `invalid_api_key`，因此没有生成真实预测文件，也没有继续执行真实提取。修复 `.env` 中的 API Key 后，应重新运行第 8 节命令；在成功前，不能把规则基线或 mock 测试表述为真实 LLM 准确率。
