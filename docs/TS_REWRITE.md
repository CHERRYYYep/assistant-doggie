# Doggie TypeScript 重写

## 当前分支状态

| 分支 | 内容 | 用途 |
|---|---|---|
| `main` | 原始 Python 实现 | 历史 |
| `dev` | Python + Rust 并存 | **Python 参考实现**，`128 passed in 6.18s` |
| `dev_rust` | 纯 Rust workspace | **Rust 参考实现**，124 个测试 |
| `dev_ts` | ← **当前**，从 `dev_rust` 分出 | TypeScript 目标实现 |

## 为什么重写

Rust 版本用 **19,010 行**实现了 Python 版本 **3,542 行**的同一个产品（5.4×）。差距不在业务逻辑，在生态税：HTTP 服务器、SQLite schema/迁移、JSON 契约校验、LLM 适配、Agent 工具循环——这些在 Python/TS 生态里是白给的，在 Rust 里全部手写。

而接下来要做的东西（Agent 编排、插件、任务队列、SSE）恰好是 Rust 最吃亏的方向：没有官方 Anthropic SDK，没有 Claude Agent SDK，没有稳定 ABI 因此没有像样的插件方案，而且现有代码是同步的，加后台执行器意味着引入 tokio 重构全栈。

## 技术选型

依赖刻意保持极少，延续原项目「不轻易加依赖」的原则：

| 需求 | 选择 | 依赖数 |
|---|---|---|
| 运行 TS | Node 24 原生类型剥离（`node src/main.ts`） | 0 |
| SQLite | `node:sqlite` 内置（`DatabaseSync`，同步 API） | 0 |
| 测试 | `node --test` 原生跑 `.ts` | 0 |
| 类型检查 | TypeScript（`tsc --noEmit`，仅检查不产出） | 1 |
| 边界校验 | zod | 1 |
| HTTP | Hono | 1 |

`tsconfig.json` 开了 `erasableSyntaxOnly`——编译器会拒绝任何无法被类型剥离的语法（enum、namespace、参数属性），因此 `node src/main.ts` 从构造上就不会失效，**不需要构建步骤**。

## 目录

```
src/
  domain/       领域类型、Zod 契约与确定性规则
  storage/      node:sqlite，canonical schema 与事务
  application/  归档、确认、纠错、查询与后台队列
  llm/          模型端点、结构化输出与 wire 协议
  agent/        多轮只读 Harness、工作区与 CLI 编排
  http/         Hono 路由、DTO、安全边界、Node adapter
  mcp/          MCP stdio 服务与严格工具
  runtime/      配置和生产组装
web/            浏览器 TypeScript UI
docs/
  INVARIANTS.md ← 重写的验收标准
```

## 验收标准

**`docs/INVARIANTS.md` 是这次重写的规格。**

它不是设计文档，是从 Rust 124 个测试 + Python 79 个测试里提取出来的行为清单，每条都对应至少一个已经通过的测试。每完成一层，对应章节的每一条都必须有一个可执行测试——**不允许用「代码看起来做了这件事」代替测试**。

## 两份参考实现随时可查

```bash
git show dev_rust:crates/doggie-domain/tests/classification.rs   # Rust 行为
git show dev:app/services/archive_service.py                     # Python 行为
```

2026-11-03，T13 完成并通过全部 85 条不变量验收，当前分支已删除 Rust workspace。参考源码保留在 Git 历史（移除前 `bc88675`），parity fixture 保留在 `tests/fixtures/`。启动、测试、CI 均只需要 Node/TypeScript。完整范围和限制见 [TS_ACCEPTANCE.md](TS_ACCEPTANCE.md)。

## 命令

```bash
npm install
npm run check      # format:check + typecheck + test + test:web
npm test           # TS 测试
npm run test:web   # 前端测试（S2/S3 成果，直接复用）
```
