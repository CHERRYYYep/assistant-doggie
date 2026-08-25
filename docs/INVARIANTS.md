# Doggie 领域不变量规格

这份文档是 **TypeScript 重写的验收标准**。

它不是设计文档，而是从**两份已存在的可运行实现**里提取出来的行为清单：

- **Rust**（`dev_ts` 分支现存代码）：124 个测试
- **Python**（`dev` 分支 `app/` + `tests/`）：79 个测试，`128 passed in 6.18s`

重写的最大风险是"忘了当初为什么那样写"。这份清单存在的意义是：**每一条都对应至少一个已通过的测试**，所以 TS 实现不是凭印象再写一遍，而是有一份可勾选的验收表。

标记说明：

- `[R]` 只有 Rust 覆盖
- `[P]` 只有 Python 覆盖
- `[RP]` 两边都覆盖 —— **优先级最高，两次独立实现都认为必要**
- `[!]` **在 Rust 重写中丢失的能力**，见第 9 节

---

## 1. 分类与归档安全门控

这是整个产品的安全核心：**模型的 confidence 不是持久化授权**。

| # | 不变量 | 来源 |
| --- | --- | --- |
| 1.1 | `ask_user` 只写 archive attempt 和分类审计，**不创建 Entry** | `[RP]` `confirmation_attempt_does_not_create_an_entry` / `test_uncertain_classification_records_audit_but_not_formal_memory` |
| 1.2 | 候选不唯一时，**即使 confidence 很高也必须确认** | `[R]` `ambiguous_result_requires_confirmation_even_with_high_confidence` |
| 1.3 | 低信息输入（纯指代、无主体状态短句）即使高 confidence 也必须确认 | `[RP]` `high_confidence_low_information_status_inputs_require_confirmation` |
| 1.4 | 低信息**指代**阻止自动 append | `[RP]` `low_information_reference_blocks_automatic_append` / `test_low_information_reference_gate_blocks_vague_high_confidence_append` |
| 1.5 | 但含具体事实的指代**允许**继续 append | `[RP]` `concrete_fact_allows_a_referenced_append_to_continue` / `test_low_information_reference_gate_allows_concrete_status_update` |
| 1.6 | 具体事实判定含 Unicode 数字：`\p{N}`（全角 `３`、`〇`、`Ⅴ`、`½` 都算），**但汉字数词 `三`/`百` 不算**（它们是 Lo 不是 N）。等价于 Rust `char::is_numeric()`，已实测逐字符比对 | `[R]` `unicode_digits_count_as_concrete_facts` |
| 1.7 | 空工作区 + 高 confidence 可以直接建第一个 Bucket（跳过门控） | `[RP]` `empty_workspace_can_bootstrap_a_high_confidence_bucket` / `test_first_bucket_create_new_skips_confidence_confirmation_gate` |
| 1.8 | 空工作区 + 中 confidence 仍要确认 | `[R]` `empty_workspace_requires_confirmation_for_medium_confidence_new_bucket` |
| 1.9 | 空 Bucket 状态下，纯模糊指代仍然要问 | `[P]` `test_empty_bucket_still_asks_for_pure_vague_reference` |
| 1.10 | 模型返回的 Bucket ID **不在服务端候选列表里** → 必须确认 | `[RP]` `generated_bucket_id_outside_server_candidates_requires_confirmation` / `test_classify_input_accepts_only_server_candidate_ids` |
| 1.11 | 低 confidence 归档只产生确认尝试 | `[R]` `low_confidence_archive_only_creates_a_confirmation_attempt` |
| 1.12 | confidence 门控区分 high/medium/low 三档，各有不同确认文案 | `[RP]` `confidence_gate_uses_medium_and_low_confirmation_messages` / `test_confidence_gate_allows_high_unique_and_blocks_medium` |
| 1.13 | ConfidencePolicy 拒绝非递增阈值和非有限数 | `[R]` `confidence_policy_rejects_invalid_order_and_non_finite_values` |

## 2. 候选 Bucket 构造

| # | 不变量 | 来源 |
| --- | --- | --- |
| 2.1 | 候选由服务端自动生成：**最近活跃 + 热门活跃交错**，不使用 UI 选中项 | `[R]` `active_bucket_views_interleave_recent_and_popular_and_ignore_focus` |
| 2.2 | 「热门」按 Entry 数和 memory 数排序 | `[R]` `popular_active_buckets_rank_by_entry_and_memory_volume` |
| 2.3 | 候选保持服务端顺序并去重 | `[RP]` `candidates_preserve_service_order_ignore_focus_and_deduplicate` |
| 2.4 | `ask_user` 无候选时，回落到活跃 Bucket 列表 | `[RP]` `ask_user_without_candidates_gets_server_candidate_list` |
| 2.5 | 确认候选优先级：显式目标 → 模型候选 → 服务端候选 | `[RP]` `confirmation_candidates_prioritize_explicit_target_then_model_and_server_candidates` |
| 2.6 | 非法的模型建议候选被过滤掉 | `[R]` `invalid_suggested_candidates_are_filtered` |
| 2.7 | 候选数量上限必须为正 | `[R]` `candidate_limit_must_be_positive` |

> **历史变更**：Python 版本把 UI 选中的 Bucket 放在候选首位（`test_candidates_put_current_focus_first_and_deduplicate`），Rust 版本**取消了这个行为**（`ignore_focus`）。TS 实现**跟随 Rust**：`focus_bucket_id` 只保留为兼容/审计字段。

## 3. 确认写入

| # | 不变量 | 来源 |
| --- | --- | --- |
| 3.1 | 确认必须绑定 pending attempt **且原文完全一致** | `[R]` `chat_confirmation_requires_pending_attempt_and_exact_original_text` |
| 3.2 | 目标 Bucket 非 active → 拒绝，**且不消解 attempt** | `[R]` `chat_confirmation_rejects_non_active_target_bucket_without_resolving_attempt` |
| 3.3 | 目标 Bucket 已删除 → 拒绝，**且不消解 attempt** | `[R]` `chat_confirmation_rejects_deleted_target_bucket_without_resolving_attempt` |
| 3.4 | 确认路径**不重新跑分类**——目标/标题/类型直接来自用户确认 | `[RP]` `confirmed_append_and_create_are_explicit_doggie_writes` / `test_confirmed_new_bucket_is_persisted_without_reclassification` |
| 3.5 | 四种确认动作必须都可用：append / append-alternative / create / discard | `[R]` `chat_confirmation_append_create_and_discard_are_explicit` |
| 3.6 | `append_existing` 必须带 bucket_id；`create_new` 必须带 type + title | `[P]` `test_append_existing_requires_bucket_id` / `test_create_new_requires_type_and_title` |
| 3.7 | `ask_user` 必须带 question 和标志位 | `[P]` `test_ask_user_requires_question_and_flag` |
| 3.8 | 不确定的新 Bucket 建议要保留下来供确认使用 | `[P]` `test_uncertain_new_bucket_suggestion_is_preserved_for_confirmation` |

## 4. 存储与事务

| # | 不变量 | 来源 |
| --- | --- | --- |
| 4.1 | 归档写入是**单一事务**：Bucket + Entry + memory items + 摘要 + 审计 | `[RP]` `archive_runs_the_complete_doggie_loop` / `test_archive_flow_creates_bucket_entry_and_structured_records` |
| 4.2 | 任何一步失败 → **整个事务回滚，不留部分写入** | `[RP]` `[R]` store rollback tests / `test_database_failure_rolls_back_entire_owned_archive_transaction` |
| 4.3 | 外键强制开启（`PRAGMA foreign_keys = ON`） | `[R]` schema validation tests |
| 4.4 | 重开数据库后归档状态可恢复 | `[R]` `archive_state_survives_reopening_the_doggie_database` |
| 4.5 | 删除 Bucket 级联删除 Entry + 自有 memory，并写 correction | `[R]` `delete_bucket_cascades_dependents_and_records_correction` |
| 4.6 | 移动 Entry 时**所有子记录一起移动**，并写审计快照 | `[RP]` `test_move_entry_moves_all_children_and_writes_audit` |
| 4.7 | 把自动创建 Bucket 的**唯一** Entry 移走 → 删除空的源 Bucket | `[R]` `moving_only_entry_out_of_auto_created_bucket_removes_empty_source_bucket` |
| 4.8 | 同 Bucket 移动被类型化拒绝 | `[R]` correction request tests |
| 4.9 | 滚动摘要保留**最早片段 + 最新片段**，有字符上限 | `[R]` `rolling_summary_preserves_first_and_newest_fragments_with_a_bound` |
| 4.10 | 摘要截断按 **Unicode 字符**计数，不是字节 | `[R]` `summary_truncation_counts_unicode_characters` |
| 4.11 | 摘要去重使用 Unicode casefold + 空白规范化 | `[RP]` `normalization_matches_legacy_casefold_and_whitespace_rules` / `test_update_bucket_summary_is_bounded_and_nonduplicating` |
| 4.12 | 提取保存会去重已存在记录 | `[P]` `test_save_extraction_persists_children_and_deduplicates` |
| 4.13 | ID 使用 UUID v4 | `[R]` `generated_ids_use_uuid_crate_v4` |
| 4.14 | 追加 Entry 刷新 Bucket 活动时间；缺失 Bucket 类型化拒绝 | `[P]` `test_append_entry_updates_bucket_activity_and_detail` / `test_append_entry_rejects_missing_bucket` |
| 4.15 | 活跃列表排除非 active Bucket | `[P]` `test_list_active_buckets_excludes_non_active_buckets` |

## 5. 自然语言查询

| # | 不变量 | 来源 |
| --- | --- | --- |
| 5.1 | 查询路径**只读**，不写 Entry、不刷新活动时间、不产生聊天记录 | `[R]` `query_projection_exposes_plan_entries_buckets_and_evidence_without_writes` |
| 5.2 | 解析出：entity_terms / topic_terms / bucket_terms / time_range / statuses / structured_filters | `[R]` `parses_natural_language_entity_topic_and_relative_time` |
| 5.3 | 结果单元是 **Entry 不是 Bucket**，可跨多个 Bucket | `[R]` `returns_multiple_entries_and_buckets_with_deduplicated_evidence` |
| 5.4 | 时间筛选**只用 `Entry.created_at`**，不用 memory 的 `occurred_at` | `[R]` `searches_entry_summary_entity_tag_and_applies_structured_and_time_filters` |
| 5.5 | `time_range` 是半开区间 `[start, end)`，相对时间按当前 UTC 解析 | `[R]` query plan tests |
| 5.6 | 检索覆盖：Bucket 标题/摘要/标签、Entry 原文/summary、memory entity/tag、结构化字段 | `[RP]` `[R]` search tests / `test_search_covers_title_summary_tags_and_entry_raw_text` |
| 5.7 | evidence 按 kind + casefold 后的 trimmed text 去重 | `[R]` `returns_multiple_entries_and_buckets_with_deduplicated_evidence` |
| 5.8 | 显式请求时状态筛选包含 archived | `[R]` `status_filter_includes_archived_lifecycle_when_requested` |
| 5.9 | `answer` 是**确定性生成**的，不经过 LLM | `[R]` query projection tests |
| 5.10 | `semantic_score` 是 **lexical similarity**（字符串包含/命中比例），**不是 embedding**——命名不得误导 | `[R]` docs + query tests |
| 5.11 | LIKE 查询必须转义 `%` `_` `/` 字面量 | `[P]` `test_search_covers_...`（Rust 侧需确认覆盖） |

## 6. 模型边界与结构化输出

| # | 不变量 | 来源 |
| --- | --- | --- |
| 6.1 | 严格 JSON Schema，**拒绝未知字段** | `[RP]` `classification_contract_rejects_inconsistent_actions` / `test_json_schema_forbids_unknown_object_fields` |
| 6.2 | 拒绝非法 confidence 和多余字段 | `[P]` `test_classification_rejects_invalid_confidence_and_extra_fields` |
| 6.3 | refusal / incomplete / content_filter / 非终止状态**不得被静默接受** | `[RP]` `refusal_incomplete_content_filter_and_nonterminal_statuses_are_not_silently_accepted` / `test_parse_with_schema_reports_refusal` |
| 6.4 | 重试有上限；区分**可重试的瞬时 HTTP** 和**不可重试的拒绝/过滤** | `[RP]` `retry_policy_distinguishes_transient_http_from_refusal_and_filtering` / `test_parse_with_schema_does_not_retry_non_transient_client_error` |
| 6.5 | 非法 JSON 是**脱敏后的**可重试传输失败 | `[R]` `invalid_json_response_is_a_sanitized_retryable_transport_failure` |
| 6.6 | timeout 映射时**不暴露请求内容** | `[R]` `timeout_is_mapped_without_exposing_request_details` |
| 6.7 | API Key 绝不出现在错误、日志或数据库中 | `[RP]` transport tests |
| 6.8 | 自定义 endpoint 必须是安全 URL；本地 http gateway 是允许的例外 | `[RP]` `endpoint_parser_keeps_security_policy_around_community_url_parsing` / `test_configured_endpoint_rejects_missing_or_insecure_custom_url` |
| 6.9 | 多条消息返回时，解析器优先取 final-answer 阶段 | `[R]` `responses_parser_prefers_final_answer_phase_when_multiple_messages_are_returned` |
| 6.10 | 结构化输出拒绝 tool_calls 和 legacy function_call，不静默丢失 | `[R]` `structured_output_rejects_tool_calls_and_legacy_function_call_without_silent_loss` |
| 6.11 | 提取结果的默认值相互独立（不共享可变默认） | `[P]` `test_extraction_defaults_are_independent` |
| 6.12 | 提取必须有 summary，timeline 文本合法 | `[P]` `test_extraction_requires_summary_and_valid_timeline_text` |

## 7. Agent Harness 边界

| # | 不变量 | 来源 |
| --- | --- | --- |
| 7.1 | 工具 allow-list：未注册工具名返回错误，**不动态执行** | `[RP]` `tool_allowlist_rejects_unknown_tool_names` / `test_unknown_harness_tool_cannot_execute_arbitrary_code` |
| 7.2 | 非法工具参数变成**数据错误**返回给模型，不执行 | `[RP]` `invalid_tool_arguments_become_data_errors_without_arbitrary_execution` |
| 7.3 | 未知参数字段在到达 executor **之前**就被拒绝 | `[R]` `search_memory_unknown_fields_are_rejected_before_the_agent_executor` |
| 7.4 | tool round 有硬上限，能终止重复调用循环 | `[RP]` `max_tool_rounds_stop_a_repeating_model_loop` |
| 7.5 | 显式 allow-list 能过滤掉写工具，**且不调用 executor** | `[R]` `explicit_tool_allowlist_rejects_hidden_write_calls_without_invoking_executor` |
| 7.6 | 工具输出是**数据**，不拥有系统指令权限 | `[RP]` harness tests |
| 7.7 | 参数 32 KiB / 结果 64 KiB / 上下文 64 KiB / 历史 100 条上限 | `[R]` harness constants |
| 7.8 | 同一轮 `archive` 返回 needs_confirmation 后，**不得再执行写工具** | `[P]` `test_harness_blocks_same_turn_write_after_archive_needs_confirmation` — Rust 用「写工具不在回答阶段 allow-list」从结构上解决 |
| 7.9 | Responses 和 Chat Completions 两条路径行为一致 | `[RP]` parity tests |

**T10 当前覆盖（不是 §7 全部完成）**：`src/mcp/server.test.ts` 已验证官方 MCP server 的显式工具列表、未知直接写工具拒绝和未知字段在执行前拒绝；`src/mcp/tools.test.ts` 已验证三个读取工具无写副作用、`propose_entry` 只能产生 `needs_confirmation` attempt、参数上限和 64 KiB 输出上限。7.4 的多轮循环、7.7 的上下文/历史预算以及 7.9 的双模型 API Harness parity 仍由 T13 完成。

## 8. HTTP 边界（S1 已在 Rust 侧实现，需在 TS 重建）

| # | 不变量 | 来源 |
| --- | --- | --- |
| 8.1 | HTTP/1.1 必须带 `Host`，否则 400 | `[R]` S1 |
| 8.2 | `Host` 必须是 loopback 或实际绑定地址（防 DNS rebinding，读写都覆盖） | `[R]` `foreign_host_header_is_rejected` |
| 8.3 | 状态变更请求携带 `Origin` 时必须是允许来源 | `[R]` `cross_origin_state_change_is_rejected` |
| 8.4 | `Origin: null` 一律拒绝 | `[R]` `opaque_origin_is_rejected` |
| 8.5 | 带 body 的请求必须 `Content-Type: application/json`（迫使跨源预检失败） | `[R]` `simple_content_type_body_is_rejected` |
| 8.6 | 无 body 的 DELETE 豁免 Content-Type | `[R]` `same_origin_loopback_and_bodyless_requests_are_allowed` |
| 8.7 | 响应带 `nosniff` + `Referrer-Policy` + CSP（无 `unsafe-inline`） | `[R]` S1 |
| 8.8 | UTF-8 query 参数正确解码 | `[R]` `encoded_utf8_natural_language_query_is_decoded_before_search` |
| 8.9 | 错误响应是稳定的 JSON 形状 `{ok:false, error}` | `[R]` `read_routes_and_store_failures_have_stable_json_errors` |
| 8.10 | 分类或聊天模型失败时，**已接收的 user 消息仍要保留** | `[R]` chat failure tests |

## 9. 评测能力（T9 已恢复）

**历史缺口**：交叉核对 Python 79 个测试后发现，Rust 重写曾丢失整套评测 harness；T9 已在 TypeScript 中恢复确定性评测和可复现 live 报告。

原 Python 版本有一整套**评测 harness**，Rust 版本**完全没有移植**；当前 TS 版本已恢复对应能力：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `app/evaluation.py` | 361 | 分类准确率评测，含 safety / confidence 分档指标 |
| `app/extraction_evaluation.py` | 270 | 提取忠实度评测：**遗漏项、禁用词、凭空多出的数字** |
| `app/live_evaluation.py` | 143 | 真实模型分类评测，保留可复现元数据 |
| `app/live_extraction_evaluation.py` | 128 | 真实模型提取评测 |

相关测试：`test_evaluation_metrics_cover_safety_and_confidence_bands`、`test_extraction_evaluation_flags_omissions_forbidden_terms_and_new_numbers`、`test_numeric_risk_check_treats_source_percentage_and_plain_number_as_equivalent`、`test_faithful_extraction_has_full_term_recall_and_no_risk_flags`、`test_human_labelled_fixture_has_required_coverage`。

**为什么这是个问题**：`docs/PRD.md` 第 8 节的成功指标写着「**自动分类准确率是否能达到 70% 以上**」。Rust 版本没有任何东西能回答这个问题。更严重的是提取忠实度检查——它专门抓「模型编造了原文里没有的数字」，而这直接违反 PRD 的「原文保留」原则。

**T9 已完成恢复。** 人工标注 fixture 从 `dev` 分支的 `tests/fixtures/` 复用；TS 实现在 `src/evaluation/`，普通测试不调用真实模型，live harness 通过注入 classifier/extractor 后单独运行。

---

## 10. 明确不做（沿用 `docs/PRD.md` 第 7 节）

多用户登录与权限、移动端 App、团队协作、大规模文件知识库、自动执行外部操作、复杂图谱可视化、生产级加密与审计。

---

## 附录：验收方式

每完成一层，对应章节的每一条都要有一个可执行测试。**不允许用「代码看起来做了这件事」代替测试。**

参考实现随时可查：

```bash
# Rust 行为
git show dev_rust:crates/doggie-domain/tests/classification.rs

# Python 行为（可直接运行）
git stash && git checkout dev && .venv/bin/python -m pytest tests -q
```
