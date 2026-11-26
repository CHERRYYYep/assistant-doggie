# 个人助手核心流程联合验收

日期：2026-11-03–04（Asia/Shanghai，Q4 最终收口为 11 月 4 日）。范围为 Q4 的功能基线，不代表视觉风格定稿、真实模型质量验证、真实 CLI 账号可用性或远程接入已经交付。

## 自动验收方式

`src/runtime/core-flow.test.ts` 使用实际 Node HTTP server、随机 loopback 端口、临时 SQLite 文件和 fake `MemoryModel` / CLI runner。请求通过真实 socket 发送，JSON 响应按 `src/http/response-schemas.ts` 的严格 schema 解析；SSE 每帧按任务 schema 校验，并核对递增 revision 与事件 ID。测试不读取用户 `.env`、真实数据库或密钥，不访问公网、不调用真实模型或真实 CLI。

MCP 工具的 proposal 是独立 projection，包含 `submitted_for_confirmation`。历史 `details` 保留 JSON 扩展兼容能力；测试使用 HTTP archive schema 加显式 MCP 扩展校验该卡片，不把所有 MCP 数据误认成 HTTP 直接归档响应。

## 覆盖结果与证据

| 链路 | 自动验证的行为 | 证据 |
| --- | --- | --- |
| 输入与低信息门控 | 明确事实保存；高置信度模型对“那个任务继续”仍被降级询问，不调用提取、不新增 Entry | `src/runtime/core-flow.test.ts` 第一项 |
| 推荐 Bucket 确认 | 保留原文与四种动作；保存到推荐目标；相同批准重复调用返回冲突，不新增记录 | 同上 |
| 其他 Bucket、新建、不保存 | 可选择另一目标、创建明确标题/类型的新 Bucket；不保存不产生正式 Entry | 同上 |
| 检索与证据 | 自然语言查询返回有效 Entry，证据保留其来源 Entry；不保存内容不可检索 | 同上 |
| 移动 | Entry、Memory 与检索结果归属同步到目标 Bucket | 同上；存储事务回归见 `src/storage/entry-revocation.test.ts` |
| 撤销 | 重复撤销返回原结果；Entry、Memory、摘要及证据退出有效结果，历史卡片显示已撤销 | 同上；审计失败回滚、来源标签、孤立数据与模型历史边界见存储和 HTTP 撤销测试 |
| 重启恢复 | 历史响应逐项相同，未决确认保留原文且能继续批准，撤销状态持续生效 | 同上 |
| 意外中断恢复 | 预置的 running 任务重开后标为 interrupted，不重新调用模型 | 同上 |
| MCP / Web 共库 | MCP 提案仅待确认，Web 历史可恢复；用户显式批准后才形成有效记忆 | 同上；已有 `src/runtime/local-web.test.ts` 共库回归 |
| 后台聊天 | HTTP 202 后可从 SSE 读取终态；已成功任务取消仍显示 succeeded | `src/runtime/core-flow.test.ts` 第二项 |
| CLI 批准与取消 | 提案 pending 不运行；原文不匹配的批准失败；准确批准只触发一次 fake runner；运行中取消传播并落终态 | 同上；更完整工作区检查、只读 argv、资源与恢复会话约束见 `src/agent/control.test.ts` / `process.test.ts` |
| 排队取消 | CLI 占用 worker 时聊天保持 queued；取消后模型不提取、不写正式记忆 | `src/runtime/core-flow.test.ts` 第二项 |

第三项测试直接加载真实 `web/assets/api.ts` 浏览器 API 模块，把同源路径解析到本次临时 loopback 服务，保留实际 socket、响应读取和生成规则验证；覆盖同步聊天、后台任务/SSE、history、query、detail、move、幂等 revoke 和 discard。它不使用 DOM stub，也不把手写伪响应当作后端联调。

这些测试以 HTTP 的用户操作合同完成链路，必要时用临时库制造不可自然重现的中断现场。它们不模拟鼠标点击，也不能代替真实浏览器的布局与交互验收。

## 前端验收与限制

现有 `web/tests/ui-tasks.test.ts` 通过 DOM harness 覆盖确认/任务恢复、撤销显式确认、重复点击合并、失败后重试、查询失效、陈旧响应拒绝和历史卡片状态。`web/tests/markdown.test.ts`、模块与 DTO contract 测试覆盖 XSS 和前端调用边界。DOM harness 不计算真实布局、滚动尺寸或窄屏排版，因此不能据此声称人工页面验收通过。

真实浏览器检查使用 Codex In-app Browser、隔离临时 SQLite 和 fake MemoryModel，未连接用户运行中的服务或数据库。2026-11-03 实际记录：

| 检查 | 结果及边界 |
| --- | --- |
| 桌面加载、历史、CLI 空/禁用状态 | 默认桌面视口可见，页面脚本和生成验证模块正常加载，无初始 console error |
| 输入与确认 | Enter 提交后显示排队/终态与四个确认入口；选择推荐目标后显示已归档，并刷新 Bucket 摘要与历史 |
| 查询与移动 | 查询“项目甲延迟72ms”显示具体 Entry/evidence；页面“修改 Bucket”后目标详情包含两条 Entry，来源同步更新 |
| 撤销历史展示 | 原生确认弹窗阻塞浏览器工具，未把该点击报告为成功；随后对同一隔离测试记录调用真实 HTTP DELETE，再刷新页面，真实卡片显示“已撤销”，无移动/再次撤销操作，Bucket 摘要仅保留另一条事实 |
| 窄屏布局 | 临时设为 390×844，DOM 实测文档宽 375、小于视口 390；输入和发送按钮位于可视范围，无页面水平溢出；随后恢复默认 1280×720 |
| 仍待人工检查 | 原生确认弹窗的完整交互、窄屏真实触控/软键盘、完整长历史滚动和浏览器断线体验。本轮工具在弹窗之后不能可靠驱动点击，未将尺寸检查冒称窄屏点击验收 |

临时截图 `/tmp/doggie-q4-revoked.jpg` 与 `/tmp/doggie-q4-narrow.jpg` 可用于本轮审查，不是仓库或 CI 依赖。真实浏览器结果是有限 smoke；自动 DOM/socket/API 模块验证的覆盖见上文，不能替代全部人工体验签收。

## 复现与剩余边界

针对新增链路运行 `node --test src/runtime/core-flow.test.ts`；完整阶段门禁使用 `npm run check`。本阶段新增三项集成测试均通过，完整 `npm run check` 为 402 后端 + 58 前端通过，0 失败/跳过；包括格式、严格类型、OpenAPI/浏览器规则漂移门禁。

- Entry 撤销保留原文、聊天和审计，独立 Bucket 标题以及来源不明的 legacy 数据保持原样；这不是全库字符串清除。
- 检索会使用 Bucket 标题/摘要/标签扩展候选，同一 Bucket 的多个 Entry 可能成为候选；证据判定仍检查具体 Entry 与 Memory 来源，不能只断言返回数量等于一。
- 查询中的“完成”等自然语言可能表示 Bucket lifecycle 筛选；事实证据测试使用无 lifecycle 歧义的文本，不以含糊检索绕过既有语义。
- fake 模型、fake runner 证明授权和数据链路，不证明真实模型提取准确、真实 CLI 运行可用或恶意代码隔离。
- 手机接入、安全配对、认证、relay、离线同步及多人协作继续仅保留文档边界，见 `REMOTE_ACCESS.md`。
