# Doggie 测试与验收计划

## 1. 固定门槛

每次提交前运行：

```bash
cargo fmt --all -- --check
cargo check --workspace --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
cargo test --workspace --offline
git diff --check
```

## 2. 测试分层

### Core

覆盖 Bucket 类型/状态、分类 action、候选排序、confidence 门控、低信息输入、时间解析和查询计划边界。

### Protocol、LLM 与 Agent Runtime

覆盖严格 JSON 字段、未知字段、长度限制、Responses/Chat Completions 请求体、拒绝/截断/非法 JSON、网络错误分类、重试上限、工具 allow-list 和上下文资源上限。

### Store

覆盖 canonical schema 初始化/重开、外键、事务提交和回滚、归档图、对话消息、纠错、状态变化、关键词查询、结构化字段查询和 evidence 去重。所有数据库使用临时文件。

### Application 与 Engine

覆盖：

- 自动追加、新建和 `ask_user` 不写 Entry；
- 低信息输入即使高 confidence 也要求确认；
- 确认必须绑定 pending attempt 和原文；
- 多 Entry、多 Bucket、时间/状态/结构化筛选的自然语言查询；
- 失败不产生部分写入；
- 重启后对话和归档状态可恢复。

### Local Web UI

覆盖健康检查、静态 UI、API 参数校验、UTF-8 query 解码、归档 projection、确认卡片字段、四种确认选项、修改 Bucket 入口和稳定错误 JSON。静态前端资源还要检查 Markdown 渲染契约：代码围栏（含 `bash` 语言标签）、段落/列表/标题/引用/链接、代码换行保留、危险 URL 拒绝、HTML 转义以及渲染器不能被重复声明覆盖。

## 3. 手工验收

启动：

```bash
cp .env.example .env
cargo run -p doggie-local-web
```

依次验证：

1. 输入一个含具体数字/事实的新记录，确认自动归档；
2. 输入“它现在正常了”或“压测结果更新了”，确认页面显示“尚未保存”和完整四项选择；
3. 选择推荐 Bucket、其他 Bucket、新建和不保存；
4. 在归档结果中移动 Entry，确认 Bucket 详情和审计同步更新；
5. 输入“查询接口 A 最近两周的压测结果”，确认结果可跨多个 Entry/Bucket，并展示 query plan 和 evidence 来源；
6. 重启服务，确认聊天历史、Bucket 和 pending 状态符合预期。

普通测试不得调用真实模型。真实模型只用于明确的人工 smoke test，并且不得把 API Key 或真实数据库带入测试产物。
