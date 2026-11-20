# 自然续接与历史材料定位验收记录

2026-11-20 · N0–N3 自动化验收已完成；C4 默认入口决策未完成。

## 交付范围

N0–N3 已在 `codex/natural-conversation` 实施。新增 `action: utterance` 与 `GET /api/conversation/interactions`，网页预览模式发送已观察的问题快照；回复关联仍由服务端依据问题 ID、revision 和当前候选验证。schema v11 增加等待类型与提问引用，v12 增加 Entry/WorkItem 联合主题引用。旧 `/api/chat`、显式澄清卡和批准/归档合同保留；预览默认关闭，当前没有切换默认入口。

支持的路径包括：自带原文的直接改写；用主输入框回答已观察到的澄清；从有效 Entry 或 WorkItem 来源定位材料；只读生成带来源的草稿；插话保持独立；对歧义、失效来源、陈旧页面、重放和晚结果采取保守处理。仅有历史聊天或磁盘文件不作为可检索记忆。没有自动归档、自然语言批准、文件写入、隐藏会话拆分或腾讯记忆生产接入。

实现和场景规格见[设计文档](NATURAL_CONVERSATION_DESIGN.md)及[专项测试方案](NATURAL_CONVERSATION_TEST_PLAN.md)。主要代码位于 [`main-conversation.ts`](../src/application/main-conversation.ts)、[`conversation-subjects.ts`](../src/application/conversation-subjects.ts)、[`natural-reply.ts`](../src/domain/natural-reply.ts)、[`clarifications.ts`](../src/storage/clarifications.ts) 和网页 `web/assets/`。

## 验证结果

| 检查 | 结果 |
|---|---|
| `node --test src/http/natural-conversation.test.ts` | 19/19 通过，覆盖迁移、歧义、快照、幂等、撤销、故障恢复和 N3 对照。 |
| `npm run check` | 通过：格式、类型检查、OpenAPI 漂移检查、609 个后端测试、68 个前端测试。 |
| `git diff --check` | 通过。 |
| N3 loopback 集成 | 临时 SQLite、合成材料和 fake model；服务重启后读取同一澄清并在主输入接续，来源有效且未产生 WorkItem。 |
| 前端合同测试 | 68/68 通过，覆盖已观察快照、显示服务端实际关联、Entry 来源、陈旧响应和安全渲染。 |

N3 固定数据对照覆盖旧 `/api/chat`、C3 显式卡片操作与自然输入：旧聊天路径不会从已归档 Entry 建立主对话澄清；显式卡片路径要求选择并继续；自然输入可从两个 Entry 询问区分项、在主输入绑定 TCP 并返回带来源草稿。此结果只证明冻结合成场景中的合同，不证明开放式自然语言质量普遍优于旧路径。

有限浏览器手工 smoke 使用隔离临时数据库、合成 Entry 和替身数据完成：候选可见、主输入可接续、来源可见、服务重启后问题恢复、另一页的旧快照显示陈旧提示。手工插话步骤当时未接入模型回答替身，页面显示临时不可用提示；插话不消费等待问题由自动化用例验证。未运行真实模型，也未进行完整跨浏览器、触控/软键盘或长期真实自用验收。

## 限制与剩余事项

- 回复关系目前是确定性规则，不调用 LLM 来判断 `independent / reply / uncertain`。`计网` 扩词和“三次握手”区分是窄规则，不代表通用语义理解。
- Entry 定位复用本地词法查询，不是向量/RAG 新实现；只有当前有效、可检索的归档 Entry 和 WorkItem 来源会参与。
- 逐字引文校验只能证明来源存在，不能证明改写忠实或事实完整。真实模型质量实验需要另行明确当轮端点、API mode、prompt 版本、凭据使用范围和预算；此轮未读取 `.env`、未调用真实模型。
- 自然续接仍是网页预览模式，旧入口和默认 UI 不变。C4 还需使用冻结样本完成质量/操作步数对照，并由用户决定是否切换默认入口。真实自用验收与视觉改版按此前决定继续延后。

## 后续入口

进入 C4 前先冻结真实模型实验的配置和预算，使用同一批合成场景比较意图分支、来源召回、错绑、额外追问、无证据误答和改写新增事实；记录失败归因和未测项。人工浏览器 smoke 应使用专用临时数据库并复现插话与刷新/重启路径。未完成这些评估前，不应将预览设为默认或宣称自然对话理解已通过。
