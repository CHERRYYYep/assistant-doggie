# 已有实现审查修复（2026-11-03）

本轮只处理已有证据的问题，不开展 T14–T17 或前端重设计。保护既有未提交内容，不访问真实数据库、密钥或真实模型。

## 修复内容

| 问题 | 修复与回归 |
| --- | --- |
| 自动归档可能追加到非 active Bucket | `Store.archive` 与直接 `appendEntry` 在写入事务内始终检查目标 active；暂停、完成、归档状态均拒绝。`src/storage/write-boundaries.test.ts` 检查图数据、审计和活动时间完全不变，重新激活后可重试。`src/application/archive-boundaries.test.ts` 覆盖候选生成后、模型提取期间状态变化。 |
| 纠错移动允许非 active 目标 | 同样遵循“非 active Bucket 不得成为写入目标”。移动前校验 lifecycle，拒绝时源 Entry、Memory、Bucket 及纠错审计不变；恢复 active 后可重试。已有 Web 移动选项使用 active 列表，无需增加新交互。 |
| 工作区符号链接可指向外部 | Git 和内容摘要之前有界枚举整个工作区（包含 ignored 路径和 Git 元目录），解析链接真实目标，拒绝越界、悬空、链式越界链接；正常内部链接保留。tracked/untracked 路径另逐层检查父目录。`src/agent/workspace.test.ts` 和 `control.test.ts` 验证登记与执行前复检；执行前引入越界链接时 runner 不启动。 |
| GET/HEAD 请求体绕过 JSON 媒体类型校验 | Node adapter 在 Fetch 转换丢弃请求体前检查实际 body。非空 body 缺失/非法 Content-Type 返回 415，重复头仍返回 400，空 body 保持豁免；HEAD 始终不发送响应体。`src/http/server.test.ts` 覆盖 Content-Length 与 chunked 真实 socket 请求。 |
| MCP proposal 与确认卡片分开提交 | 应用服务通过可选同步回调构造卡片，存储在归档事务内同时提交 pending action、审计和聊天消息。投影、序列化或 SQL 插入失败时全部回滚。`src/mcp/tools.test.ts` 故障注入验证恢复后重试只新增一组记录；storage 测试覆盖回调和序列化失败。 |
| MCP 暴露未知异常消息 | 复用已有稳定错误投影，未知异常仅返回 `internal server error`，保留受控业务错误。`src/mcp/server.test.ts` 通过 MCP 协议验证 Error 和非 Error 异常都不泄露原始信息。 |

工作区元数据扫描最多 100,000 个条目、10,000 个目录、5 秒；超预算拒绝工作区，不跳过某个目录后继续声称完成检查。扫描不读取普通文件内容，不跟随目录符号链接。原 Git buffer、未跟踪文件数量/内容预算仍保留。它仍不是文件系统沙箱或锁，不能消除检查后的外部修改竞态，也不限制 CLI 通过绝对路径访问本机其他位置。

## 删除 Entry 后 Memory 的规则待定

当前 schema 明确保留删除 Entry 后的 Memory（`ON DELETE SET NULL`），而 `INVARIANTS.md` §5.3 明确自然语言查询以有原文的 Entry 为结果单元。保留的 Memory 仍可在 Bucket detail 读取，但不会独立成为 Entry 查询命中。

这属于数据保留与检索合同需要共同决定的设计问题，不能用把 Memory 挂到其他 Entry、伪造原文或自动删除保留数据来补救。本轮保留现有数据规则，等待决定独立 Memory 检索或专属 Memory 随 Entry 删除的语义。

## 验证

- 定向回归：存储写入边界、提取期间状态变化、workspace/control、HTTP 真实 socket、安全头与流式资源限制、MCP 协议/故障回滚、archive/confirmation、pending actions、存储 parity、生产 Web 共库确认链路。
- 全量门禁：`npm run check` 通过（格式、严格类型检查、360 个后端测试、53 个前端测试；共 413 个，0 失败、0 跳过）。
- 差异检查：`git diff --check` 和 `git diff --cached --check`。
- 全部 fake model/transport，SQLite 内存或临时文件；没有运行真实 CLI/模型付费调用或远程 CI。
