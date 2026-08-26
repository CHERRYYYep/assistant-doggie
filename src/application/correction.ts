/** Product-level correction orchestration over the transactional Store. */

import type {
  DeleteBucketOutcome,
  EntryRow,
  MoveEntryOutcome,
} from "../storage/store.ts";
import { Store } from "../storage/store.ts";

export type CorrectionErrorKind =
  | "empty_command"
  | "no_entry"
  | "unrecognized_target"
  | "target_not_found"
  | "ambiguous_target";

export class CorrectionError extends Error {
  readonly kind: CorrectionErrorKind;

  constructor(kind: CorrectionErrorKind, message: string) {
    super(message);
    this.name = "CorrectionError";
    this.kind = kind;
  }
}

export type CorrectionResult = {
  readonly correctionId: string;
  readonly commandText: string;
  readonly action: "move_entry";
  readonly targetType: "entry";
  readonly entry: EntryRow;
  readonly entryId: string;
  readonly sourceBucketId: string;
  readonly targetBucketId: string;
};

export type EntryDeletionResult = {
  readonly action: "delete_entry";
  readonly targetType: "entry";
  readonly targetId: string;
};

export type BucketDeletionResult = DeleteBucketOutcome & {
  readonly action: "delete_bucket";
  readonly targetType: "bucket";
  readonly targetId: string;
};

export class CorrectionService {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  moveEntry(
    entryId: string,
    targetBucketId: string,
    commandText: string,
  ): CorrectionResult {
    const command = cleanedCommand(commandText);
    return projectMove(
      command,
      this.#store.moveEntry(entryId, targetBucketId, command),
    );
  }

  moveLatestEntry(
    commandText: string,
    targetBucketId?: string,
  ): CorrectionResult {
    const command = cleanedCommand(commandText);
    const latest = this.#store.getLatestEntry();
    if (latest === undefined) {
      throw new CorrectionError("no_entry", "no entry is available to correct");
    }
    const target =
      targetBucketId === undefined
        ? this.#resolveTargetBucket(command)
        : targetBucketId.trim();
    if (target === "") {
      throw new CorrectionError(
        "unrecognized_target",
        "target bucket id must not be empty",
      );
    }
    return projectMove(
      command,
      this.#store.moveEntry(latest.id, target, command),
    );
  }

  deleteEntry(entryId: string, commandText: string): EntryDeletionResult {
    this.#store.deleteEntry(entryId, cleanedCommand(commandText));
    return { action: "delete_entry", targetType: "entry", targetId: entryId };
  }

  deleteBucket(bucketId: string, commandText: string): BucketDeletionResult {
    const outcome = this.#store.deleteBucket(
      bucketId,
      cleanedCommand(commandText),
    );
    return {
      ...outcome,
      action: "delete_bucket",
      targetType: "bucket",
      targetId: bucketId,
    };
  }

  #resolveTargetBucket(commandText: string): string {
    const title = targetTitleFromCommand(commandText);
    if (title === undefined) {
      throw new CorrectionError(
        "unrecognized_target",
        "无法从纠错命令中识别目标 Bucket，请显式选择目标",
      );
    }
    const buckets = this.#store.listBuckets();
    const exact = buckets.filter((bucket) => bucket.title === title);
    if (exact.length === 1) return exact[0]!.id;
    const containing = buckets.filter((bucket) => bucket.title.includes(title));
    if (containing.length === 1) return containing[0]!.id;
    if (containing.length === 0) {
      throw new CorrectionError(
        "target_not_found",
        `没有找到标题包含“${title}”的 Bucket`,
      );
    }
    throw new CorrectionError(
      "ambiguous_target",
      `存在多个标题包含“${title}”的 Bucket，请显式选择目标`,
    );
  }
}

function projectMove(
  commandText: string,
  outcome: MoveEntryOutcome,
): CorrectionResult {
  const { correctionId, sourceBucketId, targetBucketId, ...entry } = outcome;
  return {
    correctionId,
    commandText,
    action: "move_entry",
    targetType: "entry",
    entry,
    entryId: entry.id,
    sourceBucketId,
    targetBucketId,
  };
}

function cleanedCommand(commandText: string): string {
  const cleaned = commandText.trim();
  if (cleaned === "") {
    throw new CorrectionError(
      "empty_command",
      "command_text must not be empty",
    );
  }
  return cleaned;
}

/** Return the final `移到`/`放到` destination in a correction sentence. */
export function targetTitleFromCommand(
  commandText: string,
): string | undefined {
  const markers = ["移到", "放到"] as const;
  const matches: { start: number; marker: string }[] = [];
  for (const marker of markers) {
    let start = commandText.indexOf(marker);
    while (start !== -1) {
      matches.push({ start, marker });
      start = commandText.indexOf(marker, start + marker.length);
    }
  }
  matches.sort((left, right) => left.start - right.start);

  let result: string | undefined;
  for (const match of matches) {
    const remainder = commandText.slice(match.start + match.marker.length);
    const ends = ["里", "中", "，", ",", "。"]
      .map((delimiter) => remainder.indexOf(delimiter))
      .filter((index) => index >= 0);
    const end = ends.length === 0 ? remainder.length : Math.min(...ends);
    const captured = remainder
      .slice(0, end)
      .replace(/^[\s，,：:]+|[\s，,：:]+$/gu, "");
    if (captured !== "") result = captured;
  }
  return result;
}
