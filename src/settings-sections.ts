import type { SourceCache } from './history';
import { holidayOptions } from './holidays';
import type { CalendarSource, PluginSettings } from './types';

/** What a collapsed settings section shows beside its heading. */
export interface SectionSummary {
  text: string;
  /** Something is wrong in this section, so it opens by itself. */
  attention: boolean;
}

export const sourceSectionKey = (id: string): string => `source:${id}`;

/** Attention beats a remembered close, so a failure is never hidden behind a heading. */
export function startsOpen(remembered: boolean, attention: boolean): boolean {
  return remembered || attention;
}

/** Sections are closed by default, so only the open ones are stored. */
export function readOpenSections(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((key): key is string => typeof key === 'string'))] : [];
}

/** The remembered list after a toggle; calendars that no longer exist drop out. */
export function withSectionOpen(open: readonly string[], key: string, isOpen: boolean, sourceIds: readonly string[]): string[] {
  const live = new Set(sourceIds.map(sourceSectionKey));
  const kept = open.filter(item => item !== key && (!item.startsWith('source:') || live.has(item)));
  return isOpen ? [...kept, key] : kept;
}

/**
 * The heading row among a setting group's children. Obsidian puts it first, but only while the
 * group has a heading; the group's search box always sits right before the rows.
 */
export function sectionHeading<T extends { classList: { contains(name: string): boolean } }>(children: ArrayLike<T>): T | null {
  return Array.from(children).find(child => child.classList.contains('setting-item-heading')) ?? null;
}

/**
 * Settings search scrolls to whatever Obsidian's row lookup returns, and a folded row cannot be
 * scrolled to. So the lookup unfolds the row's section first.
 */
export function revealOnLookup<D, E>(lookup: ((definition: D) => E | undefined) | undefined, reveal: (element: E) => void): (definition: D) => E | undefined {
  return definition => {
    const element = lookup?.(definition);
    if (element) reveal(element);
    return element;
  };
}

const calm = (text: string): SectionSummary => ({ text, attention: false });
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function notePathsSummary(settings: PluginSettings): SectionSummary {
  return calm(`Event Notes: ${settings.eventPattern}`);
}

export function displaySummary(settings: PluginSettings): SectionSummary {
  const weekStart = settings.weekStart === 'locale' ? 'by locale' : capitalize(settings.weekStart);
  return calm(`${settings.timeZone} · week starts ${weekStart} · ${settings.snapMinutes}-minute snap`);
}

export function clickingSummary(settings: PluginSettings): SectionSummary {
  const event = { dialog: 'details', split: 'note beside', tab: 'note in new tab' }[settings.eventClickAction];
  const slot = { auto: 'by view', event: 'new event', split: 'Daily Note beside', tab: 'Daily Note in new tab', none: 'nothing' }[settings.mainDateClickAction];
  return calm(`Event: ${event} · Empty slot: ${slot}`);
}

export function monthsSummary(settings: PluginSettings): SectionSummary {
  return calm(`At least ${plural(settings.monthsMinimum, 'month')} · ${settings.monthsOnStartup ? 'added' : 'not added'} at startup`);
}

export function agendaSummary(settings: PluginSettings): SectionSummary {
  return calm(settings.agendaKeepTime ? 'Keeps the time of day' : 'Opens each date at its first event');
}

export function ganttSummary(settings: PluginSettings): SectionSummary {
  return calm(`People in ${settings.ganttPeopleFolder || 'the Vault root'} · ${settings.ganttConfirmWrites ? 'previews first change' : 'no preview'}`);
}

// Same rule as the calendar's failure banner: a stale error of a calendar that is off is not a failure.
const failedRefresh = (source: CalendarSource, cache: SourceCache | undefined): boolean =>
  source.enabled && !!source.url.trim() && !!cache?.error;

export function subscriptionsSummary(settings: PluginSettings, caches: Record<string, SourceCache | undefined>): SectionSummary {
  const failed = settings.sources.filter(source => failedRefresh(source, caches[source.id])).length;
  const calendars = settings.sources.length ? plural(settings.sources.length, 'calendar') : 'No calendars';
  const every = settings.syncIntervalMinutes === 1 ? 'minute' : `${settings.syncIntervalMinutes} minutes`;
  return { text: `${calendars}${failed ? `, ${failed} failed to refresh` : ''} · refresh every ${every}`, attention: failed > 0 };
}

/** The heading already carries the name, so this adds the type and how the last refresh went. */
export function sourceSummary(source: CalendarSource, cache: SourceCache | undefined, skipped = 0): SectionSummary {
  const type = holidayOptions(source).kind === 'holidays' ? 'Holidays' : 'Events';
  if (!source.url.trim()) return calm(`${type} · Inactive, no URL`);
  if (!source.enabled) return calm(`${type} · Disabled`);
  const failed = failedRefresh(source, cache);
  const status = failed ? 'Last refresh failed' : cache?.lastSuccess ? 'Refreshed' : 'Not refreshed yet';
  // Skipped events come from the feed's owner and can stay for good, so they do not force the section open.
  return { text: `${type} · ${status}${skipped ? `, ${plural(skipped, 'event')} skipped` : ''}`, attention: failed };
}

export function diagnosticsSummary(problems: number): SectionSummary {
  return problems ? { text: `${plural(problems, 'problem')} found`, attention: true } : calm('No problems');
}
