# Personal Work Memory Agent

一个面向个人工作的长期事务记忆 Agent。用户把日志、想法、会议结论、实验记录和排障证据输入系统后，Agent 会判断应追加到已有 `Bucket`、创建新 `Bucket`，还是先请求用户确认，并把原文与结构化结果保存为可追溯记忆。

> 当前仓库已完成本地单用户 MVP：分类评估、风险门控、结构化提取、事务归档、纠错、Streamlit 界面和 SQLite 关键词搜索均已实现。

## 核心理念

- 一个输入框，不要求用户预先整理文件夹。
- Bucket 表示持续存在的事务上下文，不是无限增长的聊天记录。
- 仅高置信度且候选唯一时自动归档；其他情况先确认。
- 保存原始 Entry，并提取摘要、Todo、Evidence、Timeline 和 Decision。
- 所有派生信息可追溯到原文，误归档可移动并保留纠错记录。
- `confidence` 是待校准的风险信号，不等于真实正确概率。

## MVP 能力

1. 从当前焦点和活跃 Bucket 中构造有限候选。
2. 使用 OpenAI Structured Outputs 分类和提取。
3. 校验模型返回的 Bucket ID，并应用可配置置信度门控。
4. 在同一事务中保存 Bucket、Entry、结构化记录和分类审计。
5. 支持确认追加、确认新建和移动最近 Entry。
6. 在 Streamlit 中查看详情并通过关键词搜索历史。

## 技术栈与目录

- Python、SQLite、SQLAlchemy、Pydantic、OpenAI API、Streamlit、Pytest。
- `app/`：模型、Schema、Prompt、LLM 封装和业务服务。
- `ui/streamlit_app.py`：本地交互界面。
- `tests/`：单元、集成、UI 测试与固定评估样例。
- `docs/`：产品、架构、数据模型、测试和开发说明。

## 快速开始

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 在 .env 中填写 OPENAI_API_KEY 和可用的 OPENAI_MODEL
python -m app.main
streamlit run ui/streamlit_app.py
```

运行自动化测试和透明规则分类基线：

```bash
pytest -q
python -m app.evaluation --baseline
```

少量真实模型分类与提取评估会产生 API 调用：

```bash
python -m app.live_evaluation \
  --limit 3 \
  --output /tmp/classification-live-report.json
python -m app.live_extraction_evaluation \
  --limit 3 \
  --reference-date 2026-08-03 \
  --output /tmp/extraction-live-report.json
```

报告会保留模型名、Prompt 版本、生成时间、完整结构化输出和指标。分类报告可重新交给 `app.evaluation` 计算指标；提取报告可交给 `app.extraction_evaluation` 检查必需事实遗漏、禁用事实和原文中不存在的数字。自动检查只是人工语义审查的辅助，不能独立证明提取没有幻觉。

## 文档阅读顺序

1. [`docs/PRD.md`](./docs/PRD.md)：产品目标与边界。
2. [`docs/MVP_SPEC.md`](./docs/MVP_SPEC.md)：MVP 功能定义。
3. [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md)：数据如何持久化。
4. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)：服务和数据流。
5. [`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md)：逐日开发步骤。
6. [`docs/DAYS_4_TO_10_IMPLEMENTATION.md`](./docs/DAYS_4_TO_10_IMPLEMENTATION.md)：本阶段实现、原因和限制。
7. [`docs/LONG_TERM_BUCKET_MEMORY.md`](./docs/LONG_TERM_BUCKET_MEMORY.md)：长期 Bucket 记忆设计。
8. [`docs/TEST_PLAN.md`](./docs/TEST_PLAN.md)：验收策略。
9. [`docs/ROADMAP.md`](./docs/ROADMAP.md)：后续路线。

## 当前边界

MVP 暂不包含多用户、云同步、附件、向量检索和复杂 Agent 编排。`hypotheses` 与 `entities` 已能由 LLM 输出，但尚未持久化；滚动摘要是可重建缓存，原始 Entry 始终是事实来源。
