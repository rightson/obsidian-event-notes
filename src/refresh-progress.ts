/** The steps one subscription goes through, in order. */
export const CALENDAR_STEPS = ['prepare', 'request', 'response', 'parse', 'sync', 'cache'] as const;
export type CalendarStep = typeof CALENDAR_STEPS[number];
/** Steps that run once, before any subscription. */
export type RefreshStep = CalendarStep | 'settings' | 'scan';

export const STEP_LABELS: Record<RefreshStep, string> = {
  settings: 'Save settings',
  scan: 'Scan Event Notes',
  prepare: 'Check the subscription URL',
  request: 'Download the feed',
  response: 'Check the response',
  parse: 'Read the events',
  sync: 'Update Event Notes',
  cache: 'Save the result',
};

export interface CalendarPosition {
  sourceId: string;
  name: string;
  /** Zero-based position among the subscriptions being refreshed. */
  index: number;
  total: number;
}

export interface SourceRefreshOutcome {
  sourceId: string;
  name: string;
  /** `skipped`: not due yet. `cancelled`: its settings changed while it was refreshing. */
  status: 'updated' | 'unchanged' | 'skipped' | 'cancelled' | 'failed';
  /** The step that failed. */
  step?: CalendarStep;
  /** A fixed, privacy-safe reason; never feed content or a URL. */
  error?: string;
}

export type RefreshEvent =
  | { type: 'step'; step: CalendarStep; calendar: CalendarPosition }
  | { type: 'outcome'; outcome: SourceRefreshOutcome };

export interface ProgressView {
  state: 'running' | 'done' | 'failed';
  title: string;
  detail: string;
  /** 0 to 1. */
  fraction: number;
  /** One line per failed step. */
  failures: string[];
}

export interface ProgressTitles {
  running: string;
  failed: string;
}

function stepNumber(step: CalendarStep): string {
  return `step ${CALENDAR_STEPS.indexOf(step) + 1} of ${CALENDAR_STEPS.length}`;
}

export function failureLine(outcome: SourceRefreshOutcome): string {
  const where = outcome.step ? `${stepNumber(outcome.step)}, “${STEP_LABELS[outcome.step]}”` : 'refresh';
  return `${outcome.name}: failed at ${where}. ${outcome.error ?? 'The calendar could not be refreshed.'}`;
}

export function refreshSummary(outcomes: readonly SourceRefreshOutcome[]): string {
  const refreshed = outcomes.filter(outcome => outcome.status === 'updated' || outcome.status === 'unchanged').length;
  if (!outcomes.length) return 'No calendar subscriptions are turned on.';
  return `${refreshed} of ${outcomes.length} ${outcomes.length === 1 ? 'calendar' : 'calendars'} refreshed.`;
}

/** Turns refresh events into what a progress display shows. It holds no UI, so it can be tested. */
export class RefreshTracker {
  private step?: RefreshStep;
  private calendar?: CalendarPosition;
  readonly outcomes: SourceRefreshOutcome[] = [];

  /** With `only`, events of other subscriptions are ignored. */
  constructor(private readonly titles: ProgressTitles, private readonly only?: string) {}

  /** What to show right now. */
  current(): ProgressView { return this.running(); }

  private running(): ProgressView {
    const step = this.step;
    const calendar = this.calendar;
    if (!step) return { state: 'running', title: this.titles.running, detail: 'Starting…', fraction: 0, failures: [] };
    const ordinal = CALENDAR_STEPS.indexOf(step as CalendarStep);
    if (!calendar || ordinal < 0) {
      return { state: 'running', title: this.titles.running, detail: `${STEP_LABELS[step]}…`, fraction: 0.05, failures: [] };
    }
    const position = this.only || calendar.total === 1 ? '' : ` (${calendar.index + 1} of ${calendar.total})`;
    const share = this.only ? ordinal / CALENDAR_STEPS.length
      : (calendar.index + ordinal / CALENDAR_STEPS.length) / Math.max(1, calendar.total);
    return {
      state: 'running', title: this.titles.running, failures: [],
      detail: `${calendar.name}${position}: ${stepNumber(step as CalendarStep)}, ${STEP_LABELS[step]}…`,
      fraction: 0.1 + 0.9 * share,
    };
  }

  /** A step that is not part of one subscription, such as saving settings. */
  start(step: 'settings' | 'scan'): ProgressView {
    this.step = step;
    this.calendar = undefined;
    return this.running();
  }

  /** Undefined when the event belongs to a subscription this tracker does not follow. */
  handle(event: RefreshEvent): ProgressView | undefined {
    const sourceId = event.type === 'step' ? event.calendar.sourceId : event.outcome.sourceId;
    if (this.only && sourceId !== this.only) return undefined;
    if (event.type === 'step') {
      this.step = event.step;
      this.calendar = event.calendar;
    } else {
      this.outcomes.push(event.outcome);
    }
    return this.running();
  }

  /** The run ended without throwing; subscriptions that failed still make it a failure. */
  finish(summary: string, failedDetail = ''): ProgressView {
    const failures = this.outcomes.filter(outcome => outcome.status === 'failed').map(failureLine);
    if (failures.length) return { state: 'failed', title: this.titles.failed, detail: failedDetail, fraction: 1, failures };
    return { state: 'done', title: summary, detail: '', fraction: 1, failures: [] };
  }

  /** The run threw; the step it was on is the one that failed. */
  fail(error: unknown): ProgressView {
    const reason = error instanceof Error && error.message ? error.message : 'The action failed.';
    const failures = this.outcomes.filter(outcome => outcome.status === 'failed').map(failureLine);
    const step = this.step;
    const ordinal = CALENDAR_STEPS.indexOf(step as CalendarStep);
    if (!step) failures.push(reason);
    else if (this.calendar && ordinal >= 0) {
      failures.push(failureLine({ sourceId: this.calendar.sourceId, name: this.calendar.name, status: 'failed', step: step as CalendarStep, error: reason }));
    } else failures.push(`Failed at “${STEP_LABELS[step]}”. ${reason}`);
    return { state: 'failed', title: this.titles.failed, detail: '', fraction: 1, failures: [...new Set(failures)] };
  }
}
