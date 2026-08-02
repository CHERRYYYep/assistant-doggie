# Repository Guidelines（仓库贡献指南）

## 项目结构与模块组织

本仓库是一个 Python 个人工作记忆 Agent 的 MVP 骨架。业务代码放在 `app/`：数据库配置位于 `app/db.py`，数据模型与 Schema 分别位于 `app/models.py` 和 `app/schemas.py`，Prompt 放在 `app/prompts.py`，分类、提取、归档、搜索等流程拆分到 `app/services/`。Streamlit 界面位于 `ui/streamlit_app.py`。自动化测试放在 `tests/`，可复用的手工测试输入放在 `tests/fixtures/`。需求、架构、数据模型和测试方案保存在 `docs/`；行为或接口变化时，应同步更新相关文档。

`my_own_agent/`、`__pycache__/`、本地数据库和 `.env` 均属于本地或生成内容，不应提交。

## 构建、测试与本地开发

首次开发时创建独立环境：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

常用命令：

- `python -m app.main`：运行当前应用入口。
- `streamlit run ui/streamlit_app.py`：启动本地 UI。
- `pytest`：运行全部测试。
- `pytest tests/test_bucket_service.py -q`：仅运行指定模块测试。

当前项目无单独构建步骤。

## 编码风格与命名规范

遵循 PEP 8，使用四空格缩进，并为公共函数添加类型注解。模块、函数和变量使用 `snake_case`，Pydantic Schema 与 SQLAlchemy Model 使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。服务应职责单一，避免把业务逻辑直接写进 Streamlit 回调。Docstring 应简短说明用途和行为。项目暂未配置格式化或 lint 工具，提交前需主动整理导入、删除无用代码并保持一致风格。

## 测试要求

使用 Pytest。测试文件命名为 `test_<模块>.py`，测试函数命名为 `test_<行为>()`。重点覆盖数据库 CRUD、服务规则、Schema 校验和完整归档流程。普通测试必须 mock LLM 返回，不应调用真实 API；真实模型仅用于明确的手工验证。修改 Prompt 或分类逻辑后，按照 `docs/TEST_PLAN.md` 和 `tests/fixtures/` 执行回归检查。

## Agent 协作与执行规范

- **有求有应**：先确认任务目标和约束；存在关键歧义时说明假设，不擅自扩大范围。
- **有据可查**：修改前先阅读相关代码和文档，结论应基于仓库现状，不虚构命令、接口或测试结果。
- **有行有果**：实施修改后运行与改动直接相关的检查；不能运行时，明确说明原因和影响。
- **有错必报**：遇到失败、风险或兼容性问题应如实报告，不隐藏错误，不以绕过测试代替修复。
- **有始有终**：最终说明修改了哪些文件、实现了什么、执行了哪些验证，以及仍存在的风险或后续事项。
- **最小改动**：只修改完成任务所需内容，保留用户已有改动，不提交密钥，不执行未经要求的破坏性操作。

## 提交与 Pull Request 规范

当前检出内容不包含可用的 Git 历史，因此采用简短、祈使句式的提交信息，例如 `Add bucket creation service` 或 `Test correction routing`。每个提交只处理一个逻辑变更。Pull Request 应说明用户可见的变化、列出已执行的测试、关联相关 Issue 或设计文档；UI 变化需附截图。严禁提交 API Key、`.env`、本地数据库或虚拟环境。

在完成一个小的阶段性任务后需要主动进行git的提交