/**
 * Validation failures from the deterministic domain layer.
 *
 * The Rust implementation returned `Result<T, CoreError>`, forcing every
 * caller to handle failure. TypeScript has no equivalent that survives
 * contact with the rest of the ecosystem, so these throw instead — but the
 * `kind` discriminant is preserved so callers can branch exhaustively and the
 * HTTP layer can map each case to a status code without string matching.
 */

export type DomainErrorKind =
  | "empty_text"
  | "confidence_out_of_range"
  | "invalid_confidence_thresholds"
  | "inconsistent_classification"
  | "candidate_limit_too_small"
  | "invalid_todo_status"
  | "invalid_todo_transition"
  | "invalid_todo_time"
  | "invalid_todo_plan"
  | "invalid_repeat_rule"
  | "unsupported_repeat_rule";

export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(kind: DomainErrorKind, message: string) {
    super(message);
    this.name = "DomainError";
    this.kind = kind;
  }

  static emptyText(field: string): DomainError {
    return new DomainError("empty_text", `${field} must not be empty`);
  }

  static confidenceOutOfRange(confidence: number): DomainError {
    return new DomainError(
      "confidence_out_of_range",
      `confidence must be between 0 and 1, got ${confidence}`,
    );
  }

  static invalidConfidenceThresholds(
    confirm: number,
    auto: number,
  ): DomainError {
    return new DomainError(
      "invalid_confidence_thresholds",
      `confidence thresholds must satisfy 0 <= confirm <= auto <= 1; ` +
        `got confirm=${confirm}, auto=${auto}`,
    );
  }

  static inconsistentClassification(detail: string): DomainError {
    return new DomainError("inconsistent_classification", detail);
  }

  static candidateLimitTooSmall(): DomainError {
    return new DomainError(
      "candidate_limit_too_small",
      "candidate limit must be at least 1",
    );
  }

  static invalidTodoStatus(status: unknown): DomainError {
    return new DomainError(
      "invalid_todo_status",
      `invalid TODO status: ${String(status)}`,
    );
  }

  static invalidTodoTransition(from: string, to: string): DomainError {
    return new DomainError(
      "invalid_todo_transition",
      `TODO cannot transition from ${from} to ${to}`,
    );
  }

  static invalidTodoTime(field: string, value: unknown): DomainError {
    return new DomainError(
      "invalid_todo_time",
      `${field} must be an ISO 8601 timestamp with an explicit timezone: ${String(value)}`,
    );
  }

  static invalidTodoPlan(detail: string): DomainError {
    return new DomainError("invalid_todo_plan", detail);
  }

  static invalidRepeatRule(detail: string): DomainError {
    return new DomainError("invalid_repeat_rule", detail);
  }

  static unsupportedRepeatRule(detail: string): DomainError {
    return new DomainError("unsupported_repeat_rule", detail);
  }
}

/** Trim `value`, throwing when nothing is left. */
export function requiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned === "") throw DomainError.emptyText(field);
  return cleaned;
}
