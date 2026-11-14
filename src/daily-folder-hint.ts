import type { App } from 'obsidian';
import moment from 'moment-timezone';
import type { CalendarEvent, NoteProvider, PluginSettings } from './types';
import { dailyNoteFolder, dailyNotePath, eventNotePath, folderPath, formatNotePath, usesDailyFolder } from './paths';
import { resolveDailySettings } from './settings';
import { pathKey } from './state';

/** The folder each day gets, inserted before the Daily Note's own name. */
export const DAY_FOLDER_FORMAT = 'YYYY-MM-DD';

/** Two dates in different years and months: Daily Notes that share a folder for both share it for every date. */
const SAMPLE_DATE = '2026-10-23';
const OTHER_DATE = '2027-03-14';
// All-day, so the sample stays on its date in every display zone.
const sample: CalendarEvent = {
  id: 'local|sample', sourceId: 'local', uid: 'sample', title: 'Sample event',
  start: SAMPLE_DATE, end: '2026-10-24', allDay: true,
};

export interface DailyFolderHint {
  provider: NoteProvider;
  /** The folder every Daily Note is in now; empty at the Vault root. */
  folder: string;
  format: string;
  suggestedFormat: string;
  now: { daily: string; event: string };
  suggested: { daily: string; event: string };
}

/** `[Journal]/YYYY-MM-DD` becomes `[Journal]/YYYY-MM-DD/YYYY-MM-DD`: the day folder goes right above the note. */
export function dayFolderFormat(format: string): string {
  const trimmed = format.trim();
  const slash = trimmed.lastIndexOf('/');
  return `${trimmed.slice(0, slash + 1)}${DAY_FOLDER_FORMAT}/${trimmed.slice(slash + 1)}`;
}

/**
 * A suggestion when `{daily}` files Event Notes beside Daily Notes that all share one
 * folder, so every Event Note and attachment would pile up there. Undefined when the
 * pattern does not use `{daily}`, the Daily Note format already adds date folders such
 * as `YYYY/MM/YYYY-MM-DD`, or the settings do not give a valid path.
 */
export function dailyFolderHint(app: App, settings: PluginSettings): DailyFolderHint | undefined {
  if (!usesDailyFolder(settings.eventPattern)) return undefined;
  try {
    const provider = resolveDailySettings(app, settings);
    const folder = dailyNoteFolder(SAMPLE_DATE, app, settings);
    if (pathKey(folder) !== pathKey(dailyNoteFolder(OTHER_DATE, app, settings))) return undefined;
    const suggestedFormat = dayFolderFormat(provider.format);
    const rules = { locale: settings.locale, weekMode: settings.weekMode, weekStart: settings.weekStart };
    const base = folderPath(provider.folder);
    const name = formatNotePath(suggestedFormat, SAMPLE_DATE, rules, settings.timeZone, {}, true);
    const suggestedDaily = base ? `${base}/${name}` : name;
    const event = eventNotePath(sample, 'Local', app, settings);
    const rest = folder ? event.slice(folder.length + 1) : event;
    return {
      provider: provider.provider, folder, format: provider.format, suggestedFormat,
      now: { daily: dailyNotePath(SAMPLE_DATE, app, settings), event },
      suggested: { daily: suggestedDaily, event: `${suggestedDaily.slice(0, suggestedDaily.lastIndexOf('/'))}/${rest}` },
    };
  } catch { return undefined; }
}

/**
 * The Daily Notes among these Vault paths that sit in the shared folder and are named
 * by the current format. Changing the format does not move them, so the hint counts them.
 */
export function existingDailyNotes(paths: Iterable<string>, hint: DailyFolderHint, locale: string): string[] {
  const nameFormat = hint.format.trim().slice(hint.format.trim().lastIndexOf('/') + 1);
  const folder = pathKey(hint.folder);
  const found: string[] = [];
  for (const path of paths) {
    if (!/\.md$/i.test(path)) continue;
    const slash = path.lastIndexOf('/');
    if (pathKey(path.slice(0, Math.max(slash, 0))) !== folder) continue;
    if (moment(path.slice(slash + 1, -3), nameFormat, locale, true).isValid()) found.push(path);
  }
  return found;
}

/** Obsidian's "Default location for new attachments": `./` and `./<subfolder>` follow the note. */
export type AttachmentPlacement = 'beside-note' | 'elsewhere' | 'unknown';

export function attachmentPlacement(folder: unknown): AttachmentPlacement {
  if (typeof folder !== 'string') return 'unknown';
  return folder === '.' || folder.startsWith('./') ? 'beside-note' : 'elsewhere';
}

/** The vault config API is undocumented, so it is feature-checked. */
export function attachmentFolderSetting(app: App): unknown {
  const vault = app.vault as unknown as { getConfig?: (key: string) => unknown };
  return typeof vault.getConfig === 'function' ? vault.getConfig('attachmentFolderPath') : undefined;
}
