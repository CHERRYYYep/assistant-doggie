# Doggie Local Web Frontend

本目录是 TypeScript Doggie 的本地 Web UI 源码边界，使用**严格 TypeScript + 原生 ES module**，不引入第三方 bundler：

- `index.html`：页面结构和静态挂载点，并加载 `assets/app.ts`。
- `assets/styles.css`：页面样式。全部颜色走 CSS 自定义属性，`:root` 与
  `@media (prefers-color-scheme: dark)` 各定义一套，支持浅色/深色主题。
- `assets/api.ts`：同源 HTTP API client，复用后端共享 DTO。
- `assets/dom.ts`：DOM 元素查找和状态提示。
- `assets/state.ts`：前端状态和聊天记录类型。
- `assets/markdown.ts`：Markdown 安全渲染器（纯函数，无 DOM 依赖，可单测）。
- `assets/render-bucket.ts`：Bucket 列表和详情渲染。
- `assets/render-archive.ts`：归档结果、确认和 Entry 修改渲染。
- `assets/render-chat.ts`：聊天消息渲染。
- `assets/render-query.ts`：记忆查询计划和结果渲染。
- `assets/views.ts`：请求、状态更新和视图控制器。
- `assets/app.ts`：应用入口、事件绑定和页面初始化。

浏览器不能直接执行带类型语法的 TypeScript。为保持源码可审查且不提交生成的 JavaScript：

- Node HTTP runtime 使用 Node 24 的 `stripTypeScriptTypes`，在响应 `/assets/*.ts`
  前剥离类型语法；
- 类型剥离只在内存中生成响应体，不写入或提交生成的 `.js` 文件；
- 浏览器继续通过 `/assets/*.ts` URL 加载模块，但收到的响应体是可执行的 JavaScript，
  MIME 类型为 `text/javascript; charset=utf-8`；
- 没有 Vite、Webpack 或其他第三方 bundler，模块依赖仍由原生 ES module 路径加载。

## 工具链

从仓库根目录运行 `npm start` 启动 TypeScript Web 服务。生产入口是 `src/main.ts`，
静态资源由 `src/http/app.ts` 从本目录加载；浏览器的 `/assets/` URL 不变。
前端源码和 DTO 合同测试通过 `../../src/http/` 复用共享 HTTP 类型，这些 type-only
import 在类型剥离后不会成为浏览器的运行时依赖。

仓库根目录负责类型检查和完整测试；本目录的 package script 适合单独检查前端资源：

```bash
# 仓库根目录
npm run typecheck     # 检查前后端共享 TypeScript 类型
npm run test:web      # API/DTO 合同和 Markdown 行为测试
npm run format:check  # 检查整个仓库格式

# 当前目录
cd web
npm run format:check  # 检查前端资源格式
npm test              # node --test，运行前端 .test.ts 测试
```

Node 24 是运行时要求；TypeScript 仅用于静态类型检查和编辑期约束，前端不依赖独立的
TypeScript 编译产物。

## 安全约束

服务端下发的 CSP 是 `default-src 'none'; script-src 'self'; style-src 'self'; …`，
因此：

- **不得使用内联 `style="…"` 属性或 `<style>` 块**——会被浏览器拒绝执行。
  通过 JS 设置 `element.style.someProperty` 不受影响（CSSOM 属性赋值不在 CSP 管辖内）。
- **不得使用内联 `<script>`**，所有脚本必须是同源外部文件。
- 不得引用任何外部域的资源。

`assets/markdown.ts` 的输出会被赋给 `innerHTML`，所以其中的转义不是样式问题而是
安全边界。行为由 `tests/markdown.test.ts` 覆盖，包含每条规则对应的注入载荷。
**不要用“源码里是否包含某个字符串”来测试它**——那种断言在重命名或重新格式化时会
误报，而真出漏洞时会漏报。

## T12 后台聊天任务

发送消息使用 `POST /api/tasks`（共享 `ChatRequest`），不再同步调用 `/api/chat`。
任务快照通过 type-only import 复用 `src/domain/task.ts` 的 `TaskSnapshot`；快照不含结果，
到达 succeeded / failed / cancelled 后，重新读取现有聊天历史和活跃 Bucket。
同步归档确认仍使用 `/api/chat/confirm`。

- `api.ts` 是唯一网络边界：SSE fetch streaming 解析分块 UTF-8、CRLF 和多行 data，
  校验 UUID、正整数 revision 和有限状态，忽略旧 revision，并限制事件大小与数量。
- 每个任务只尝试一次 SSE 连接；35 秒无数据时关闭观察连接（服务端每 15 秒心跳），
  断流后查询同一个任务，最多 60 次 GET、间隔 3 秒，单请求 10 秒，整体观察预算 5 分钟。
  达到上限显示“跟踪已暂停”，不自动重连、不重新 POST、不自动取消后台工作。
- 页面启动和“刷新任务状态”通过 `GET /api/tasks` 恢复最多 40 个近期任务。
  并发刷新合并；历史中多个终态只批量刷新一次结果。取消按钮始终使用
  `POST /api/tasks/:id/cancel`，JSON body 为 `{}`。只有服务端终态才能确认取消完成。
- 提交/取消响应丢失时明确提示结果未确认，要求刷新状态，而不是自动重试写请求。
- 聊天记录按消息 ID 复用未变化的行，保留确认表单输入；内容变化时只更新对应行。
  简化 DOM harness 保留全量渲染回退；重复 ID 也不做不安全的节点合并。
  并发历史/Bucket 查询使用请求版本防止旧响应覆盖更新结果。

`tests/tasks.test.ts` 覆盖协议解析、有界轮询/超时及断流恢复；
`tests/ui-tasks.test.ts` 和 `tests/dom-harness.ts` 执行真实模块，覆盖提交、恢复、取消、
终态结果刷新、确认 API、XSS 和 keyed rendering；`tests/module-contract.test.ts`
检查类型剥离后的浏览器模块图、唯一网络边界和 CSP 兼容结构。均为 fake transport，
不调用模型或访问真实用户数据库。
