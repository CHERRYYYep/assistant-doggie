/** Application boundary for explicit Bucket lifecycle changes. */

import type { BucketStatus } from "../domain/types.ts";
import type { BucketRow } from "../storage/store.ts";
import { Store } from "../storage/store.ts";

export class BucketStatusService {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  setStatus(bucketId: string, status: BucketStatus): BucketRow {
    return this.#store.setBucketStatus(bucketId, status);
  }
}
