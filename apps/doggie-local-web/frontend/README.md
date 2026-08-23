# Doggie Local Web Frontend

本目录是 `doggie-local-web` 的本地 Web UI 源码边界，使用**原生 ES module，无打包构建步骤**：

- `index.html`：页面结构和静态挂载点。
- `assets/styles.css`：页面样式。全部颜色走 CSS 自定义属性，`:root` 与
  `@media (prefers-color-scheme: dark)` 各定义一套，支持浅色/深色主题。
- `assets/markdown.js`：Markdown 安全渲染器（纯函数，无 DOM 依赖，可单测）。
- `assets/app.js`：前端状态、同源 `/api` 请求和事件绑定。

Rust ��端在 `src/frontend.rs` 中通过 `include_str!` 读取这些文件，并同源提供
`/`、`/index.html`、`/assets/styles.css`、`/assets/app.js` 和 `/assets/markdown.js`。

## 工具链

Node 仅用于**格式化和测试**，不参与产物构建——服务端直接内嵌源文件。

```bash
cd apps/doggie-local-web/frontend
npm install          # 只装 prettier
npm run format       # 格式化
npm run format:check # CI/提交前检查
npm test             # node --test，运行渲染器行为测试
```

## 安全约束

服务端下发的 CSP 是 `default-src 'none'; script-src 'self'; style-src 'self'; …`，
因此：

- **不得使用内联 `style="…"` 属性或 `<style>` 块**——会被浏览器拒绝执行。
  通过 JS 设置 `element.style.someProperty` 不受影响（CSSOM 属性赋值不在 CSP 管辖内）。
- **不得使用内联 `<script>`**，所有脚本必须是同源外部文件。
- 不得引用任何外部域的资源。

`assets/markdown.js` 的输出会被赋给 `innerHTML`，所以其中的转义不是样式问题而是
安全边界。行为由 `tests/markdown.test.js` 覆盖，包含每条规则对应的注入载荷。
**不要用"源码里是否包含某个字符串"来测试它**——那种断言在重命名或重新格式化时会
误报，而真出漏洞时会漏报。
