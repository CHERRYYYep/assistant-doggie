import { FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { DoggieAppController } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

export function MemoryView({ app }: Props) {
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">记忆空间</h2>
            <p className="text-xs text-[var(--muted)]">
              按主题组织的 Bucket 与有效记录。撤销仅做逻辑退出，保留原文与审计。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void app.refreshBuckets()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--panel-subtle)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>刷新记忆</span>
          </button>
        </div>

        <div className="grid min-h-[420px] flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section
            aria-label="活跃 Bucket"
            className="flex flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3"
          >
            <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold text-[var(--muted)]">
              <span>活跃 Bucket ({app.buckets.length})</span>
            </div>
            {app.buckets.length === 0 ? (
              <p className="p-3 text-xs text-[var(--muted)]">暂无活跃 Bucket。</p>
            ) : (
              <div className="space-y-1 overflow-y-auto">
                {app.buckets.map((bucket) => {
                  const selected = app.selectedBucketId === bucket.id;
                  return (
                    <button
                      key={bucket.id}
                      type="button"
                      onClick={() => void app.openBucketInMemory(bucket.id, false)}
                      className={[
                        "block w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                        selected
                          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                          : "hover:bg-[var(--panel-subtle)]",
                      ].join(" ")}
                    >
                      <div className="truncate text-[13px] font-medium">{bucket.title}</div>
                      <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                        {bucket.type} · {bucket.status}
                      </div>
                      {bucket.summary ? (
                        <p className="mt-1 line-clamp-2 text-[11px] text-[var(--text-2)]">
                          {bucket.summary}
                        </p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section
            aria-label="记忆详情"
            className="flex flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"
          >
            {app.bucketDetailLoading ? (
              <p className="text-xs text-[var(--muted)]">加载中…</p>
            ) : app.bucketDetailError ? (
              <div className="rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3 text-xs text-[var(--danger)]">
                {app.bucketDetailError}
              </div>
            ) : app.bucketDetail === null ? (
              <div className="flex flex-1 flex-col items-center justify-center py-12 text-center text-xs text-[var(--muted)]">
                <FolderOpen className="mb-2 h-7 w-7 opacity-50" />
                <p>从左侧选择一个 Bucket，查看原文记录、派生记忆与纠错操作。</p>
              </div>
            ) : (
              (() => {
                const detail = app.bucketDetail.detail;
                return (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--line)] pb-3">
                      <div>
                        <h3 className="text-base font-semibold text-[var(--text)]">
                          {detail.bucket.title}
                        </h3>
                        <div className="mt-0.5 text-xs text-[var(--muted)]">
                          类型：{detail.bucket.type} · 状态：{detail.bucket.status} · 记录数：
                          {detail.entries.length}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void app.deleteBucket(detail.bucket.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--danger-line)] bg-[var(--panel)] px-2.5 py-1 text-xs text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>删除 Bucket</span>
                      </button>
                    </div>

                    <div className="space-y-3">
                      {detail.entries.map((entry) => {
                        const revoked =
                          entry.archive_state === "revoked" || entry.archive_state === "deleted";
                        const moveTarget = moveTargets[entry.id] ?? "";
                        return (
                          <article
                            key={entry.id}
                            className={[
                              "rounded-xl border p-3.5 text-xs",
                              revoked
                                ? "border-[var(--line)] bg-[var(--panel-subtle)] opacity-75"
                                : "border-[var(--line)] bg-[var(--panel)]",
                            ].join(" ")}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--muted)]">
                              <span>{entry.created_at}</span>
                              <span
                                className={[
                                  "rounded-full px-2 py-0.5 font-medium",
                                  revoked
                                    ? "border border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
                                    : "border border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]",
                                ].join(" ")}
                              >
                                {revoked ? "已撤销" : "有效"}
                              </span>
                            </div>
                            <p className="mt-2 whitespace-pre-wrap break-words text-[13px] text-[var(--text)]">
                              {entry.raw_text}
                            </p>
                            {entry.summary ? (
                              <p className="mt-1.5 text-[var(--text-2)]">摘要：{entry.summary}</p>
                            ) : null}

                            {!revoked ? (
                              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-2.5">
                                <select
                                  aria-label="移动到其他 Bucket"
                                  value={moveTarget}
                                  onChange={(e) =>
                                    setMoveTargets((prev) => ({
                                      ...prev,
                                      [entry.id]: e.target.value,
                                    }))
                                  }
                                  className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)]"
                                >
                                  <option value="">移动到其他 Bucket…</option>
                                  {app.buckets
                                    .filter((b) => b.id !== detail.bucket.id)
                                    .map((b) => (
                                      <option key={b.id} value={b.id}>
                                        {b.title}
                                      </option>
                                    ))}
                                </select>
                                <button
                                  type="button"
                                  disabled={!moveTarget}
                                  onClick={() => {
                                    if (moveTarget) {
                                      void app.moveEntryToBucket(entry.id, moveTarget);
                                    }
                                  }}
                                  className="rounded-md border border-[var(--line-strong)] px-2.5 py-1 hover:bg-[var(--panel-subtle)] disabled:opacity-50"
                                >
                                  移动
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void app.revokeEntry(entry.id)}
                                  className="rounded-md border border-[var(--danger-line)] px-2.5 py-1 text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                                >
                                  撤销记录
                                </button>
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
