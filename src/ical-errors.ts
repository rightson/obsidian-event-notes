export type ICalErrorCode =
  | "invalid-feed"
  | "invalid-syntax"
  | "invalid-range"
  | "feed-too-large"
  | "invalid-time-zone"
  | "invalid-event-time"
  | "missing-event-uid"
  | "duplicate-event-uid"
  | "missing-event-start"
  | "duplicate-recurrence"
  | "invalid-event-interval"
  | "recurrence-limit"
  | "unsupported-calendar-update";

export class ICalError extends Error {
  readonly code: ICalErrorCode;

  constructor(
    public readonly kind: "parse" | "zone" | "limit",
    message: string,
    code: ICalErrorCode = kind === "zone" ? "invalid-time-zone" : kind === "limit" ? "recurrence-limit" : "invalid-syntax",
  ) {
    super(message);
    this.name = "ICalError";
    this.code = code;
  }
}

/**
 * One event (or whole repeating series) left out because the feed's data for
 * it is invalid. Feed content: show it to the user, never persist or log it.
 */
export interface SkippedEvent {
  code: ICalErrorCode;
  uid?: string;
  title?: string;
  /** The feed's own values, for example `2026-03-10T12:00:00 (Asia/Taipei)`. */
  start?: string;
  end?: string;
  recurrenceId?: string;
}
