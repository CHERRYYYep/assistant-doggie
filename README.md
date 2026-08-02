# Personal Work Memory Agent

一个面向个人工作的碎片信息整理 Agent。用户只需要把日志、想法、会议结论、实验记录、排障证据等内容丢进一个输入框，系统自动判断应该归档到哪个 `bucket`，并沉淀为可追踪、可复用的工作资产。

> 当前仓库处于 **MVP 设计与脚手架阶段**。核心产品思路见 [`agent-product-thinking.md`](./agent-product-thinking.md)，开发落地文档见 [`docs/`](./docs)。

## 核心理念

- 用户体验：一个输入框，不要求用户手动建文件夹或整理笔记。
- 系统内部：维护多个持续存在的工作对象 bucket。
- 自动归档：高置信度直接归档，中置信度先归档再提示可修改，低置信度询问用户。
- 结构化沉淀：把碎片输入变成摘要、时间线、证据、TODO、决策和结论。
- 可纠错：用户可以用自然语言纠正分类、移动内容、合并 bucket。

## MVP 范围

第一版只验证一个闭环：

1. 用户输入一段文本。
2. 系统自动选择已有 bucket 或新建 bucket。
3. 系统提取结构化信息。
4. 系统保存原始输入和结构化结果。
5. 系统反馈“放到了哪里”。
6. 用户可以查看 bucket 的摘要、时间线、TODO、证据和原始记录。

## 推荐技术栈

面向新手，优先选择简单、可本地运行、易调试的方案：

- Python
- SQLite
- SQLAlchemy
- Pydantic
- OpenAI API Structured Outputs
- Streamlit
- Pytest

后续再升级到 FastAPI、PostgreSQL、向量检索、多端同步和多用户系统。

## 目录结构

```text
.
├── agent-product-thinking.md        # 原始产品思路
├── README.md                        # 项目入口说明
├── requirements.txt                 # Python 依赖建议
├── .env.example                     # 环境变量示例
├── docs/                            # 产品、架构、开发指导文档
├── app/                             # 后端/Agent 逻辑脚手架
├── ui/                              # Streamlit UI 脚手架
└── tests/                           # 测试与样例输入
```

## 文档阅读顺序

新手建议按顺序读：

1. [`docs/PRD.md`](./docs/PRD.md)：产品目标与边界。
2. [`docs/MVP_SPEC.md`](./docs/MVP_SPEC.md)：第一版具体功能。
3. [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md)：数据怎么存。
4. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)：系统怎么流转。
5. [`docs/COMPETITIVE_RESEARCH.md`](./docs/COMPETITIVE_RESEARCH.md)：参考产品和开源项目。
6. [`docs/DESIGN_RECOMMENDATIONS.md`](./docs/DESIGN_RECOMMENDATIONS.md)：结合竞品后的设计建议。
7. [`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md)：一步一步怎么开发。
8. [`docs/PROMPTS.md`](./docs/PROMPTS.md)：分类与提取 Prompt。
9. [`docs/TEST_PLAN.md`](./docs/TEST_PLAN.md)：如何验收。
10. [`docs/ROADMAP.md`](./docs/ROADMAP.md)：后续路线图。

## 快速开始，待实现

当前只提供骨架。后续实现后，预期启动方式：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
streamlit run ui/streamlit_app.py
```

## 当前开发原则

- 先做本地单用户 MVP，不急着做登录、权限、同步。
- 先用 SQLite，不急着上复杂数据库。
- 先做文本输入，不急着做截图、文件、语音。
- 先做一个主流程，不急着做多 Agent。
- 每个模块必须可单独测试。
