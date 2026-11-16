import moment from 'moment-timezone';
import { dailyNotePathIn, folderPath, followPath } from './paths';
import { pathKey, type StoredState } from './state';
import type { WeekRules } from './types';

/**
 * Planning for the Daily Note folder wizard: which notes the old format names, where
 * the new format puts them, and what must not be touched. Nothing here reads the
 * Vault; the wizard passes in its file list and carries out the plan through an adapter.
 */

/** Each day's folder is `YYYY/MM/MM-DD` under the Daily Notes folder. */
export const DEFAULT_TARGET_FORMAT = 'YYYY/MM/MM-DD/MMMM DD';

export interface DailyLayout {
  /** The Daily Notes base folder; empty at the Vault root. */
  folder: string;
  format: string;
}

export interface FormatContext {
  rules: WeekRules;
  zone: string;
  /** Other locales existing notes may be named in, such as Obsidian's own. */
  locales?: string[];
}

const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0));
const join = (folder: string, rest: string): string => folder ? `${folder}/${rest}` : rest;
const byKey = (a: string, b: string): number => { const x = pathKey(a), y = pathKey(b); return x < y ? -1 : x > y ? 1 : 0; };

export function dailyPathFor(date: string, layout: DailyLayout, context: FormatContext): string {
  return dailyNotePathIn(layout.folder, layout.format, date, context.rules, context.zone);
}

/**
 * Reads the date out of a path. The whole path below the base folder is parsed
 * strictly, because a file name such as `Nov 16` does not say which year it is. A
 * path counts only when formatting its date gives the same path back, so notes
 * that merely look similar are left alone.
 */
function dateReader(layout: DailyLayout, context: FormatContext): (path: string) => string | undefined {
  const base = folderPath(layout.folder);
  const prefix = base ? `${pathKey(base)}/` : '';
  const format = layout.format.trim().replace(/(?:\.md)+$/i, '');
  const locales = [...new Set([context.rules.locale, ...context.locales ?? []])];
  let depth: number;
  try { depth = dailyNotePathIn('', format, '2026-10-23', context.rules, context.zone).split('/').length; }
  catch { return () => undefined; }
  return path => {
    if (!/\.md$/i.test(path)) return undefined;
    const normal = path.normalize('NFC');
    if (prefix && !pathKey(normal).startsWith(prefix)) return undefined;
    const relative = normal.slice(prefix.length, -3);
    if (relative.split('/').length !== depth) return undefined;
    for (const locale of locales) {
      const parsed = moment(relative, format, locale, true);
      if (!parsed.isValid()) continue;
      const date = parsed.format('YYYY-MM-DD');
      try {
        const again = dailyNotePathIn(base, format, date, { ...context.rules, locale }, context.zone);
        if (pathKey(again) === pathKey(normal)) return date;
      } catch { /* a date the format cannot write is not a Daily Note */ }
    }
    return undefined;
  };
}

/** The `YYYY-MM-DD` date of the Daily Note at `path`, or undefined when the layout does not name it. */
export function dailyDateOf(path: string, layout: DailyLayout, context: FormatContext): string | undefined {
  return dateReader(layout, context)(path);
}

export interface DailyNoteFile { path: string; date: string }

export function findDailyNotes(paths: Iterable<string>, layout: DailyLayout, context: FormatContext): DailyNoteFile[] {
  const read = dateReader(layout, context);
  const found: DailyNoteFile[] = [];
  for (const path of paths) {
    const date = read(path);
    if (date) found.push({ path, date });
  }
  return found;
}

export interface FormatCheck {
  /** Why the format cannot be used. */
  error?: string;
  /** Usable, but probably not what a folder per day is for. */
  warning?: string;
  /** Every day gets a folder of its own. */
  dayFolders: boolean;
  /** Notes named by this format can be recognised again by reading their path. */
  parseable: boolean;
}

/** Four years including a leap day: enough to catch a format that drops the year, month or day. */
let sampleDays: string[] | undefined;
function samples(): string[] {
  if (!sampleDays) {
    sampleDays = [];
    for (const day = moment.utc('2024-01-01'); day.year() < 2028; day.add(1, 'day')) sampleDays.push(day.format('YYYY-MM-DD'));
  }
  return sampleDays;
}

export function checkDailyFormat(format: string, context: FormatContext): FormatCheck {
  const failed = (error: string): FormatCheck => ({ error, dayFolders: false, parseable: false });
  if (typeof format !== 'string' || !format.trim()) return failed('Enter a date format, such as YYYY/MM/MM-DD/MMMM DD.');
  const layout: DailyLayout = { folder: '', format };
  const paths = new Map<string, string>();
  const folders = new Map<string, string>();
  let shared: [string, string, string] | undefined;
  try {
    for (const day of samples()) {
      const path = dailyPathFor(day, layout, context);
      const twin = paths.get(pathKey(path));
      if (twin) return failed(`This format gives ${twin} and ${day} the same path, ${path}. It must include the year, month and day.`);
      paths.set(pathKey(path), day);
      const folder = folderOf(path);
      const neighbour = folders.get(pathKey(folder));
      if (neighbour && !shared) shared = [neighbour, day, folder];
      folders.set(pathKey(folder), day);
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'This is not a valid date format.');
  }
  const read = dateReader(layout, context);
  const parseable = samples().every((day, index) => index % 29 !== 0 || read(dailyPathFor(day, layout, context)) === day);
  if (!shared) return { dayFolders: true, parseable };
  const where = shared[2] ? `the folder ${shared[2]}` : 'one folder';
  return { dayFolders: false, parseable,
    warning: `Different days share a folder: ${shared[0]} and ${shared[1]} are both in ${where}. Their Event Notes and attachments will be mixed together.` };
}

/** The formats the wizard starts with: after a partial run the format is already new, and the notes left behind are in the remembered one. */
export function migrationDefaults(current: string, remembered: string): { from: string; to: string } {
  const former = remembered.trim();
  if (former && former !== current.trim()) return { from: former, to: current.trim() };
  return { from: current.trim(), to: DEFAULT_TARGET_FORMAT };
}

export type MoveKind = 'daily' | 'event' | 'extra';

export interface PlannedMove {
  kind: MoveKind;
  from: string;
  to: string;
  /** The day the file belongs to. */
  date: string;
  /** The event of an Event Note. */
  eventId?: string;
}

export type ConflictReason =
  /** Another file is already at the new path. */
  | 'target-exists'
  /** Two files would get the same new path. */
  | 'same-target'
  /** The new path is held by a note that is itself moving. */
  | 'target-moving'
  /** The path fits the old and the new format as different days, so it may already have been moved. */
  | 'ambiguous';

export interface MoveConflict extends PlannedMove { reason: ConflictReason }

/** An Event Note this plugin tracks, with the Daily Note its entry is in. */
export interface TrackedEventNote {
  id: string;
  path: string;
  dailyPath: string;
  /** The event's day, when the event is known. */
  date?: string;
  /** The Event Note pattern's path for this event, given each date's Daily Note folder. */
  patternPath?: (dailyFolder: (date: string) => string) => string;
}

export interface PlanOptions {
  moveEvents: boolean;
  moveExtras: boolean;
  includeAmbiguous: boolean;
}

export interface MigrationPlan {
  /** Daily Notes the old format names. */
  found: number;
  /** Of those, already at the path the new format gives. */
  unchanged: number;
  /** In the order they are carried out: a day's Daily Note last, so an interrupted day is found again. */
  moves: PlannedMove[];
  conflicts: MoveConflict[];
  /** Files beside the moved Daily Notes that stay where they are. */
  left: string[];
  /** Event Notes that can follow, whether or not `moveEvents` is on. */
  eventNotes: number;
  /** Other files in single-day folders that can follow, whether or not `moveExtras` is on. */
  extras: number;
  ambiguous: number;
}

export interface PlanInput {
  /** Every file path in the Vault. */
  files: Iterable<string>;
  /** The Daily Notes base folder. */
  folder: string;
  /** The format existing Daily Notes are in. */
  from: string;
  /** The format they move to. */
  to: string;
  ctx: FormatContext;
  tracked?: TrackedEventNote[];
  options?: Partial<PlanOptions>;
}

const ORDER: Record<MoveKind, number> = { event: 0, extra: 1, daily: 2 };

export function planMigration(input: PlanInput): MigrationPlan {
  const options: PlanOptions = { moveEvents: true, moveExtras: true, includeAmbiguous: false, ...input.options };
  const context = input.ctx;
  const oldLayout: DailyLayout = { folder: input.folder, format: input.from };
  const newLayout: DailyLayout = { folder: input.folder, format: input.to };
  const paths = [...input.files];
  // Two paths can share a key on a disk that tells upper and lower case apart; the first one stands for both.
  const files = new Map<string, string>();
  for (const path of paths) if (!files.has(pathKey(path))) files.set(pathKey(path), path);
  const readOld = dateReader(oldLayout, context);
  const readNew = dateReader(newLayout, context);
  const oldFolder = (date: string): string => folderOf(dailyPathFor(date, oldLayout, context));
  const newFolder = (date: string): string => folderOf(dailyPathFor(date, newLayout, context));
  const dayFolders = checkDailyFormat(input.from, context).dayFolders;

  const conflicts: MoveConflict[] = [];
  const candidates: PlannedMove[] = [];
  const left = new Set<string>();
  const dailyKeys = new Set<string>();
  let found = 0, unchanged = 0, ambiguous = 0;
  for (const path of paths) {
    const date = readOld(path);
    if (!date) continue;
    found++;
    dailyKeys.add(pathKey(path));
    const move: PlannedMove = { kind: 'daily', from: path, to: dailyPathFor(date, newLayout, context), date };
    if (pathKey(move.to) === pathKey(path)) { unchanged++; continue; }
    const other = readNew(path);
    if (other && other !== date) {
      ambiguous++;
      if (!options.includeAmbiguous) { conflicts.push({ ...move, reason: 'ambiguous' }); continue; }
    }
    candidates.push(move);
  }

  // Event Notes the pattern placed in the old day folder go where it places them now.
  const eventKeys = new Set<string>();
  let eventNotes = 0;
  for (const note of input.tracked ?? []) {
    const key = pathKey(note.path);
    const current = files.get(key);
    if (!current || dailyKeys.has(key) || eventKeys.has(key)) continue;
    const date = note.date ?? readOld(note.dailyPath) ?? readNew(note.dailyPath);
    if (!date) continue;
    let target: string | undefined;
    try {
      if (note.patternPath) target = followPath(current, note.patternPath(oldFolder), note.patternPath(newFolder));
      else {
        const was = oldFolder(date);
        const inside = pathKey(folderOf(current)) === pathKey(was) || (dayFolders && !!was && key.startsWith(`${pathKey(was)}/`));
        if (inside) target = join(newFolder(date), was ? current.slice(was.length + 1) : current);
      }
    } catch { /* a pattern that gives no path moves nothing */ }
    if (!target || pathKey(target) === key) continue;
    eventNotes++;
    eventKeys.add(key);
    if (options.moveEvents) candidates.push({ kind: 'event', from: current, to: target, date, eventId: note.id });
    else left.add(current);
  }

  // What else is in a moved day's old folder: it follows only when that folder held a single day.
  const days = new Map<string, PlannedMove>();
  for (const move of candidates) if (move.kind === 'daily') days.set(pathKey(folderOf(move.from)), move);
  let extras = 0;
  const extraOf = new Map<string, string>();
  for (const [key, path] of files) {
    if (dailyKeys.has(key) || eventKeys.has(key)) continue;
    if (!dayFolders) {
      if (days.has(pathKey(folderOf(path)))) left.add(path);
      continue;
    }
    let folder = folderOf(path);
    let day: PlannedMove | undefined;
    while (folder && !(day = days.get(pathKey(folder)))) folder = folderOf(folder);
    if (!day || !folder) continue;
    const target = folderOf(day.to);
    // Already below the new folder, when the new folder is inside the old one.
    if (pathKey(target) === pathKey(folder) || pathKey(path).startsWith(`${pathKey(target)}/`)) continue;
    extras++;
    if (!options.moveExtras) { left.add(path); continue; }
    candidates.push({ kind: 'extra', from: path, to: join(target, path.slice(folder.length + 1)), date: day.date });
    extraOf.set(key, pathKey(day.from));
  }

  const targets = new Map<string, number>();
  for (const move of candidates) targets.set(pathKey(move.to), (targets.get(pathKey(move.to)) ?? 0) + 1);
  const sources = new Set(candidates.map(move => pathKey(move.from)));
  const blocked = new Set<string>();
  const moves: PlannedMove[] = [];
  for (const move of candidates) {
    const key = pathKey(move.to);
    const reason: ConflictReason | undefined = (targets.get(key) ?? 0) > 1 ? 'same-target'
      : !files.has(key) ? undefined : sources.has(key) ? 'target-moving' : 'target-exists';
    if (!reason) { moves.push(move); continue; }
    conflicts.push({ ...move, reason });
    if (move.kind === 'daily') blocked.add(pathKey(move.from));
  }
  // A day whose Daily Note stays keeps the rest of its folder too.
  const kept = moves.filter(move => {
    const day = move.kind === 'extra' ? extraOf.get(pathKey(move.from)) : undefined;
    if (!day || !blocked.has(day)) return true;
    left.add(move.from);
    return false;
  });
  const order = (a: PlannedMove, b: PlannedMove): number =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : ORDER[a.kind] - ORDER[b.kind] || byKey(a.from, b.from);
  return { found, unchanged, moves: kept.sort(order), conflicts: conflicts.sort(order), left: [...left].sort(byKey), eventNotes, extras, ambiguous };
}

/**
 * Folders worth checking for removal after a move, deepest first: the old folders
 * of moved Daily Notes, what was inside them, and their parents below the base
 * folder. The base folder itself and anything outside it are never listed.
 */
export function cleanupCandidates(moved: readonly PlannedMove[], baseFolder: string): string[] {
  const base = pathKey(folderPath(baseFolder));
  const below = (folder: string): boolean => !!folder && (base ? pathKey(folder).startsWith(`${base}/`) : true);
  const dayFolders = moved.filter(move => move.kind === 'daily').map(move => folderOf(move.from)).filter(below);
  const found = new Map<string, string>();
  for (const move of moved) {
    let folder = folderOf(move.from);
    const key = pathKey(folder);
    if (!dayFolders.some(day => key === pathKey(day) || key.startsWith(`${pathKey(day)}/`))) continue;
    for (; below(folder); folder = folderOf(folder)) found.set(pathKey(folder), folder);
  }
  const depth = (folder: string): number => folder.split('/').length;
  return [...found.values()].sort((a, b) => depth(b) - depth(a) || byKey(a, b));
}

/**
 * Point the plugin's records at moved notes, so the next scan finds each entry in
 * the Daily Note it tracks instead of adding it to a new one. An Event Note's own
 * link is left to the rename handler, which also rewrites its Daily entry. Returns
 * how many records changed.
 */
export function retargetState(state: Pick<StoredState, 'noteLinks' | 'pathTypes' | 'history'>,
  moves: readonly Pick<PlannedMove, 'kind' | 'from' | 'to'>[]): number {
  let changed = 0;
  for (const move of moves) {
    const from = pathKey(move.from);
    if (move.kind === 'daily') {
      for (const link of Object.values(state.noteLinks)) {
        if (pathKey(link.dailyPath) === from) { link.dailyPath = move.to; changed++; }
      }
      const claim = state.pathTypes[from];
      if (claim?.type === 'daily') {
        delete state.pathTypes[from];
        state.pathTypes[pathKey(move.to)] = claim;
        changed++;
      }
    }
    for (const entry of state.history) {
      if (move.kind === 'daily') {
        if (entry.beforeDailyPath && pathKey(entry.beforeDailyPath) === from) { entry.beforeDailyPath = move.to; changed++; }
        if (entry.afterDailyPath && pathKey(entry.afterDailyPath) === from) { entry.afterDailyPath = move.to; changed++; }
      } else if (move.kind === 'event' && entry.notePath && pathKey(entry.notePath) === from) { entry.notePath = move.to; changed++; }
    }
  }
  return changed;
}

/** What the move needs from the Vault; the tests pass a fake. */
export interface MigrationAdapter {
  exists(path: string): Promise<boolean>;
  /** Moves one file, creating missing parent folders and updating links to it. */
  move(move: PlannedMove): Promise<void>;
  /** Called after each successful move, to keep the plugin's records with the files. */
  record(move: PlannedMove): Promise<void>;
  isEmptyFolder(path: string): Promise<boolean>;
  removeFolder(path: string): Promise<void>;
}

export interface MigrationHooks {
  /** Before each file, and once at the end. Awaited, so the wizard can redraw and take a cancel. */
  progress?: (done: number, total: number, current?: PlannedMove) => void | Promise<void>;
  /** Checked between files. */
  cancelled?: () => boolean;
}

export interface MoveOutcome { move: PlannedMove; reason: string }

export interface MigrationResult {
  moved: PlannedMove[];
  skipped: MoveOutcome[];
  failed: MoveOutcome[];
  removedFolders: string[];
  cancelled: boolean;
  /** Moves not attempted because the run was cancelled. */
  remaining: number;
}

const reasonOf = (error: unknown): string => error instanceof Error && error.message ? error.message : 'Unknown error.';

/**
 * Carry out planned moves one file at a time. A file that vanished or whose target
 * appeared since the preview is skipped, never overwritten, and one failure does
 * not stop the rest. Afterwards the folders the move emptied are removed.
 */
export async function runMigration(moves: readonly PlannedMove[], baseFolder: string, adapter: MigrationAdapter,
  hooks: MigrationHooks = {}): Promise<MigrationResult> {
  const result: MigrationResult = { moved: [], skipped: [], failed: [], removedFolders: [], cancelled: false, remaining: 0 };
  let done = 0;
  for (const move of moves) {
    if (hooks.cancelled?.()) { result.cancelled = true; break; }
    await hooks.progress?.(done, moves.length, move);
    try {
      if (!await adapter.exists(move.from)) result.skipped.push({ move, reason: 'The file is no longer there.' });
      else if (await adapter.exists(move.to)) result.skipped.push({ move, reason: 'A file already exists at the new path.' });
      else {
        await adapter.move(move);
        result.moved.push(move);
        try { await adapter.record(move); }
        catch (error) { result.failed.push({ move, reason: `The file moved, but Event Notes could not update its records: ${reasonOf(error)}` }); }
      }
    } catch (error) { result.failed.push({ move, reason: reasonOf(error) }); }
    done++;
  }
  result.remaining = moves.length - done;
  await hooks.progress?.(done, moves.length);
  for (const folder of cleanupCandidates(result.moved, baseFolder)) {
    try {
      if (!await adapter.isEmptyFolder(folder)) continue;
      await adapter.removeFolder(folder);
      result.removedFolders.push(folder);
    } catch { /* a folder that cannot be removed simply stays */ }
  }
  return result;
}
