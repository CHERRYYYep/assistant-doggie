# C3 本地取证与受批准执行验收

2026-11-19。C3 在单用户、单机 TypeScript 主路径通过自动化验收，主对话预览仍是可选功能。

## 已交付行为

- 选择目标后可继续读取原请求、全部按序补充、目标约束和当前有效 Entry；不会用澄清卡列表里的最新一句替代完整上下文。
- 关联 Entry 足够时按 ID 读取并停止；不足时才执行有限本地检索。响应中的引用必须来自仍有效的 Entry 且摘录逐字匹配；模型无法证明证据时返回缺口或弃答。
- Entry 撤销、目标范围 revision 变化、目标取消或澄清卡失效会使进行中的回答退出提交路径。历史投影隐藏失效正文；Bucket 移动只刷新有效引用的当前位置。
- 准备只读检查要求显式工作区和已启用 CLI，先校验工作区快照，再在同一事务写入 conversation_attempt 提案。主对话不能携带批准字段，也不能直接调用 runner。
- 既有 Agent 审批入口负责批准和入队。启动、runner 返回与结果提交重新验证澄清卡、目标范围、来源和记忆版本；一目标只有一个有效执行尝试。结果只显示在对应卡片，工具输出不会自动成为 Entry、Memory、WorkItem 完成或 TODO 完成。
- v9 临时库升级到 v10 时，失败会回滚迁移；重开保留澄清卡、工作目标和聊天历史。旧 Agent/WorkItem 投影会隐藏已失效的 C3 派生正文。

## 自动化证据

- `node --test src/http/main-conversation.test.ts`：C3 重开恢复、证据引用、缺证据弃答、撤销与范围变化的迟到结果、v9→v10 迁移回滚。
- `node --test src/storage/conversation-execution.test.ts src/agent/control.test.ts src/storage/work-items.test.ts`：提案原子性、审批边界、单目标排他、启动/完成前的失效检查和结果投影。
- `node --test src/runtime/local-web.test.ts --test-name-pattern=C3`：真实 loopback 组装、工作区登记、提案零调用、显式 Agent 审批和结果回传。
- `npm run check`：完整 TypeScript/HTTP/OpenAPI/后端/前端门禁通过；当前报告为 582 项后端/项目测试与 66 项前端测试。
- `git diff --check`：通过。

## 当前边界

C3 不启用腾讯记忆、向量库、全历史检索、自动摘要、远程接入或多人协作；没有证明真实模型的任意自然语言理解质量。旧 `/api/chat` 和默认网页入口保持兼容，是否切换默认入口由 C4 对照验收决定。
