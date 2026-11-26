/** Temporary, single-owner L0 experiment journal. No production schema or source text. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Source } from "./source-guard.ts";

const stateSchema = z.strictObject({
  namespace: z.string(),
  epoch: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  phase: z.enum(["disabled", "building", "ready"]),
});
const deliverySchema = z.strictObject({
  sourceId: z.string(),
  version: z.number().int(),
  session: z.string(),
  remoteId: z.string().nullable(), // null means the send was claimed but not acknowledged.
});
export type Generation = Readonly<z.infer<typeof stateSchema>>;

export class MatrixJournal {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS generation (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          namespace TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('disabled', 'building', 'ready'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS delivery (
          source_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          session TEXT NOT NULL,
          remote_id TEXT UNIQUE
        ) STRICT;
        UPDATE generation SET phase = 'disabled' WHERE phase = 'building';
      `);
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO generation VALUES (1, ?, 0, 0, 'disabled')",
        )
        .run(`d3-matrix-${randomUUID()}`);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  state(): Generation {
    return stateSchema.parse(
      this.#db
        .prepare("SELECT namespace, epoch, revision, phase FROM generation")
        .get(),
    );
  }

  begin(revision: number): Generation {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.#db
          .prepare(
            `UPDATE generation SET epoch = epoch + 1, revision = ?, phase = 'building'
                    WHERE revision <= ? AND (phase != 'building' OR revision < ?)`,
          )
          .run(revision, revision, revision).changes !== 1
      )
        throw new Error("D3 cannot begin generation");
      this.#db.exec("DELETE FROM delivery");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.state();
  }

  claim(generation: Generation, source: Source, session: string): boolean {
    return (
      this.#db
        .prepare(
          `INSERT INTO delivery (source_id, version, session)
                  SELECT ?, ?, ? FROM generation
                  WHERE namespace = ? AND epoch = ? AND revision = ? AND phase = 'building'
                  ON CONFLICT(source_id) DO NOTHING`,
        )
        .run(
          source.id,
          source.version,
          session,
          generation.namespace,
          generation.epoch,
          generation.revision,
        ).changes === 1
    );
  }

  acknowledge(
    generation: Generation,
    sourceId: string,
    remoteId: string,
  ): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE delivery SET remote_id = ? WHERE source_id = ? AND remote_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM delivery WHERE remote_id = ?)
                  AND EXISTS (SELECT 1 FROM generation WHERE namespace = ? AND epoch = ? AND revision = ? AND phase = 'building')`,
        )
        .run(
          remoteId,
          sourceId,
          remoteId,
          generation.namespace,
          generation.epoch,
          generation.revision,
        ).changes === 1
    );
  }

  deliveries(generation: Generation) {
    return z.array(deliverySchema).parse(
      this.#db
        .prepare(
          `SELECT source_id AS sourceId, version, session, remote_id AS remoteId FROM delivery
                        WHERE EXISTS (SELECT 1 FROM generation WHERE namespace = ? AND epoch = ? AND revision = ?)
                        ORDER BY source_id`,
        )
        .all(generation.namespace, generation.epoch, generation.revision),
    );
  }

  setPhase(generation: Generation, phase: "disabled" | "ready"): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE generation SET phase = ? WHERE namespace = ? AND epoch = ? AND revision = ? AND phase = ?`,
        )
        .run(
          phase,
          generation.namespace,
          generation.epoch,
          generation.revision,
          generation.phase,
        ).changes === 1
    );
  }
}
