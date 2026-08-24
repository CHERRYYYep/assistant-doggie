# Doggie Local Web Frontend

本目录是 `doggie-local-web` 的本地 Web UI 源码边界，使用**严格 TypeScript + 原生 ES module**，不引入第三方 bundler：

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
- Rust 参考入口的 Cargo `build.rs` 也使用 Node 24 的原生剥离能力，在编译时生成
  `OUT_DIR` 下的临时 JavaScript，再嵌入 `doggie-local-web`；
- 两条路径都只生成临时产物，生成的 `.js` 不提交；
- 浏览器继续通过 `/assets/*.ts` URL 加载模块，但收到的响应体是可执行的 JavaScript，
  MIME 类型为 `text/javascript; charset=utf-8`；
- 没有 Vite、Webpack 或其他第三方 bundler，模块依赖仍由原生 ES module 路径加载。

## 工具链

仓库根目录负责类型检查和完整测试；本目录的 package script 适合单独检查前端资源：

```bash
# 仓库根目录
npm run typecheck     # 检查前后端共享 TypeScript 类型
npm run test:web      # API/DTO 合同和 Markdown 行为测试
npm run format:check  # 检查整个仓库格式

# 当前目录
cd apps/doggie-local-web/frontend
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
