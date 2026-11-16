import type { App } from 'obsidian';
import { dailyNoteFolder, usesDailyFolder } from './paths';
import { resolveDailySettings } from './settings';
import { pathKey } from './state';
import type { PluginSettings } from './types';

/** Two dates in different years and months: Daily Notes that share a folder for both share it for every date. */
const SAMPLE_DATE = '2026-10-23';
const OTHER_DATE = '2027-03-14';

/**
 * Whether to suggest the Daily Note folder wizard at startup: `{daily}` files Event
 * Notes beside Daily Notes that all share one folder, so every Event Note and
 * attachment would pile up there. False when the pattern does not use `{daily}`, the
 * Daily Note format already adds date folders such as `YYYY/MM/YYYY-MM-DD`, or the
 * settings do not give a valid path.
 */
export function dailyNotesShareFolder(app: App, settings: PluginSettings): boolean {
  if (!usesDailyFolder(settings.eventPattern)) return false;
  try {
    return pathKey(dailyNoteFolder(SAMPLE_DATE, app, settings)) === pathKey(dailyNoteFolder(OTHER_DATE, app, settings));
  } catch { return false; }
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

type RecordLike = Record<string, unknown>;
const record = (value: unknown): RecordLike | undefined =>
  value !== null && typeof value === 'object' ? value as RecordLike : undefined;

/**
 * Change the core Daily notes plugin's date format. Obsidian has no public API for
 * this, so every part is feature-checked and only the plugin's own save is used:
 * its settings file is never written from here. Resolves to false, with nothing
 * changed, when any part is missing or the save fails; the wizard then asks the
 * user to change the format in Obsidian's settings.
 */
export async function setCoreDailyFormat(app: App, settings: PluginSettings, format: string): Promise<boolean> {
  const plugin = record(record(record((app as unknown as RecordLike).internalPlugins)?.plugins)?.['daily-notes']);
  const options = record(record(plugin?.instance)?.options);
  if (!plugin || plugin.enabled !== true || !options || typeof plugin.saveData !== 'function') return false;
  if (!Object.isExtensible(options) || ('format' in options && typeof options.format !== 'string')) return false;
  const had = 'format' in options;
  const before = options.format;
  const restore = (): void => { if (had) options.format = before; else delete options.format; };
  try {
    options.format = format;
    await (plugin.saveData as () => unknown).call(plugin);
  } catch {
    try { restore(); } catch { /* nothing more can be done */ }
    return false;
  }
  const resolved = resolveDailySettings(app, settings);
  if (resolved.provider === 'daily-notes' && resolved.format === format) return true;
  restore();
  return false;
}
