import { safeStoredSourceError, type SourceCache } from './history';
import type { ICalErrorCode, SkippedEvent } from './ical-errors';
import type { PluginSettings } from './types';

/** `kept`: the calendar still shows the version of this event from before it became invalid. */
export type SkippedReport = SkippedEvent & { kept: boolean };

const SKIP_REASONS: Partial<Record<ICalErrorCode, string>> = {
  'invalid-event-interval': 'Its end is not after its start. An iCalendar event has to end after it starts.',
  'invalid-event-time': 'One of its dates or times is not valid.',
  'invalid-time-zone': 'It uses a time zone that is unknown and not defined in the feed.',
  'missing-event-uid': 'It has no UID, so it cannot be told apart from other events.',
  'duplicate-event-uid': 'The feed contains more than one event with this UID.',
  'missing-event-start': 'It has no start time.',
  'duplicate-recurrence': 'The series lists the same occurrence more than once.',
  'recurrence-limit': 'The series repeats too many times to list.',
  'invalid-syntax': 'Its data could not be read as iCalendar.',
};

export function skipReason(code: ICalErrorCode): string {
  return SKIP_REASONS[code] ?? 'Its data is not valid.';
}

/** What one subscription's latest refresh could not import. */
export interface CalendarImportReport {
  sourceId: string;
  name: string;
  /** Why the whole feed failed; then nothing new was imported from it. */
  error?: string;
  lastSuccess?: string;
  skipped: SkippedReport[];
}

/** One report per enabled subscription, in settings order, including the ones without problems. */
export function importReports(settings: PluginSettings, caches: Record<string, SourceCache>,
  skippedOf: (sourceId: string) => readonly SkippedReport[]): CalendarImportReport[] {
  return settings.sources.filter(source => source.enabled && !!source.url.trim()).map(source => {
    const cache = caches[source.id];
    const error = safeStoredSourceError(cache?.error);
    return {
      sourceId: source.id, name: source.name, skipped: [...skippedOf(source.id)],
      ...(error ? { error } : {}), ...(cache?.lastSuccess ? { lastSuccess: cache.lastSuccess } : {}),
    };
  });
}

export function skippedCount(reports: readonly CalendarImportReport[]): number {
  return reports.reduce((sum, report) => sum + report.skipped.length, 0);
}

export function skippedLine(count: number): string {
  return `${count} ${count === 1 ? 'event has invalid data and was' : 'events have invalid data and were'} skipped.`;
}

export function skippedOutcome(item: SkippedReport): string {
  return item.kept ? 'Skipped. The calendar keeps the last valid version.' : 'Skipped. Not in the calendar.';
}

/** The same content as the dialog, for pasting into a bug report or a message to the calendar's owner. */
export function importReportText(reports: readonly CalendarImportReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(`${report.name}: ${report.error ? `refresh failed. ${report.error}` : report.skipped.length ? skippedLine(report.skipped.length) : 'no problems.'}`);
    for (const item of report.skipped) {
      lines.push(`- ${item.title ?? '(no title)'}`);
      lines.push(`  Problem: ${skipReason(item.code)} [${item.code}]`);
      if (item.start) lines.push(`  Start: ${item.start}`);
      if (item.end) lines.push(`  End: ${item.end}`);
      if (item.recurrenceId) lines.push(`  Occurrence: ${item.recurrenceId}`);
      if (item.uid) lines.push(`  UID: ${item.uid}`);
      lines.push(`  ${skippedOutcome(item)}`);
    }
  }
  return lines.join('\n');
}
