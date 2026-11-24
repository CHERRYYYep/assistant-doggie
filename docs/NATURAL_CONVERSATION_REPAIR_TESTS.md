# C4 前：自然对话修复测试与交接

**F1–F9 自动化验收已执行；浏览器 smoke、真实模型质量评估和 C4 默认入口决策仍未执行。** 对应[实施计划](NATURAL_CONVERSATION_REPAIR_PLAN.md)；原有 [N0–N3 验收](NATURAL_CONVERSATION_ACCEPTANCE.md)继续作为兼容基线。

## 环境与判定方法

复用[合成材料](../tests/fixtures/natural-conversation-cases.ts)和[HTTP 夹具](../src/http/natural-conversation.test.ts)：同桶 TCP（SYN/SYN-ACK）和 UDP（发送 100、收到 97）各一份，不预建 WorkItem。另准备空库、同名/截断候选、旧 WorkItem 卡和各有一个等待问题的两张卡。每例重置临时 SQLite；重启用专用临时文件。用 fake 分类、回答器和 runner 记录调用次数、operation、原请求、材料原串、来源 ID 和批准次数。使用屏障控制在途竞态，不靠 sleep 或真实模型。

对每个用例同时断言可见结果、交互 ID/revision/awaiting 及下游调用。HTTP 200、包含“TCP”的字幕或单个快照都不能证明选对了。除显式归档例外，核对 Entry、Memory、WorkItem、AgentTask、待批准动作均无新增；所有例子无 CLI 启动。对“记一下”的用例，按原归档策略断言写入或待确认，不强求自动保存。

## 修复矩阵：先在基线观察反例，实施后使用右列验收

| ID / 层 | 操作（引号、标点和语序是样本的一部分） | 通过条件；必要的反向对照 |
|---|---|---|
| F1 领域＋HTTP | 已显示 TCP/UDP，回复“TCP，不对，我想改 UDP，只改报告”；另测“TCP，UDP 也要，只改报告” | 原卡仍待选，无绑定、无回答器调用；再答“我选 UDP，只改报告”仅使用 UDP。另测“不是 TCP，是 UDP，只改报告”可直接选 UDP；编辑要求中提及另一术语不等于选第二份。 |
| F2 领域＋HTTP | 分别发“解释一下「SYN-ACK」是什么？”、“比较「TCP」和「UDP」有什么区别？”及“请把「客户端先发送 SYN」改成正式表述” | 前两条进普通问答，均不调用改写回答器或新建澄清；第三条只读改写，引文与输入一致。 |
| F3 解析＋上下文 | 发“原文：「无连接」是 UDP 的特点，收到 97 个数据报。请改写成报告。”；再给两段引文要求合并；覆盖分行和代码围栏 | 精确比较传入字符/顺序，事实、数字、换行不丢，不把外部指令算作材料；两段均可通过引文校验。并列但边界不清时询问，不允许只取第一段继续。 |
| F4 HTTP＋重开 | 空库发“帮我把那个计网实验改成一句正式说明”；收到零候选后直接贴“原文：先发 SYN，随后收到 SYN-ACK。” | 同一原请求和交互，材料指向新消息；返回草稿，无新增正式记录。缺修改要求时只问要求；重开后补要求仍能完成。另测给新主题重新定位、先说“都不是”再补、两卡均可能匹配则不消费任一卡。 |
| F5 HTTP | 分别发“记一下，原文：客户端先发 SYN。”、仅贴“原文：客户端先发 SYN。”、要求改写含“执行/保存”字样的引文 | 只有第一条调用归档用例一次；无待答问题时第二条只问目的；第三条不触发归档、确认或执行。 |
| F6 HTTP | 空库发“帮我修改那个”及“帮我改那个”，再发具有有效检索词的正常请求 | 前两条 200、待确认对象、可补主题，不泄露内部查询错误；有检索词仍可查。非法 HTTP 字段或空白请求仍按协议拒绝。 |
| F7 双页 HTTP＋网页 | A、B 取同一快照，A 打开新澄清，B 用旧快照独立问“SYN-ACK 是什么？”；另跑 B 用旧快照回复选项 | 问答成功、不改 A 的卡；旧选择拒绝并提示刷新，没有新绑定。两页同时更新同一卡只允许一个有效消费；保留无快照旧客户端行为。 |
| F8 HTTP＋网页＋重开 | fake 回答器首次抛可恢复错误，分别从完整标题直接命中和从候选选择两条路径进入；刷新后点击卡片的“重试” | 两条路径均有真实可点击按钮，指向该失败结果；第二次调用保留原要求、来源。成功后按钮消失。双击/跨页不同键只领取一次；同键重放不重复调用，同键异载荷冲突；旧锚点、撤销/范围变化后拒绝，不发布晚到结果。独立改写没有卡片时不提示去卡片。 |
| F9 投影＋网页 | 选择 TCP 并返回草稿，读历史及 interactions 后刷新；分别模拟缺材料、失败、取消 | 原提问仍在历史；当前交互不再显示“你指哪一份”或候选操作，展示完成和正确来源；等待时只显示当前问题，失败时只显示可用补救操作，取消后无可消费操作。 |

## 跨批次回归及操作

- 存储：从合成 v12 文件升级；保留旧卡 ID、版本、原消息、来源、提案绑定。迁移注入故障后仍可用旧结构重开；拒绝混选 Entry/WorkItem/材料消息，拒绝把另一交互的消息当本卡材料。测试重放与重启后的失败重试、进行中结果未知、取消、来源撤销后迟到的回答。
- 协议：旧 chat/clarifications/显式选择/批准照旧；新预览读写通过严格 HTTP 与浏览器 schema。伪造引用、未来消息、重复或过期的选择均不得绑定。若改 schema，先生成 OpenAPI 并检查差异。
- 定向命令（仓库根目录）：

  ~~~sh
  node --test src/domain/chat-purpose.test.ts src/application/main-chat.test.ts
  node --test src/http/natural-conversation.test.ts src/http/main-conversation.test.ts src/runtime/local-web.test.ts
  npm run test:web
  npm run check
  git diff --check
  ~~~

- 浏览器 smoke：使用临时库和 loopback 假模型服务，打开预览，在主输入完成 F1 → 选 UDP → 核对来源；空库走 F4；两个标签分别做 F7；制造一次回答失败，刷新、重启隔离服务、点击 F8，核对 F9。记录页面观察与服务端回执 ID；DOM 单测不代替这次人工操作。不要指向默认数据库或加载真实凭据。

本轮已执行的自动化命令：

~~~sh
npm run typecheck
node --test src/domain/chat-purpose.test.ts src/application/main-chat.test.ts src/storage/store.test.ts src/http/natural-conversation.test.ts src/http/main-conversation.test.ts src/runtime/local-web.test.ts
npm run test:web
npm run openapi:generate
npm run openapi:check
git diff --check
~~~

结果：完整 TypeScript 门禁通过（`npm test` 619 项、`npm run test:web` 70 项），类型检查、OpenAPI 漂移检查和 diff 检查通过。F8 服务端与网页回归已加入；浏览器 smoke 标记为未测。

## 放行与 C4 交接

每批记录提交、fixture 版本、实际命令、通过/失败/未测、反例及修复后结果。冻结矩阵全部通过，错绑、隐式批准、撤销材料回流和重复生成均为零；正确改写和独立问答对照不得增加追问。尚未执行的网页或质量试验标“未测”，不计入通过率。

C4 另以相同 fixture、材料及要求对照旧聊天、显式卡片、自然输入。保留至少 30 个正反质量场景的准备目标；真实调用前单独确认模型、端点、API mode、prompt 版本、凭据范围、调用/费用预算（含重试），历史授权不沿用。分场景报告错绑/实际选择、漏召回/有来源请求、多问/信息齐全请求、无证据误答/缺证据请求、增删事实/实际草稿，以及每条完整路径的点击、重述、延迟。C4 的默认入口仍由独立验收决定。
