import { FileText, Search } from "lucide-react";
import type { DoggieAppController } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

export function SearchView({ app }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">检索记忆</h2>
          <p className="text-xs text-[var(--muted)]">
            输入主题、实体或时间范围，从多个 Bucket 中汇总有效证据。点击来源可在右侧抽屉原位查看。
          </p>
        </div>

        <div className="flex gap-2 rounded-xl border border-[var(--line-strong)] bg-[var(--panel)] p-2">
          <input
            type="text"
            maxLength={500}
            value={app.searchQuery}
            onChange={(e) => app.setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void app.runSearch();
              }
            }}
            placeholder="例如：接口 A 最近两周的压测结果"
            className="min-w-0 flex-1 bg-transparent px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
          />
          <button
            type="button"
            disabled={app.searchLoading}
            onClick={() => void app.runSearch()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-medium text-[var(--panel)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <Search className="h-3.5 w-3.5" />
            <span>{app.searchLoading ? "查询中…" : "查询记忆"}</span>
          </button>
        </div>

        {app.searchError ? (
          <div className="rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3 text-xs text-[var(--danger)]">
            {app.searchError}
          </div>
        ) : null}

        {app.searchResult ? (
          <div className="space-y-4">
            <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
              <div className="text-xs font-semibold text-[var(--muted)]">汇总结果</div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-[var(--text)]">
                {app.searchResult.answer}
              </p>
            </section>

            <section className="space-y-3">
              <div className="text-xs font-semibold text-[var(--muted)]">
                命中记录 ({app.searchResult.total_entries} 条 · {app.searchResult.total_buckets} 个
                Bucket)
              </div>
              {app.searchResult.results.length === 0 ? (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 text-xs text-[var(--muted)]">
                  未命中有效记录。
                </div>
              ) : (
                app.searchResult.results.map((hit) => (
                  <article
                    key={hit.entry.id}
                    className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--text)]">
                          {hit.bucket.title}
                        </h3>
                        <span className="rounded-full border border-[var(--line)] bg-[var(--panel-subtle)] px-2 py-0.5 text-[10px] text-[var(--muted)]">
                          {hit.bucket.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => void app.inspectEntrySource(hit.bucket.id, hit.entry.id)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline"
                        >
                          <FileText className="h-3 w-3" />
                          <span>检视原文</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void app.openBucketInMemory(hit.bucket.id, true)}
                          className="text-[11px] text-[var(--muted)] hover:text-[var(--text)] hover:underline"
                        >
                          打开 Bucket
                        </button>
                      </div>
                    </div>
                    <div className="mt-1.5 text-[11px] text-[var(--muted)]">
                      {hit.entry.created_at}
                      {hit.matched_fields.length > 0
                        ? ` · 命中字段：${hit.matched_fields.join("、")}`
                        : ""}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-[13px] text-[var(--text)]">
                      {hit.entry.raw_text}
                    </p>
                  </article>
                ))
              )}
            </section>
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] py-12 text-center text-xs text-[var(--muted)]">
            <Search className="mx-auto mb-2 h-7 w-7 opacity-50" />
            <p>查询结果会展示解析条件、汇总答案和可追溯的本地记录。</p>
          </div>
        )}
      </div>
    </div>
  );
}
