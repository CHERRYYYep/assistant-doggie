/** L0 shadow experiment: external IDs suggest which local evidence to read. */
import {
  CoreClient,
  ExperimentError,
  healthSchema,
  type CoreMessage,
  type Scope,
} from "./client.ts";
import { MatrixJournal, type Generation } from "./matrix-journal.ts";
import { admitL0, type Binding, type Source } from "./source-guard.ts";

type Catalog = {
  readonly revision: number;
  readonly sources: readonly Source[];
};
type Evidence = Readonly<{ sourceId: string; text: string }>;
type Fallback =
  | "generation_unavailable"
  | "index_unavailable"
  | "stale"
  | "unbound"
  | ExperimentError["code"];
type Answer<T> =
  | { readonly kind: "answered"; readonly mode: "core"; readonly value: T }
  | {
      readonly kind: "answered";
      readonly mode: "local";
      readonly reason: Fallback;
      readonly value: T;
    }
  | { readonly kind: "discarded"; readonly reason: "stale" };

export function generationScope(generation: Generation): Scope {
  return {
    team_id: `${generation.namespace}-${generation.epoch}`,
    user_id: "d3-matrix-user",
    agent_id: "d3-matrix-agent",
  };
}

export class MatrixHarness {
  readonly #journal: MatrixJournal;
  readonly #core: CoreClient;
  readonly #catalog: () => Catalog;

  constructor(
    journal: MatrixJournal,
    core: CoreClient,
    catalog: () => Catalog,
  ) {
    this.#journal = journal;
    this.#core = core;
    this.#catalog = catalog;
  }

  begin(): Generation {
    return this.#journal.begin(this.#catalog().revision);
  }

  #current(generation: Generation, catalog: Catalog): boolean {
    const state = this.#journal.state();
    return (
      state.namespace === generation.namespace &&
      state.epoch === generation.epoch &&
      state.revision === generation.revision &&
      state.phase === generation.phase &&
      catalog.revision === generation.revision
    );
  }

  async capture(
    sourceId: string,
  ): Promise<"acked" | "skipped" | "stale" | "unknown"> {
    const generation = this.#journal.state();
    const catalog = this.#catalog();
    const source = catalog.sources.find(
      (item) => item.id === sourceId && item.active,
    );
    if (
      generation.phase !== "building" ||
      !this.#current(generation, catalog) ||
      source === undefined
    )
      return "skipped";
    const session = `capture-${source.id}`;
    if (!this.#journal.claim(generation, source, session)) return "skipped";
    try {
      const receipt = await this.#core.add(
        generationScope(generation),
        session,
        source.text,
        `d3-${generation.epoch}-${source.id}`,
      );
      if (!this.#current(generation, this.#catalog())) {
        this.#journal.setPhase(generation, "disabled");
        return "stale";
      }
      const remoteId =
        receipt.total_count === 1 ? receipt.accepted_ids[0] : undefined;
      if (
        remoteId === undefined ||
        !this.#journal.acknowledge(generation, source.id, remoteId)
      )
        throw new ExperimentError("protocol");
      return "acked";
    } catch (error) {
      this.#journal.setPhase(generation, "disabled");
      if (!(error instanceof ExperimentError)) throw error;
      return "unknown";
    }
  }

  #bindings(generation: Generation): Binding[] {
    const scope = generationScope(generation);
    return this.#journal.deliveries(generation).flatMap((row) =>
      row.remoteId === null
        ? []
        : [
            {
              remoteId: row.remoteId,
              sourceId: row.sourceId,
              sourceVersion: row.version,
              session: row.session,
              epoch: generation.epoch,
              scope,
            },
          ],
    );
  }

  async verify(): Promise<boolean> {
    const generation = this.#journal.state();
    const before = this.#catalog();
    if (generation.phase !== "building" || !this.#current(generation, before))
      return false;
    const bindings = this.#bindings(generation);
    if (
      bindings.length !==
      before.sources.filter((source) => source.active).length
    )
      return false;
    const scope = generationScope(generation);
    try {
      const health = await this.#core.request("/health", healthSchema);
      if (health.status !== "ok" || !health.stores.ftsAvailable) return false;
      if (!this.#current(generation, this.#catalog())) return false;
      const observed = await this.#core.query(scope);
      const after = this.#catalog();
      if (!this.#current(generation, after)) return false;
      // Readback matches the new IDs, scope, and text. Core does not project a
      // remote version on this query; v1 is checked on the capture receipt.
      const snapshot = {
        epoch: generation.epoch,
        revision: generation.revision,
        ready: true,
      };
      const fullScope = observed.messages.every(
        (message) =>
          message.team_id === scope.team_id &&
          message.user_id === scope.user_id &&
          message.agent_id === scope.agent_id &&
          message.session_id !== undefined &&
          (message.version === undefined || message.version === "v1"),
      );
      if (
        !fullScope ||
        observed.total !== bindings.length ||
        observed.messages.length !== bindings.length ||
        admitL0(
          observed.messages,
          bindings,
          after.sources,
          scope,
          snapshot,
          snapshot,
        ).length !== bindings.length
      ) {
        this.#journal.setPhase(generation, "disabled");
        return false;
      }
      return this.#journal.setPhase(generation, "ready");
    } catch (error) {
      if (!(error instanceof ExperimentError)) throw error;
      return false;
    }
  }

  #admit(
    candidates: readonly CoreMessage[],
    generation: Generation,
    catalog: Catalog,
    bucket: string | undefined,
  ): Evidence[] {
    if (!this.#current(generation, catalog)) return [];
    const snapshot = {
      epoch: generation.epoch,
      revision: generation.revision,
      ready: generation.phase === "ready",
    };
    return admitL0(
      candidates,
      this.#bindings(generation),
      catalog.sources,
      generationScope(generation),
      snapshot,
      snapshot,
      bucket,
    );
  }

  async answer<T>(
    query: string,
    respond: (evidence: readonly Evidence[]) => Promise<T>,
    bucket?: string,
  ): Promise<Answer<T>> {
    const generation = this.#journal.state();
    let catalog = this.#catalog();
    let reason: Fallback | undefined;
    let candidates: readonly CoreMessage[] = [];
    if (generation.phase !== "ready" || !this.#current(generation, catalog))
      reason = "generation_unavailable";
    else {
      try {
        const health = await this.#core.request("/health", healthSchema);
        if (!this.#current(generation, this.#catalog())) reason = "stale";
        else if (health.status !== "ok" || !health.stores.ftsAvailable)
          reason = "index_unavailable";
        else
          candidates = (
            await this.#core.search(generationScope(generation), query)
          ).messages;
      } catch (error) {
        if (!(error instanceof ExperimentError)) throw error;
        reason = error.code;
      }
    }
    catalog = this.#catalog();
    let evidence: readonly Evidence[] = [];
    if (reason === undefined) {
      if (!this.#current(generation, catalog)) reason = "stale";
      else if (
        candidates.length > 0 &&
        this.#admit(candidates, generation, catalog, undefined).length === 0
      )
        reason = "unbound";
      else evidence = this.#admit(candidates, generation, catalog, bucket);
    }
    if (reason !== undefined) {
      // Simple deterministic fallback for this fixture only; no production query changes.
      evidence = catalog.sources
        .filter(
          (item) =>
            item.active &&
            (bucket === undefined || item.bucket === bucket) &&
            item.text.includes(query),
        )
        .map(({ id, text }) => ({ sourceId: id, text }));
    }
    // No async work between the last source read and dispatch. The callback only gets evidence.
    const value = await respond(evidence);
    if (
      catalog.revision !== this.#catalog().revision ||
      (reason === undefined && !this.#current(generation, catalog))
    )
      return { kind: "discarded", reason: "stale" };
    return reason === undefined
      ? { kind: "answered", mode: "core", value }
      : { kind: "answered", mode: "local", reason, value };
  }
}
