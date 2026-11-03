# TypeScript 重构与 T13 验收记录

日期：2026-11-03。分支：`dev_ts`。移除前参考提交：`bc88675`。

## 结论

**TypeScript 重构验收通过，T1–T13 完成。** 现有领域规则、归档/确认/查询、持久化、HTTP 安全、Web、评测、MCP、队列/SSE/取消和只读 Agent 控制面均由 TS 实现。`docs/INVARIANTS.md` 原 85 条不变量已覆盖；最后九条 Harness 规则由本阶段双 API 测试补齐。

当前分支已移除 Git 跟踪的 Rust workspace 与 Cargo 文件，启动和 CI 无 Cargo 依赖。T14–T17 是后续产品能力，不是语言迁移尚未完成的阶段。

## 验证结果

| 检查 | 结果 |
|---|---|
| 删除前 `npm run check` | 329 后端 + 51 前端通过 |
| 删除后最终 `npm run check` | **331 后端 + 53 前端 = 384 通过，0 失败，0 跳过** |
| 格式检查 | Prettier 通过 |
| 严格类型检查 | `tsc --noEmit` 通过，无构建产物 |
| 补丁空白检查 | `git diff --check`、`git diff --cached --check` 通过 |
| Rust/Cargo 跟踪文件 | 0 个 `.rs`、根 Cargo manifest/lock；`crates/` 和 `apps/` 的跟踪文件已移除 |
| 依赖 | `package.json`、`package-lock.json` 无变化，无新增依赖 |
| 两份现行 parity fixture | 与移除前 HEAD 字节相同；919 条门控语料全部保留 |
| 历史 protocol fixture | 从原位置迁到 `tests/fixtures/protocol-contract-cases.json`，JSON 语义相同 |
| 本地浏览器 smoke | 提案显示 pending → 独立批准 → succeeded/结果 → 刷新恢复；假输出中的 script 按文本展示 |
| 真实 socket 集成 | runtime → HTTP → 批准 → queue → fake runner → SSE → 最终结果通过 |

最终追加两项后端回归，验证同路径不同 Git 基线仍互斥，以及队列容量拒绝回滚/批准后目录变化阻止启动；另追加两项前端回归，拒绝畸形响应/不重复批准 POST，并验证合并刷新补取新快照。故最终比删除前多四项。全部普通模型调用均为 fake；真实进程测试运行本机 Node 假 CLI，不消耗模型服务。

## T13 的关键结果

Q1 基线审查追加 8 项回归后，完整门禁为 **368 后端 + 53 前端 = 421 通过**。失败/取消 session 的提前创建恢复提案在批准与启动时再次拒绝；队列历史淘汰前在单事务结清 Agent/PendingAction，遗留缺失队列记录恢复为失败，反向成功状态报告存储故障。初始删除前后测试计数保留为历史验收记录。

- 固定只读记忆工具和有界模型循环，非法参数返回数据错误，工具输出及 reasoning 不能伪造系统角色。
- schema v5 三表、Bucket 工作区关联、不可变 session/workspace/backend 绑定与原文审批；旧 v4 对话、pending 和 queued 数据迁移测试通过。
- 真实路径/白名单/Git 内容基线、同路径及同会话互斥、明确批准后才入队，禁止 HTTP 直接注入 agent 引用。
- Claude/Codex 固定启动参数、stdin 指令、独立 CLI 认证、只读 MCP、有限 JSONL、终态/会话身份检查与进程组取消。
- 无目录任务具有稳定 0700 cwd；queued 重启恢复，running 中断不重放；落盘故障停止 worker。
- 网页可登记目录/关联 Bucket、创建和批准/拒绝提案、恢复会话、查看结果与取消，保留既有归档确认和纠错入口。

详细源码地图、配置和接口见 [AGENT_CONTROL.md](AGENT_CONTROL.md)，逐项测试定位见 [INVARIANTS.md](INVARIANTS.md) §7/§13 与 [TEST_PLAN.md](TEST_PLAN.md)。

## 验收范围与未作出的承诺

通过的是本地只读 MVP 的代码/合同验收。真实 Claude/Codex 的账号、模型调用、网络和 CLI 服务端行为尚未实测；当前参数通过本机 help 和官方接口核对，过旧 CLI 不会回退到宽权限。

目录绑定白名单不是文件访问沙箱；Codex read-only shell 可能读取工作区外的用户可读文件。Git 重检不是文件系统锁，外部程序仍可在检查后改变目录。正常取消/超时/关闭可回收进程组；父进程 SIGKILL 或机器故障不保证立即清理所有子进程。Web 仅本地同源边界，没有多用户身份认证。

尚未开放编码写入、自动提交/部署、定时执行或任意插件；T14 TODO、T15 调度通知、T16 插件、T17 导入导出继续留在 PLAN。没有调用真实模型、打开或迁移用户真实数据库、读取真实密钥，未推送 GitHub，远程 CI 尚需实际推送后执行。

Rust 删除只涉及当前分支跟踪源码；用户未跟踪 PDF 和本地忽略文件保留，其他分支未修改。历史再生成流程见 [fixture 来源说明](../tests/fixtures/README.md)。
