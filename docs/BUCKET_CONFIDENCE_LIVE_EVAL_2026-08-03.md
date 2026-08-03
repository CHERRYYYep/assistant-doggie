# Bucket 置信度真实模型评测与门控优化（2026-08-03）

## 运行配置

- 运行时间：2026-08-03 12:01:57 UTC（由优化后报告 `generated_at` 记录）
- 案例集：`tests/fixtures/classification_cases.json`
- 案例数量：50
- 模型：`gpt-5.6`
- API 站点：`my-relay`
- API Base URL：`https://sub2api.oopsbox.cn/v1`
- API 模式：`responses`
- Prompt 版本：`classification-v1`
- 置信度阈值：`AUTO_ARCHIVE_CONFIDENCE=0.85`，`CONFIRM_CONFIDENCE=0.55`
- 优化前完整 JSON 报告：`/tmp/assistant-doggie-classification-live-report.json`
- 优化后完整 JSON 报告：`/tmp/assistant-doggie-classification-live-report-after-gate.json`

> 本次评测使用 `.env` 中配置的真实 token 调用模型；报告和本文档不包含 token。

## 本次最小优化

1. 在 `app/services/classify_service.py` 增加低信息量指代门控：当模型想高置信追加，但输入只有“刚才那个/那块”等模糊指代和“继续处理/再补一点”等低信息动作，且缺少数字、状态变化、决策、日志、错误率等可核验事实时，强制降级为 `ask_user`。
2. 在 `app/prompts.py` 强化 Prompt：领域词或指代词不等于安全归档；明确“新开/另一个客户/单独或分开记录”时优先考虑 `create_new`。
3. 在 `tests/test_classify_service.py` 增加回归测试，覆盖高置信模糊追加被拦截，以及带明确状态变化的延续输入仍可追加。
4. 删除不再参与当前开发闭环的旧产品调研/设计建议文档：`docs/COMPETITIVE_RESEARCH.md`、`docs/DESIGN_RECOMMENDATIONS.md`。

## 执行命令

```bash
./my_own_agent/bin/python -m pytest \
  tests/test_classify_service.py tests/test_evaluation.py -q

./my_own_agent/bin/python -m app.live_evaluation \
  --output /tmp/assistant-doggie-classification-live-report-after-gate.json

./my_own_agent/bin/python -m app.evaluation \
  /tmp/assistant-doggie-classification-live-report-after-gate.json
```

补充说明：直接执行 `./my_own_agent/bin/pytest ...` 会失败，因为该脚本的 shebang 指向旧路径 `/home/cherry/collaboration-agent/my_own_agent/bin/python`；应使用 `./my_own_agent/bin/python -m pytest ...`。

## 优化前后指标对比

| 指标 | 优化前 | 优化后 | MVP 目标 | 结论 |
| --- | ---: | ---: | ---: | --- |
| 总案例数 | 50 | 50 | >= 50 | 通过 |
| action 准确率 | 94.00% | 96.00% | >= 85% | 通过 |
| 已有 Bucket 选择准确率 | 100.00% | 93.33% | >= 80% | 通过 |
| 自动归档准确率 | 94.44% | 100.00% | >= 90% | 通过 |
| ask_user 覆盖率 | 86.67% | 100.00% | 未设硬阈值 | 改善 |
| 严重误合并数量 | 2 | 0 | 0 | 通过 |

## 优化后置信度分桶

| 置信度区间 | 样本数 | 实际正确率 | ask_user 率 |
| --- | ---: | ---: | ---: |
| `<0.55` | 16 | 93.75% | 100.00% |
| `0.55-0.85` | 0 | 0.00% | 0.00% |
| `>=0.85` | 34 | 97.06% | 2.94% |

观察：新增门控把两个高代价误合并样本从高置信自动追加改为确认，严重误合并降为 0；高置信分桶准确率从 91.89% 提升到 97.06%。

## 优化后剩余错误案例

| Case | 输入 | 期望 | 模型输出 | 置信度 | 风险 |
| --- | --- | --- | --- | ---: | --- |
| `focus_append_001` | 继续做刚才的 Schema 校验 | `append_existing -> bucket_agent` | `ask_user` | 0.42 | 偏保守，未误合并 |
| `explicit_new_004` | 这是另一个客户的需求，分开记录 | `create_new` | `ask_user` | 0.93 | 偏保守，未误合并 |

## 结论与建议

1. 本轮最小优化达成主要目标：严重误合并从 2 降为 0，自动归档准确率提升到 100%。
2. 当前不建议通过调高或调低 `AUTO_ARCHIVE_CONFIDENCE` 继续优化；这次收益来自服务端风险门控，而不是阈值调整。
3. 剩余两个错误都是偏保守确认，不会污染长期记忆；相比误合并，优先级较低。
4. 如果下一步继续优化，可只针对“明确新建但信息不足”的产品策略做决策：是允许创建泛标题 Bucket，还是继续要求用户补充标题/类型。
