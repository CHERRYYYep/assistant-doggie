# Bucket 置信度真实模型评测（2026-08-03）

## 运行配置

- 运行时间：2026-08-03 11:47:31 UTC（由报告 `generated_at` 记录）
- 案例集：`tests/fixtures/classification_cases.json`
- 案例数量：50
- 模型：`gpt-5.6`
- API 站点：`my-relay`
- API Base URL：`https://sub2api.oopsbox.cn/v1`
- API 模式：`responses`
- Prompt 版本：`classification-v1`
- 置信度阈值：`AUTO_ARCHIVE_CONFIDENCE=0.85`，`CONFIRM_CONFIDENCE=0.55`
- 完整 JSON 报告：`/tmp/assistant-doggie-classification-live-report.json`

> 本次评测使用 `.env` 中配置的真实 token 调用模型；报告和本文档不包含 token。

## 执行命令

```bash
./my_own_agent/bin/python -m app.live_evaluation \
  --output /tmp/assistant-doggie-classification-live-report.json

./my_own_agent/bin/python -m app.evaluation \
  /tmp/assistant-doggie-classification-live-report.json

./my_own_agent/bin/python -m pytest \
  tests/test_evaluation.py tests/test_live_evaluation.py tests/test_classify_service.py -q
```

补充说明：直接执行 `./my_own_agent/bin/pytest ...` 失败，因为该脚本的 shebang 指向旧路径 `/home/cherry/collaboration-agent/my_own_agent/bin/python`；改用 `./my_own_agent/bin/python -m pytest ...` 后通过。

## 总体指标

| 指标 | 结果 | MVP 目标 | 结论 |
| --- | ---: | ---: | --- |
| 总案例数 | 50 | >= 50 | 通过 |
| action 准确率 | 94.00% | >= 85% | 通过 |
| 已有 Bucket 选择准确率 | 100.00% | >= 80% | 通过 |
| 自动归档准确率 | 94.44% | >= 90% | 通过 |
| ask_user 覆盖率 | 86.67% | 未设硬阈值 | 需观察 |
| 严重误合并数量 | 2 | 0 | 未通过 |

## 置信度分桶

| 置信度区间 | 样本数 | 实际正确率 | ask_user 率 |
| --- | ---: | ---: | ---: |
| `<0.55` | 12 | 100.00% | 100.00% |
| `0.55-0.85` | 1 | 100.00% | 100.00% |
| `>=0.85` | 37 | 91.89% | 2.70% |

观察：高置信度分桶整体达到 90% 目标，但 2 个高代价歧义案例被高置信度自动追加，说明仅调整阈值不能消除风险；需要改进歧义识别或服务端门控规则。

## 错误案例

| Case | 输入 | 期望 | 模型输出 | 置信度 | 风险 |
| --- | --- | --- | --- | ---: | --- |
| `ask_similar_001` | 刚才那个支付相关的继续处理 | `ask_user` | `append_existing` -> `bucket_payment` | 0.97 | 高代价误合并 |
| `ask_payment_001` | 支付那块再补一点 | `ask_user` | `append_existing` -> `bucket_payment` | 0.93 | 高代价误合并 |
| `explicit_new_004` | 这是另一个客户的需求，分开记录 | `create_new` | `ask_user` | 0.97 | 偏保守，未自动新建 |

## 与关键词基线对比

| 指标 | 关键词基线 | 真实模型 |
| --- | ---: | ---: |
| action 准确率 | 84.00% | 94.00% |
| 已有 Bucket 选择准确率 | 73.33% | 100.00% |
| 自动归档准确率 | 96.55% | 94.44% |
| ask_user 覆盖率 | 93.33% | 86.67% |
| 严重误合并数量 | 1 | 2 |

真实模型在主准确率和已有 Bucket 选择上明显更好，但严重误合并数量比关键词基线多 1 个，风险门控仍需增强。

## 结论与建议

1. 当前模型 + Prompt 的基础分类能力可用：50 条标注集上 action 准确率 94%，已有 Bucket 命中率 100%。
2. 当前自动归档阈值 `0.85` 暂不建议单独下调或上调：错误样本本身给出了 0.93/0.97 高置信度，单纯提高阈值会牺牲大量正常自动归档，但仍可能漏掉高置信误判。
3. 下一步应优先处理“指代 + 高代价 + 语义范围宽”的门控：例如“刚才那个”“那块”“继续处理”“再补一点”这类输入，即使模型返回高置信度，也应结合候选相似度和错误代价降级为 `ask_user`。
4. 对“另一个客户”“分开记录”等明确拆分表达，可在 Prompt 或规则中强化为 `create_new`，减少不必要确认。
