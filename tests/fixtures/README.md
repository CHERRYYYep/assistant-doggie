# 测试与评测 fixture

这些文件是可审阅的冻结记录。当前 TS 普通测试不调用 Rust/Cargo，不修改期望值来掩盖回归。

- `low-information-gate.tsv`：919 条输入与历史门控判定，由 `tests/low-information-gate.test.ts` 执行。
- `storage-parity.json`：归一化业务图，由 `tests/storage-parity.test.ts` 执行。
- `protocol-contract-cases.json`：原 `crates/doggie-protocol/tests/fixtures/contract_cases.json` 的完整保留副本，供历史合同查阅，不计作当前执行中的测试数量。
- 其他人工标注评测 fixture 继续由 `src/evaluation/` 使用。

移除前的源码快照：`bc88675`（本地 Git 历史）。需要考古时在独立临时工作树恢复该提交，再按上面两个 test 文件头的原始生成命令执行；不要在当前产品目录恢复 Cargo workspace。历史场景可用 `git show bc88675:crates/doggie-storage-sqlite/examples/scenario.rs` 查阅。

重新生成 low-information fixture 的原始命令：

```bash
cargo build -p doggie-domain --example low_info_oracle --offline
cut -f1 tests/fixtures/low-information-gate.tsv > /tmp/corpus.txt
./target/debug/examples/low_info_oracle < /tmp/corpus.txt > /tmp/out
paste -d'\t' /tmp/corpus.txt /tmp/out > tests/fixtures/low-information-gate.tsv
```

重新生成 storage fixture 的原始命令：

```bash
db=$(mktemp /tmp/doggie-rust-parity-XXXX.db)
cargo run -p doggie-storage-sqlite --example scenario --offline -- "$db"
node tests/storage-parity-snapshot.ts "$db" > tests/fixtures/storage-parity.json
```

这些命令只适用于历史工作树。产品有意改变合同后，更新 TS 测试和 fixture，并在变更说明中记录原因，保留 JSON/TSV 的可读格式。

## 主对话产品场景

[main-conversation-cases.ts](main-conversation-cases.ts)由 C0 冻结，是合成输入和预期结果，不是历史 oracle。旧入口测试只共享计网实验用语，并以旧合同断言副作用；C1–C4 用同一组场景逐步检验新合同。参见 [C0 验收记录](../../docs/MAIN_CONVERSATION_C0_ACCEPTANCE.md)。
