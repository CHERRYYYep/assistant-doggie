# 开发指导文档：从 0 到 MVP

这份文档按新手友好的顺序写。不要跳步骤。

## 0. 开发前心法

你要开发的不是“能聊天的机器人”，而是一个有数据库的工作记忆系统。

核心闭环：

```text
输入 → 判断归属 → 提取结构 → 保存 → 展示 → 可纠错 → 可找回
```

不要一开始追求全能。

## 1. 第一天：跑通项目环境

### 1.1 创建虚拟环境

```bash
python -m venv .venv
source .venv/bin/activate
```

### 1.2 安装依赖

```bash
pip install -r requirements.txt
```

### 1.3 配置环境变量

```bash
cp .env.example .env
```

然后在 `.env` 填写：

```text
OPENAI_API_KEY=你的 key
OPENAI_MODEL=你可用的模型
DATABASE_URL=sqlite:///./work_memory.db
```

### 1.4 运行占位 UI

```bash
streamlit run ui/streamlit_app.py
```

你应该看到一个输入框，但归档还未实现。

## 2. 第二天：实现数据库

目标：不用 AI，也能保存 bucket 和 entry。

### 2.1 在 app/models.py 实现表

先实现：

- Bucket
- Entry
- Todo
- Evidence
- TimelineEvent
- Decision
- Correction

### 2.2 在 app/db.py 实现数据库连接

需要函数：

```python
get_engine()
get_session()
init_db()
```

### 2.3 在 bucket_service.py 实现基础函数

先写这些：

```python
create_bucket(title, type, summary, tags=None)
list_active_buckets(limit=20)
get_bucket(bucket_id)
append_entry(bucket_id, raw_text, summary=None)
get_bucket_detail(bucket_id)
```

### 2.4 验收

写一个临时脚本或测试：

```python
bucket = create_bucket("支付回调失败排查", "incident", "支付回调异常")
entry = append_entry(bucket.id, "日志里第三方返回 502")
```

数据库里能看到记录就过关。

## 3. 第三天：实现 Pydantic schema

在 `app/schemas.py` 定义：

```python
class ClassificationResult(BaseModel):
    action: Literal["append_existing", "create_new", "ask_user"]
    bucket_id: str | None = None
    bucket_type: Literal["idea", "task", "incident", "experiment", "decision", "meeting", "knowledge", "draft"] | None = None
    title: str | None = None
    confidence: float
    reason: str
    should_ask_user: bool = False
    question: str | None = None
    candidate_bucket_ids: list[str] = []

class TimelineEventExtract(BaseModel):
    event_time: str | None = None
    text: str

class ExtractionResult(BaseModel):
    summary: str
    todos: list[str] = []
    evidences: list[str] = []
    timeline_events: list[TimelineEventExtract] = []
    decisions: list[str] = []
    hypotheses: list[str] = []
    entities: list[str] = []
    tags: list[str] = []
```

## 4. 第四天：建立 Bucket 分类评估基线

目标：先定义“分类做得好”的标准，再接入真实 LLM，避免只凭几条演示输入判断效果。

### 4.1 建立人工标注集

新增 `tests/fixtures/classification_cases.json`，每条至少包含：

```json
{
  "id": "incident_append_001",
  "input": "刚才那个支付问题恢复了",
  "current_focus_bucket_id": "bucket_payment",
  "buckets": [],
  "expected_action": "append_existing",
  "expected_bucket_id": "bucket_payment",
  "should_ask_user": false,
  "error_cost": "high"
}
```

首批不少于 50 条，覆盖新建、追加、歧义询问、明确另开主题、模糊指代和相似 Bucket。人工标注是评估真值，不让同一次 LLM 调用既作答又评分。

### 4.2 定义指标

至少计算：

- action 准确率。
- 已有 Bucket 选择准确率。
- 自动归档准确率。
- `ask_user` 覆盖率。
- 严重误合并数量。

普通 Pytest 使用固定预测或 mock，不调用真实 API；真实模型评估使用单独命令并保存模型、Prompt 版本和结果。

### 4.3 验收

- 标注集能够被程序读取并校验字段。
- 指标计算有单元测试。
- 先记录基线，不为追求分数反复修改样本答案。

## 5. 第五天：接入 LLM 并优先实现分类

### 5.1 封装 `app/llm.py`

统一实现结构化调用：

```python
def parse_with_schema(
    system_prompt: str,
    user_prompt: str,
    schema: type[BaseModel],
) -> BaseModel:
    ...
```

统一处理 API 配置、超时、拒绝、截断、Schema 校验失败和有限重试。业务服务中不要直接创建 OpenAI Client。

### 5.2 构造候选 Bucket

传给模型的内容只包含当前焦点和最近活跃 Bucket：

```json
{
  "id": "bucket_1",
  "title": "支付回调失败排查",
  "type": "incident",
  "status": "active",
  "summary": "第三方 502，已切备用通道",
  "last_active_at": "2026-08-01T10:40:00"
}
```

LLM 只能选择候选列表中真实存在的 ID；服务层必须再次验证 ID，禁止直接信任模型生成的引用。

### 5.3 实现 `classify_service.py`

```python
def classify_input(
    text: str,
    active_buckets: list[BucketView],
    current_focus_bucket_id: str | None,
) -> ClassificationResult:
    ...
```

先保证 `append_existing`、`create_new`、`ask_user` 三种动作稳定，不提前引入向量库或多 Agent。

### 5.4 验收

运行第四天标注集，并单独验证：

- “刚才那个支付问题恢复了”追加支付 Bucket。
- 新压测主题创建 `experiment`。
- 两个相似 Bucket 同时匹配时选择 `ask_user`。

## 6. 第六天：置信度门控与分类回归

目标：把 confidence 当作风险路由信号，而不是未经校准的正确概率。

### 6.1 初始路由策略

阈值必须配置化，并根据评估数据调整。保守初始值可采用：

```text
confidence >= 0.85 且候选唯一：自动归档
0.55 <= confidence < 0.85：询问或要求确认
confidence < 0.55：必须询问
```

遇到多个相似候选、模糊指代、类型冲突或高错误代价时，即使 LLM 分数较高也可以降级为询问。

### 6.2 记录分类证据

每次分类至少记录：

- action、bucket_id、confidence、reason。
- 候选 Bucket ID。
- 当前焦点 Bucket。
- Prompt/模型版本。
- 用户之后是否纠错。

### 6.3 校准与验收

按置信度区间统计实际正确率，重点检查高置信度自动归档是否达到 90% 以上。严重误合并必须单独列出，不能被平均准确率掩盖。每次修改 Prompt 或候选召回逻辑后运行同一标注集。

## 7. 第七天：实现结构化提取与入库

分类稳定后，再实现：

```python
def extract_info(text: str) -> ExtractionResult:
    ...
```

并在 `bucket_service` 增加：

```python
save_extraction(bucket_id, entry_id, extraction)
update_bucket_summary(bucket_id, entry_summary)
```

验收输入：

```text
支付回调 10:20 开始失败，第三方返回 502，待补复盘。
```

期望 summary 忠实，Evidence 包含 502，Todo 包含补复盘，Timeline 保留 10:20。普通测试必须 mock LLM；真实模型提取要检查事实忠实性和编造，而不只检查 JSON 是否成功解析。

## 8. 第八天：打通归档闭环并优先支持纠错

### 8.1 实现 `archive_service`

核心流程：

```text
输入校验
→ 读取候选 Bucket
→ 分类与风险门控
→ 必要时询问用户
→ 提取结构
→ 在同一事务中创建/追加并保存派生记录
→ 返回可读结果
```

数据库失败时不得返回成功。低置信度输入在用户确认前不得污染正式 Bucket。

### 8.2 实现最小纠错能力

优先支持：

```text
把刚才那条移到 XXX
```

处理时移动 Entry 及其 Todo、Evidence、Timeline 和 Decision，写入 `corrections` 快照，并更新来源与目标 Bucket 的摘要和活跃时间。

### 8.3 验收

连续运行 `tests/fixtures/sample_inputs.md`，确认：

- 同一事务能够稳定追加。
- 新主题不会错误合并。
- 歧义输入会询问。
- 最近一次错误归档可以移动并留痕。

## 9. 第九天：实现最小 Streamlit UI 与 Bucket 详情

页面保持简单：

```text
左侧：活跃 Bucket 和当前焦点
右侧上方：输入框
右侧下方：归档结果或确认问题
```

归档结果展示标题、类型、动作、confidence、reason，以及提取的 Todo、Evidence 和 Timeline。详情页展示摘要、时间线、Todo、Evidence、Decision 和原始 Entry，并提供明显的纠错入口。不要为了 UI 跳过分类原因和不确定性提示。

## 10. 第十天：实现搜索与 MVP 回归

实现 SQLite 关键词搜索：

```python
def search_buckets(query: str) -> list[BucketSearchResult]:
    ...
```

搜索范围包括 Bucket 标题、摘要、标签和 Entry 原文。完成后执行：

- 全部 Pytest。
- 分类标注集评估。
- 少量真实 LLM 分类和提取。
- Incident、Experiment、Meeting、纠错和搜索手工回归。
- 检查 `.env`、数据库和虚拟环境未进入 Git。

## 11. 每次开发的固定流程

每完成一个小功能，都做：

```bash
pytest
git status --short
git diff --check
```

涉及 UI 时再运行：

```bash
streamlit run ui/streamlit_app.py
```

涉及 Prompt、候选召回或分类逻辑时，必须额外运行固定分类标注集。测试通过后进行一个范围清晰的 Git 提交。

## 12. 常见坑

### 坑 1：先做复杂 UI

不要。先让分类、风险门控和纠错闭环可验证。

### 坑 2：把 LLM confidence 当真实概率

不要。它只是模型的主观信号，必须用人工标注集校准，并结合候选数量和错误代价。

### 坑 3：让 LLM 生成任意 Bucket ID

不要。只能从程序提供的候选 ID 中选择，服务层还要检查 ID 是否存在。

### 坑 4：不保存原文或纠错记录

不要。原文是唯一可靠事实，纠错是改进分类和用户偏好的关键反馈。

### 坑 5：把所有历史塞进 Prompt

不要。只传当前焦点和有限候选，历史原文通过搜索或摘要按需召回。

### 坑 6：只看平均准确率

不要。严重误合并和高置信度错误必须单独统计。

## 13. 版本里程碑

### v0.1：数据与输出契约

- 数据库、Bucket、Entry 可用。
- Pydantic 分类与提取 Schema 可用。

### v0.2：分类基线

- 固定人工标注集。
- 分类指标和回归流程可用。

### v0.3：风险感知分类

- LLM 分类可用。
- 候选 ID 校验、置信度门控和当前焦点可用。

### v0.4：提取与归档闭环

- 结构化提取入库。
- `archive_user_input` 完整事务可用。

### v0.5：纠错优先 MVP

- 最近 Entry 可移动。
- Correction 留痕和分类错误反馈可用。

### v0.6：可使用界面

- Streamlit 输入、确认、结果和 Bucket 详情可用。

### v0.7：找回与验收

- 关键词搜索可用。
- 分类、提取、纠错和搜索回归达到 MVP 门槛。
