# Doggie Local Web Frontend

本目录是 `doggie-local-web` 的本地 Web UI 源码边界，使用无构建步骤的静态 HTML/CSS/JS：

- `index.html`：页面结构和静态挂载点。
- `assets/styles.css`：页面样式。
- `assets/app.js`：前端状态、同源 `/api` 请求、Markdown 安全渲染和事件绑定。

Rust 后端在 `src/frontend.rs` 中通过 `include_str!` 读取这些文件，并同源提供 `/`、`/index.html`、`/assets/styles.css` 和 `/assets/app.js`。当前阶段不引入 Node/npm/Vite；如未来 UI 继续增长，可在保持 `/api` 契约的前提下再添加前端构建链。
