/** Experimental L0-only projection. L1/L2/L3 have no admission path here. */
import type { CoreMessage, Scope } from "./client.ts";

export type Source = {
  readonly id: string;
  readonly bucket: string;
  readonly text: string;
  readonly active: boolean;
  readonly version: number;
};
export type Binding = {
  readonly remoteId: string;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly session: string;
  readonly epoch: number;
  readonly scope: Scope;
};
export type Snapshot = {
  readonly epoch: number;
  readonly revision: number;
  readonly ready: boolean;
};

/** Re-evaluate at recall and again before use; caller supplies canonical state. */
export function admitL0(
  candidates: readonly CoreMessage[],
  bindings: readonly Binding[],
  sources: readonly Source[],
  scope: Scope,
  captured: Snapshot,
  current: Snapshot,
  bucket?: string,
): { readonly sourceId: string; readonly text: string }[] {
  if (
    !current.ready ||
    !captured.ready ||
    current.epoch !== captured.epoch ||
    current.revision !== captured.revision
  )
    return [];
  const result = new Map<string, { sourceId: string; text: string }>();
  for (const candidate of candidates) {
    // Never infer provenance from similarity, labels or a model-provided Entry ID.
    const matches = bindings.filter(
      (binding) =>
        binding.remoteId === candidate.id && binding.epoch === current.epoch,
    );
    if (matches.length !== 1) continue;
    const binding = matches[0];
    if (binding === undefined) continue;
    if (
      binding.scope.team_id !== scope.team_id ||
      binding.scope.agent_id !== scope.agent_id ||
      binding.scope.user_id !== scope.user_id
    )
      continue;
    const source = sources.find(({ id }) => id === binding.sourceId);
    if (
      source === undefined ||
      !source.active ||
      source.version !== binding.sourceVersion ||
      (bucket !== undefined && bucket !== source.bucket)
    )
      continue;
    if (
      candidate.role !== "user" ||
      (candidate.team_id !== undefined &&
        candidate.team_id !== scope.team_id) ||
      (candidate.agent_id !== undefined &&
        candidate.agent_id !== scope.agent_id) ||
      (candidate.user_id !== undefined &&
        candidate.user_id !== scope.user_id) ||
      (candidate.session_id !== undefined &&
        candidate.session_id !== binding.session) ||
      candidate.content !== source.text
    )
      continue;
    result.set(source.id, { sourceId: source.id, text: source.text });
  }
  // Returned text is source data; it is never a tool instruction or authorization.
  return [...result.values()];
}

export function scoreSources(
  expected: readonly string[],
  actual: readonly string[],
) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual.slice(0, 5));
  const hits = [...expectedSet].filter((id) => actualSet.has(id)).length;
  return {
    recallAt5: expectedSet.size === 0 ? null : hits / expectedSet.size,
    precisionAt5:
      expectedSet.size === 0 || actualSet.size === 0
        ? null
        : hits / actualSet.size,
    unexpected: [...actualSet].filter((id) => !expectedSet.has(id)),
    negativePassed: expectedSet.size === 0 ? actualSet.size === 0 : null,
  };
}
