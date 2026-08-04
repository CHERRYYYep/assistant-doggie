# 测试与验收计划

## 1. 测试目标

MVP 的测试重点不是覆盖所有代码，而是验证核心闭环稳定：

```text
单会话输入 → 直接回答或工具调用 → 记忆读取/写入 → 历史展示
归档输入 → 分类 → 提取 → 保存 → 展示 → 纠错 → 搜索
```

## 2. 测试类型

### 2.1 单元测试

覆盖：

- 数据库 CRUD。
- bucket_service。
- search_service。
- correction_service 的规则部分。
- schema 校验。
- Agent 工具参数解析、工具白名单和历史消息装配。
- Rust `work-memory-core` 的领域校验、候选排序和风险门控。

### 2.2 集成测试

覆盖：

- archive_user_input 完整流程。
- LLM mock 后的分类和提取。
- 创建 bucket + entry + structured records。
- Responses API 与 Chat Completions 的多轮工具调用。
- 单一对话在多次请求之间的上下文复用。

### 2.3 手动测试

使用 `tests/fixtures/sample_inputs.md` 逐条输入。

## 3. 样例场景

### 场景 0：单会话回答与工具调用

先输入：

```text
我在排查支付回调 502，先帮我分析可能原因和检查顺序。
```

期望：

- 助手直接给出问题分析和可执行步骤。
- 因为输入包含正在发生的故障状态，模型同时主动调用归档工具。
- `chat_messages` 保存 user、tool 和 assistant 消息。

单独输入一个没有新增工作事实的问题：

```text
Python 的上下文管理器是什么？
```

期望：

- 助手正常回答。
- 不调用写入工具，不创建无意义 Bucket。

继续输入：

```text
查一下之前支付问题的记录，再结合历史告诉我下一步。
```

期望：

- 模型调用 `search_memory`，必要时继续调用 `get_bucket_detail`。
- 工具调用及结果作为 tool 消息保存并在 UI 中可展开查看。
- 最终回答结合本轮问题与已持久化的上一轮上下文。

再输入：

```text
请记住：支付回调问题已定位为第三方证书过期。
```

期望：

- 模型调用受控写入工具，而不是声称已保存但不执行。
- 写入仍经过现有 Bucket 分类、提取和事务逻辑。

### 场景 1：Incident 新建与追加

输入：

```text
支付回调从 10:20 开始大量失败，日志里第三方返回 502，影响订单确认。
```

期望：

- 创建 bucket。
- type = incident。
- evidence 包含第三方 502。
- timeline 包含 10:20。

继续输入：

```text
刚才那个支付问题，10:40 切到备用通道后恢复了，后面要补复盘。
```

期望：

- append_existing。
- bucket 仍是同一个。
- todo 包含补复盘。
- decision/处置包含切备用通道。

### 场景 2：Experiment 新建与追加

输入：

```text
今天压测接口 A，QPS 到 1200 后 P99 延迟升到 2.3s，CPU 85%。
```

期望：

- 创建 experiment。
- evidence 包含 QPS、P99、CPU。

继续输入：

```text
把连接池从 50 调到 100 后，P99 降到了 1.4s。
```

期望：

- 追加到接口 A 压测 bucket。
- evidence 包含参数调整和结果变化。

### 场景 3：Meeting

输入：

```text
下午和设计同学讨论了首页改版，结论是先保留搜索入口，卡片布局下周再验证。
```

期望：

- type = meeting 或 decision。
- decision 包含保留搜索入口。
- todo 包含下周验证卡片布局。

### 场景 4：纠错

前置：最近一条被放入支付 bucket。

输入：

```text
刚才那条不要放到支付问题，放到接口稳定性问题里。
```

期望：

- 最近 entry 被移动。
- corrections 表新增记录。
- 两个 bucket 更新时间变化。

### 场景 5：搜索

输入：

```text
帮我找之前支付回调失败的问题。
```

期望：

- 返回支付回调相关 bucket。
- 显示摘要和最近更新时间。

## 4. 评估指标

### 分类评估集

维护不少于 50 条人工标注案例，目标逐步扩充到 100 条。案例必须固定输入、候选 Bucket、当前焦点、期望 action、期望 bucket_id、是否应询问和错误代价。不要让待评估的同一次 LLM 调用生成标准答案。

### 分类核心指标

分别统计：

```text
action 准确率
已有 Bucket 选择准确率
自动归档准确率
ask_user 覆盖率
严重误合并数量
```

MVP 目标：

- action 准确率 >= 85%。
- 已有 Bucket 选择准确率 >= 80%。
- 高置信度自动归档准确率 >= 90%。
- 标注集中的严重误合并为 0；出现时必须单独分析。

### 置信度校准

`confidence` 是 LLM 的主观信号，不直接等于正确概率。按 `<0.55`、`0.55-0.85`、`>=0.85` 分桶，统计每档实际正确率、询问率和纠错率。只有评估数据支持时才调整自动归档阈值。

### 结构化提取

分别检查 Summary 忠实性、Todo Precision/Recall、Evidence 事实准确性、Timeline 时间保持和严重编造。`tests/fixtures/extraction_cases.json` 保存人工定义的必需术语与禁止事实；`app.extraction_evaluation` 自动计算各字段术语召回，并标记禁止事实和原文不存在的数字。

自动检查不能判断改写后的语义、因果关系、否定表达、单位变化或无数字编造。每份真实报告仍需人工逐条回答：

1. Summary 是否只包含原文事实；
2. Todo 是否真的是未完成动作，是否有遗漏或误报；
3. Evidence 是否能直接在原文定位；
4. Decision 与 Hypothesis 是否被混淆；
5. 时间表达是否被错误确定化。

MVP 目标：

- 提取内容人工可用率 >= 80%。
- Evidence 严重编造为 0。
- Todo Precision >= 85%，Recall >= 70%。
- 固定必需事实术语召回率单独按字段报告，不合成为虚假的“总体置信度”。

### 纠错与搜索

- 最近 Entry 移动成功率 >= 95%。
- 10 条固定搜索 query 的目标 Bucket 召回率 >= 80%。

## 5. LLM 测试建议

LLM 输出不稳定，所以测试分两层：

1. mock LLM 输出，测试业务逻辑；
2. 少量真实 LLM 调用，测试 Prompt 和模型效果。

不要让普通单元测试依赖真实 API，否则测试慢且花钱。常用命令：

```bash
pytest -q
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
python -m app.evaluation --baseline
python -m app.live_evaluation \
  --limit 3 \
  --output /tmp/classification-live-report.json
python -m app.live_extraction_evaluation \
  --limit 3 \
  --reference-date 2026-08-03 \
  --output /tmp/extraction-live-report.json
```

`pytest`、Cargo 检查和规则基线不调用真实 API。两个 `live` 命令会使用 `.env` 中选定站点的 Base URL、Key、API 模式和模型，并可能产生费用。报告必须保存站点名、Base URL、API 模式、模型名、Prompt 版本、日期、案例路径、完整预测和指标。真实调用失败时，应保留错误原因，不能用 mock 或规则基线冒充真实模型结果。中转站需分别验证其是否支持 Responses API 或 Chat Completions Structured Outputs。

离线复算已有报告：

```bash
python -m app.evaluation /tmp/classification-live-report.json
python -m app.extraction_evaluation /tmp/extraction-live-report.json
```

## 6. 回归测试清单

自动化映射：

- `tests/test_llm.py`：Structured Outputs 封装和错误分支；
- `tests/test_agent_service.py`：单会话持久化、Responses/Chat Completions 工具循环和工具白名单；
- `tests/test_classify_service.py`、`tests/test_evaluation.py`：分类、门控和指标；
- `tests/test_live_evaluation.py`：真实分类运行器的版本化元数据和报告落盘；
- `tests/test_extraction_evaluation.py`、`tests/test_live_extraction_evaluation.py`：提取遗漏、编造风险提示和真实报告结构；
- `tests/test_archive_service.py`、`tests/test_extraction_and_bucket_memory.py`：事务归档和长期记忆；
- `tests/test_correction_service.py`：纠错移动和审计；
- `tests/test_search_and_view.py`、`tests/test_ui.py`：搜索、展示和 Streamlit；
- `tests/test_mvp_regression.py`：Incident、Experiment、Meeting、纠错和搜索串联回归。
- `rust/work-memory-core/tests/classification.rs`：Rust 分类契约、候选排序与风险门控回归。

每次改 Prompt 或分类逻辑后，至少手动跑：

- incident 新建。
- incident 追加。
- experiment 新建。
- experiment 追加。
- meeting 提取 TODO。
- 纠错移动最近 entry。
- 搜索历史 bucket。

## 7. bug 记录模板

```md
## Bug 标题

### 输入

### 当前结果

### 期望结果

### 判断
- 分类错 / 提取错 / 保存错 / 展示错 / 搜索错

### 修复方案
```
