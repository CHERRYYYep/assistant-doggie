# Rust Work Memory 架构

## 1. 组件边界

```text
浏览器 / curl
      │ HTTP + JSON
      ▼
work-memory-server
      │ 路由、校验、确认卡片、内嵌 UI
      ▼
CanonicalRuntime<M>
      ├── MemoryModel / Structured Output Adapter
      ├── 低信息与置信度门控
      ├── CanonicalService
      │     ├── 归档、确认、纠错和状态变更
      │     └── 自然语言查询、筛选、重排、聚合
      ▼
RustStore / canonical SQLite
```

crate 职责：

- `work-memory-core`：Bucket、Entry、分类/提取结果、状态和确定性安全规则。
- `work-memory-contracts`：模型结构化输出的严格 JSON Schema 和边界校验。
- `work-memory-agent`：端点配置、Responses/Chat Completions 适配、网络错误和受控工具 Harness。
- `work-memory-store`：Rust canonical schema、事务、查询、审计和历史数据库导入。
- `work-memory-service`：稳定的领域服务 facade。
- `work-memory-runtime`：把模型、服务和安全策略组合成归档/查询运行时。
- `work-memory-server`：HTTP listener、JSON projection 和单页 Web UI。

## 2. 自动归档流程

1. Server 校验非空用户文本并保存当前 user 消息。
2. Runtime 读取活跃 Bucket，并把当前焦点 Bucket 放到候选前部。
3. `MemoryModel` 只输出结构化分类结果；服务端重新校验 action、Bucket ID、候选和置信度。
4. 低信息规则优先于模型 confidence。只有候选唯一、信息充分且达到门槛时才自动写入。
5. 自动写入前执行结构化提取，在一个事务中写入 Bucket、Entry、memory item、摘要和审计。
6. `ask_user` 只保存确认尝试和分类审计，不创建正式 Entry。
7. Server 将推荐 Bucket、备选 Bucket、理由、确认选项和修改入口投影给客户端。

确认请求必须绑定待确认 attempt、原始文本和有效 action。服务端不会接受客户端伪造的 attempt 或绕过 pending 状态的写请求。

## 3. 自然语言查询流程

`MemoryQuery::parse` 将“查询接口 A 最近两周的压测结果”解析为：

- `entity_terms`：接口 A；
- `topic_terms`：压测、结果；
- `time_range`：相对当前日期计算的时间窗口；
- `bucket_terms`：可能出现的 Bucket 名称；
- `statuses` 和 `structured_filters`：从显式状态/字段条件中提取。

查询在 Entry 粒度执行，综合 Bucket 标题、Entry 原文、summary、tag、entity 和结构化 memory。结果按关键词命中、语义/字段匹配、时间和稳定 ID 重排，先做 Entry/evidence 去重，再生成跨 Bucket 的回答投影。查询路径只读，不产生归档写入。

## 4. 安全边界

这是本地单用户 MVP：

- 默认只绑定 loopback；
- 没有内置认证、授权、TLS、CSRF、限流或多租户；
- `confirmation_granted` 是业务确认，不是身份凭证；
- 监听到非 loopback 地址时，访问者可以读写数据库；
- Agent 只允许注册工具，限制工具轮数、参数大小、结果大小和历史上下文大小；
- 模型 API Key 只从进程环境读取，错误和日志不得打印密钥。

## 5. 可测试性

Runtime 依赖 `MemoryModel` trait，测试可以注入固定分类/提取结果。HTTP 测试使用 fake responder，数据库测试使用临时 canonical SQLite 文件；不调用真实模型，也不读写用户本地数据库。
