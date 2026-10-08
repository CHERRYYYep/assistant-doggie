/** Cancellation boundaries never expose a caller's arbitrary abort reason. */

export function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Check both sides of an await, including models that ignore cancellation. */
export async function withCancellation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error: unknown) {
    throwIfAborted(signal);
    if (isAbortError(error)) throw abortError();
    throw error;
  }
}
