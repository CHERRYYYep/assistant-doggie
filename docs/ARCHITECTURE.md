# Rust Work Memory MVP 架构

## 1. 组件

```text
浏览器 / curl
      │ HTTP
      ▼
work-memory-server
      │ 路由、JSON 校验、错误映射、内嵌 UI
      ▼
CanonicalRuntime<M>
      │
      ├── MemoryModel
      │     ├── StructuredOutputAdapter
      │     └── UreqStructuredOutputTransport
      │
      ├── 候选构造与置信度/低信息门控
      └── CanonicalService
              │
              ▼
        RustStore / SQLite
```

crate 职责：

- `work-memory-core`：Bucket、分类结果、提取结果、状态和确定性安全规则。
- `work-memory-contracts`：分类与提取的严格 JSON Schema，以及模型输出到领域值的校验。
- `work-memory-agent`：结构化模型请求、端点配置、HTTP transport 和重试边界。
- `work-memory-store`：Rust-owned SQLite schema、事务和持久化投影。
- `work-memory-service`：对 runtime 暴露稳定的归档、查询、纠错和状态服务。
- `work-memory-runtime`：组合模型调用、门控和归档闭环，并生成 API 投影。
- `work-memory-server`：单进程 HTTP listener、路由和内嵌 Web UI。

## 2. 请求数据流

### 2.1 自动归档

1. server 解析 `POST /api/archive` 的 JSON，要求非空 `text`。
2. runtime 从 SQLite 读取活跃 Bucket，按活动时间排序，并把可选 `focus_bucket_id` 放在候选首位。
3. `MemoryModel::classify` 收到文本和候选投影。
4. runtime 先校验模型返回的 Bucket ID，再执行候选数量、置信度和低信息引用门控。
5. `ask_user` 直接写 archive attempt；其他动作调用 `MemoryModel::extract`。
6. service 在单一 SQLite 事务中创建/选择 Bucket、写 Entry、写 memory items、更新摘要和保存审计。
7. runtime 读取最终 Bucket，server 返回结构化 JSON，UI 用同一结果显示状态。

### 2.2 确认写入

`/api/archive/append` 和 `/api/archive/create` 在路由层要求 `confirmation_granted: true`，然后调用独立 runtime 方法。确认路径不重新接受模型分类结果：目标 Bucket、标题和类型直接来自用户已确认的请求。

### 2.3 查询与纠错

读取接口通过 `CanonicalService` 生成 Bucket 列表、搜索投影和详情。纠错接口把 Entry 移动、派生 memory 关系、Bucket 摘要刷新和 correction audit 放在同一个 store transaction 中。

## 3. SQLite 数据边界

核心持久化对象：

- `buckets`：标题、类型、状态、摘要、标签和活动时间。
- `entries`：用户原文、摘要、分类元数据和所属 Bucket。
- `memory_items`：todo、evidence、timeline、decision、hypothesis、entity、tag。
- `archive_attempts`：每次分类请求的动作、置信度、候选、问题、模型和最终状态。
- `corrections`：Entry 移动的前后关系和用户命令文本。

原始 Entry 是事实来源；memory item 和 Bucket summary 是可追溯派生数据。所有写入由 Rust service 生成 ID 并使用显式事务，runtime 不直接拼 SQL。

## 4. 模型边界

`MemoryModel` 是 runtime 的最小模型接口：

```rust
trait MemoryModel {
    type Error: Display;

    fn classify(
        &mut self,
        text: &str,
        candidates: &[BucketView],
    ) -> Result<ClassificationResult, Self::Error>;

    fn extract(&mut self, text: &str) -> Result<ExtractionResult, Self::Error>;
}
```

生产实现使用严格结构化输出：

- 分类请求只携带用户文本和服务端候选 Bucket。
- 提取请求只携带用户文本。
- 模型响应必须通过 contract schema 和领域不变量校验。
- 网络、临时 HTTP 状态、缺失输出、非法 JSON 等失败在 adapter 的有限重试策略内处理。
- 模型永远不能绕过 runtime 的候选 ID 校验和置信度门控。

## 5. 事务与错误处理

- 自动归档的正式写入要么完整提交，要么不留下 Entry 和 memory item。
- `ask_user` 是有意的持久化状态：它只留下 archive attempt，等待下一次显式确认。
- 目标 Bucket 不存在、字段为空、分类契约不一致和未知状态会返回 4xx 级 JSON 错误。
- SQLite、模型 transport 和内部持久化错误不会伪装成成功响应。
- 服务端默认使用单进程顺序处理连接；MVP 不承诺多进程并发写入协调。

## 6. HTTP 表面

| 路径 | 责任 |
|---|---|
| `POST /api/archive` | 分类、门控、提取、归档或创建确认待办 |
| `POST /api/archive/append` | 用户确认后追加 |
| `POST /api/archive/create` | 用户确认后新建 |
| `GET /api/buckets/active` | 活跃 Bucket 列表 |
| `GET /api/buckets/search` | Bucket/Entry 搜索 |
| `GET /api/buckets/:id` | Bucket 详情 |
| `POST /api/buckets/status` | 状态变更 |
| `POST /api/corrections/move` | Entry 移动和纠错审计 |
| `GET /health` | 进程健康检查 |

## 7. 安全边界

这是本地单用户 MVP：

- 默认绑定 loopback；
- 没有内置用户认证、授权、TLS、CSRF、限流或多租户；
- `confirmation_granted` 只表示业务确认，不是认证凭证；
- 监听地址可被其他进程访问时，它们也能读取和修改该数据库；
- 不应直接绑定公网地址，生产部署必须由认证和 TLS 反向代理保护。

模型 API Key 只从进程环境读取，错误信息和调试输出不得打印密钥。数据库路径应指向专用 Rust SQLite 文件，备份时保留 SQLite 文件和应用停止时的一致性。

## 8. 可测试性

runtime 依赖 `MemoryModel` trait，因此测试可以注入固定的分类与提取结果，不调用真实模型。主要验证层级：

- core：分类契约、候选排序、置信度门控和低信息引用规则；
- store/service：事务、重开数据库、搜索、详情、移动和状态变更；
- runtime：完整 archive loop、确认分支和结果投影；
- server：路由、JSON 校验、错误映射和内嵌 UI。
