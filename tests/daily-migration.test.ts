import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDailyFormat, cleanupCandidates, dailyDateOf, dailyPathFor, DEFAULT_TARGET_FORMAT, findDailyNotes, migrationDefaults,
  planMigration, retargetState, runMigration, type FormatContext, type MigrationAdapter, type PlannedMove } from '../src/daily-migration';
import { eventNotePathIn } from '../src/paths';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { CalendarEvent } from '../src/types';

const ctx: FormatContext = { rules: { locale: 'en', weekMode: 'calendar', weekStart: 'locale' }, zone: 'Asia/Taipei' };
const QUARTERS = 'YYYY/[Q]Q/MM-DD/MMM DD';
const plan = (files: string[], from: string, to: string, more: Partial<Parameters<typeof planMigration>[0]> = {}) =>
  planMigration({ files, folder: 'Journal', from, to, ctx, ...more });
const pairs = (moves: PlannedMove[]) => moves.map(move => [move.from, move.to]);

test('the default target gives each day the folder YYYY/MM/MM-DD', () => {
  assert.equal(DEFAULT_TARGET_FORMAT, 'YYYY/MM/MM-DD/MMMM DD');
  assert.equal(dailyPathFor('2026-11-16', { folder: 'Journal', format: DEFAULT_TARGET_FORMAT }, ctx), 'Journal/2026/11/11-16/November 16.md');
  assert.equal(dailyPathFor('2026-11-16', { folder: '', format: DEFAULT_TARGET_FORMAT }, ctx), '2026/11/11-16/November 16.md');
});

test('a Daily Note is recognised by its full path, not its file name', () => {
  const layout = { folder: 'Journal', format: QUARTERS };
  assert.equal(dailyDateOf('Journal/2026/Q4/11-16/Nov 16.md', layout, ctx), '2026-11-16');
  // The file name has no year: the same name in another year is another day.
  assert.equal(dailyDateOf('Journal/2025/Q4/11-16/Nov 16.md', layout, ctx), '2025-11-16');
  // Compared the way the Vault compares paths: without case.
  assert.equal(dailyDateOf('journal/2026/Q4/11-16/nov 16.MD', layout, ctx), '2026-11-16');
  // Does not round-trip: November is not in Q1, the folder and the name disagree, or there is extra text.
  assert.equal(dailyDateOf('Journal/2026/Q1/11-16/Nov 16.md', layout, ctx), undefined);
  assert.equal(dailyDateOf('Journal/2026/Q4/11-16/Nov 17.md', layout, ctx), undefined);
  assert.equal(dailyDateOf('Journal/2026/Q4/11-16/Nov 16 draft.md', layout, ctx), undefined);
  assert.equal(dailyDateOf('Journal/2026/Q4/11-16/Nov 16.png', layout, ctx), undefined);
  assert.equal(dailyDateOf('Other/2026/Q4/11-16/Nov 16.md', layout, ctx), undefined);
  assert.equal(dailyDateOf('Journal/2026/Q4/02-30/Feb 30.md', layout, ctx), undefined);
  // The literal Q is not read as a quarter token, and a missing folder is not skipped over.
  assert.equal(dailyDateOf('Journal/2026/4/11-16/Nov 16.md', layout, ctx), undefined);
  assert.equal(dailyDateOf('Journal/2026/11-16/Nov 16.md', layout, ctx), undefined);
});

test('flat layouts, the Vault root and locale month names are recognised', () => {
  assert.equal(dailyDateOf('2026-11-16.md', { folder: '', format: 'YYYY-MM-DD' }, ctx), '2026-11-16');
  assert.equal(dailyDateOf('Notes/2026-11-16.md', { folder: '', format: 'YYYY-MM-DD' }, ctx), undefined);
  assert.equal(dailyDateOf('2026-11-16.md', { folder: 'Journal', format: 'YYYY-MM-DD' }, ctx), undefined);
  assert.equal(dailyDateOf('Journal/2026-13-01.md', { folder: 'Journal', format: 'YYYY-MM-DD' }, ctx), undefined);
  const taiwan: FormatContext = { ...ctx, rules: { ...ctx.rules, locale: 'zh-tw' } };
  const layout = { folder: 'Journal', format: 'YYYY/MMMM/Do' };
  const path = dailyPathFor('2026-11-06', layout, taiwan);
  assert.notEqual(path, dailyPathFor('2026-11-06', layout, ctx));
  assert.equal(dailyDateOf(path, layout, taiwan), '2026-11-06');
  // A note Obsidian named in its own language is found only when that locale is given too.
  assert.equal(dailyDateOf(path, layout, ctx), undefined);
  assert.equal(dailyDateOf(path, layout, { ...ctx, locales: ['zh-tw'] }), '2026-11-06');
  assert.deepEqual(findDailyNotes(['Journal/2026-11-16.md', 'Journal/Standup.md', 'Journal/2026-11-17.md'],
    { folder: 'Journal', format: 'YYYY-MM-DD' }, ctx), [
    { path: 'Journal/2026-11-16.md', date: '2026-11-16' }, { path: 'Journal/2026-11-17.md', date: '2026-11-17' }]);
});

test('a target format must keep the day, and warns when days share a folder', () => {
  const good = checkDailyFormat(DEFAULT_TARGET_FORMAT, ctx);
  assert.equal(good.error, undefined);
  assert.equal(good.warning, undefined);
  assert.equal(good.dayFolders, true);
  assert.equal(good.parseable, true);
  for (const format of ['YYYY/MM/MMMM', 'MM-DD', 'YYYY/[Q]Q/dddd', 'YYYY/MM/[note]']) {
    assert.match(checkDailyFormat(format, ctx).error ?? '', /same path/, format);
  }
  for (const format of ['', '   ', 'YYYY//DD', '../YYYY-MM-DD', 'YYYY-MM-DD/{title}', '[open']) {
    assert.ok(checkDailyFormat(format, ctx).error, format);
  }
  for (const format of ['YYYY-MM-DD', 'YYYY/MM/YYYY-MM-DD', '[Journal]/YYYY-MM-DD']) {
    const check = checkDailyFormat(format, ctx);
    assert.equal(check.error, undefined, format);
    assert.equal(check.dayFolders, false, format);
    assert.match(check.warning ?? '', /share a folder/, format);
  }
  assert.equal(checkDailyFormat(QUARTERS, ctx).dayFolders, true);
  assert.equal(checkDailyFormat('YYYY-MM-DD/YYYY-MM-DD', ctx).warning, undefined);
});

test('quarter folders are renamed to month folders exactly', () => {
  const files = [
    'Journal/2026/Q4/11-16/Nov 16.md', 'Journal/2026/Q1/01-05/Jan 05.md', 'Journal/2025/Q4/11-16/Nov 16.md',
    'Journal/2026/Q4/11-16/photo.png', 'Journal/2026/Q4/11-16/files/scan.pdf',
    'Journal/2026/Q4/Quarter review.md', 'Journal/Readme.md', 'Elsewhere/2026/Q4/11-16/Nov 16.md', 'Journal/2026/Q3/11-16/Nov 16.md',
  ];
  const result = plan(files, QUARTERS, DEFAULT_TARGET_FORMAT);
  assert.equal(result.found, 3);
  assert.deepEqual(pairs(result.moves.filter(move => move.kind === 'daily')), [
    ['Journal/2025/Q4/11-16/Nov 16.md', 'Journal/2025/11/11-16/November 16.md'],
    ['Journal/2026/Q1/01-05/Jan 05.md', 'Journal/2026/01/01-05/January 05.md'],
    ['Journal/2026/Q4/11-16/Nov 16.md', 'Journal/2026/11/11-16/November 16.md'],
  ]);
  // The old layout had one folder per day, so the rest of that folder can follow.
  assert.deepEqual(pairs(result.moves.filter(move => move.kind === 'extra')), [
    ['Journal/2026/Q4/11-16/files/scan.pdf', 'Journal/2026/11/11-16/files/scan.pdf'],
    ['Journal/2026/Q4/11-16/photo.png', 'Journal/2026/11/11-16/photo.png'],
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.left, []);
  // A day's Daily Note moves last, so a cancelled run leaves it findable by the old format.
  assert.deepEqual(result.moves.filter(move => move.date === '2026-11-16').map(move => move.kind), ['extra', 'extra', 'daily']);
  const kept = plan(files, QUARTERS, DEFAULT_TARGET_FORMAT, { options: { moveExtras: false } });
  assert.deepEqual(kept.moves.map(move => move.kind), ['daily', 'daily', 'daily']);
  assert.deepEqual(kept.left, ['Journal/2026/Q4/11-16/files/scan.pdf', 'Journal/2026/Q4/11-16/photo.png']);
  assert.equal(kept.extras, 2);
});

test('a flat layout moves into day folders and leaves its neighbours in place', () => {
  const files = ['Journal/2026-11-16.md', 'Journal/2026-11-17.md', 'Journal/Standup.md', 'Journal/photo.png', 'Journal/sub/deep.md', 'Other.md'];
  const result = plan(files, 'YYYY-MM-DD', DEFAULT_TARGET_FORMAT);
  assert.deepEqual(pairs(result.moves), [
    ['Journal/2026-11-16.md', 'Journal/2026/11/11-16/November 16.md'],
    ['Journal/2026-11-17.md', 'Journal/2026/11/11-17/November 17.md'],
  ]);
  // Nothing says which day these belong to.
  assert.deepEqual(result.left, ['Journal/photo.png', 'Journal/Standup.md']);
  assert.equal(result.extras, 0);
  // Base folder at the Vault root.
  const root = planMigration({ files: ['2026-11-16.md', 'Inbox.md', 'Journal/2026-11-17.md'], folder: '', from: 'YYYY-MM-DD', to: DEFAULT_TARGET_FORMAT, ctx });
  assert.deepEqual(pairs(root.moves), [['2026-11-16.md', '2026/11/11-16/November 16.md']]);
  assert.deepEqual(root.left, ['Inbox.md']);
});

test('conflicts are skipped and shown, never overwritten', () => {
  const exists = plan(['Journal/2026-11-16.md', 'Journal/2026/11/11-16/November 16.md', 'Journal/2026-11-17.md'], 'YYYY-MM-DD', DEFAULT_TARGET_FORMAT);
  assert.deepEqual(pairs(exists.moves), [['Journal/2026-11-17.md', 'Journal/2026/11/11-17/November 17.md']]);
  assert.deepEqual(exists.conflicts.map(conflict => [conflict.from, conflict.to, conflict.reason]),
    [['Journal/2026-11-16.md', 'Journal/2026/11/11-16/November 16.md', 'target-exists']]);
  // The same target compared the way the Vault does: without case.
  const cased = plan(['Journal/2026-11-16.md', 'journal/2026/11/11-16/november 16.md'], 'YYYY-MM-DD', DEFAULT_TARGET_FORMAT);
  assert.equal(cased.conflicts[0]?.reason, 'target-exists');
  // Two sources for one target, as two files differing only by case on a case-sensitive disk.
  const twins = plan(['Journal/2026/Q4/11-16/Nov 16.md', 'Journal/2026/Q4/11-16/nov 16.md'], QUARTERS, DEFAULT_TARGET_FORMAT);
  assert.deepEqual(twins.moves, []);
  assert.deepEqual(twins.conflicts.map(conflict => conflict.reason), ['same-target', 'same-target']);
  // Swapping day and month: a note that fits both formats may already have been moved.
  const swap = plan(['Journal/01-02-2026.md', 'Journal/25-12-2026.md'], 'DD-MM-YYYY', 'MM-DD-YYYY');
  assert.deepEqual(pairs(swap.moves), [['Journal/25-12-2026.md', 'Journal/12-25-2026.md']]);
  assert.deepEqual(swap.conflicts.map(conflict => [conflict.from, conflict.reason]), [['Journal/01-02-2026.md', 'ambiguous']]);
  assert.equal(swap.ambiguous, 1);
  const forced = plan(['Journal/01-02-2026.md', 'Journal/02-01-2026.md'], 'DD-MM-YYYY', 'MM-DD-YYYY', { options: { includeAmbiguous: true } });
  // Each target is held by a note that is itself moving; neither is overwritten.
  assert.deepEqual(forced.moves, []);
  assert.deepEqual(forced.conflicts.map(conflict => conflict.reason), ['target-moving', 'target-moving']);
});

test('running again after a partial move finishes the rest', () => {
  const files = ['Journal/2026/11/11-16/November 16.md', 'Journal/2026/11/11-16/photo.png', 'Journal/2026/Q4/11-17/Nov 17.md', 'Journal/2026/Q4/11-17/photo.png'];
  const result = plan(files, QUARTERS, DEFAULT_TARGET_FORMAT);
  assert.equal(result.found, 1);
  assert.deepEqual(pairs(result.moves), [
    ['Journal/2026/Q4/11-17/photo.png', 'Journal/2026/11/11-17/photo.png'],
    ['Journal/2026/Q4/11-17/Nov 17.md', 'Journal/2026/11/11-17/November 17.md'],
  ]);
  assert.deepEqual(result.conflicts, []);
  // Same format on both sides: nothing to do.
  const same = plan(files, DEFAULT_TARGET_FORMAT, DEFAULT_TARGET_FORMAT);
  assert.equal(same.found, 1);
  assert.equal(same.unchanged, 1);
  assert.deepEqual(same.moves, []);
});

test('tracked Event Notes follow the pattern to the new day folder', () => {
  const event: CalendarEvent = { id: 'local|a', sourceId: 'local', uid: 'a', title: 'Standup',
    start: '2026-11-16T09:00:00+08:00', end: '2026-11-16T09:30:00+08:00', allDay: false };
  const settings = { ...DEFAULT_SETTINGS, eventPattern: '{daily}/[Events]/{title}' };
  const patternPath = (dailyFolder: (date: string) => string) => eventNotePathIn(event, 'Local', settings, dailyFolder);
  const files = ['Journal/2026/Q4/11-16/Nov 16.md', 'Journal/2026/Q4/11-16/Events/Standup.md', 'Journal/2026/Q4/11-16/Events/Renamed.md',
    'Projects/Moved by hand.md', 'Journal/2026/Q4/11-16/Untracked.md'];
  const tracked = [
    { id: 'local|a', path: 'Journal/2026/Q4/11-16/Events/Standup.md', dailyPath: 'Journal/2026/Q4/11-16/Nov 16.md', date: '2026-11-16', patternPath },
    // Renamed by the user but still in the pattern's folder: keeps its name.
    { id: 'local|b', path: 'Journal/2026/Q4/11-16/Events/Renamed.md', dailyPath: 'Journal/2026/Q4/11-16/Nov 16.md', date: '2026-11-16', patternPath },
    { id: 'local|c', path: 'Projects/Moved by hand.md', dailyPath: 'Journal/2026/Q4/11-16/Nov 16.md', date: '2026-11-16', patternPath },
    { id: 'local|gone', path: 'Journal/2026/Q4/11-16/Events/Deleted.md', dailyPath: 'Journal/2026/Q4/11-16/Nov 16.md', date: '2026-11-16', patternPath },
  ];
  const result = plan(files, QUARTERS, DEFAULT_TARGET_FORMAT, { tracked });
  assert.deepEqual(result.moves.map(move => [move.kind, move.from, move.to, move.eventId]), [
    ['event', 'Journal/2026/Q4/11-16/Events/Renamed.md', 'Journal/2026/11/11-16/Events/Renamed.md', 'local|b'],
    ['event', 'Journal/2026/Q4/11-16/Events/Standup.md', 'Journal/2026/11/11-16/Events/Standup.md', 'local|a'],
    ['extra', 'Journal/2026/Q4/11-16/Untracked.md', 'Journal/2026/11/11-16/Untracked.md', undefined],
    ['daily', 'Journal/2026/Q4/11-16/Nov 16.md', 'Journal/2026/11/11-16/November 16.md', undefined],
  ]);
  assert.equal(result.eventNotes, 2);
  // Left on request: Event Notes are not then moved as ordinary files of the folder either.
  const kept = plan(files, QUARTERS, DEFAULT_TARGET_FORMAT, { tracked, options: { moveEvents: false } });
  assert.deepEqual(kept.moves.map(move => move.kind), ['extra', 'daily']);
  assert.deepEqual(kept.left, ['Journal/2026/Q4/11-16/Events/Renamed.md', 'Journal/2026/Q4/11-16/Events/Standup.md']);
  // After a partial run the Daily Note is already at its new path; its Event Notes still follow.
  const later = plan(['Journal/2026/11/11-16/November 16.md', 'Journal/2026/Q4/11-16/Events/Standup.md'], QUARTERS, DEFAULT_TARGET_FORMAT,
    { tracked: [{ id: 'local|a', path: 'Journal/2026/Q4/11-16/Events/Standup.md', dailyPath: 'Journal/2026/11/11-16/November 16.md' }] });
  assert.deepEqual(later.moves.map(move => [move.kind, move.from, move.to]),
    [['event', 'Journal/2026/Q4/11-16/Events/Standup.md', 'Journal/2026/11/11-16/Events/Standup.md']]);
  // Without the event itself, a note directly beside a flat Daily Note still follows it.
  const flat = plan(['Journal/2026-11-16.md', 'Journal/Standup.md', 'Journal/Sub/Other.md'], 'YYYY-MM-DD', DEFAULT_TARGET_FORMAT, { tracked: [
    { id: 'x|1', path: 'Journal/Standup.md', dailyPath: 'Journal/2026-11-16.md' },
    { id: 'x|2', path: 'Journal/Sub/Other.md', dailyPath: 'Journal/2026-11-16.md' },
  ] });
  assert.deepEqual(flat.moves.map(move => [move.kind, move.from, move.to]), [
    ['event', 'Journal/Standup.md', 'Journal/2026/11/11-16/Standup.md'],
    ['daily', 'Journal/2026-11-16.md', 'Journal/2026/11/11-16/November 16.md'],
  ]);
});

test('only folders the move emptied are candidates for removal, deepest first, never the base folder', () => {
  const moved: PlannedMove[] = [
    { kind: 'daily', from: 'Journal/2026/Q4/11-16/Nov 16.md', to: 'Journal/2026/11/11-16/November 16.md', date: '2026-11-16' },
    { kind: 'extra', from: 'Journal/2026/Q4/11-16/files/scan.pdf', to: 'Journal/2026/11/11-16/files/scan.pdf', date: '2026-11-16' },
    { kind: 'event', from: 'Calendar Notes/Standup.md', to: 'Calendar Notes/2026/Standup.md', date: '2026-11-16', eventId: 'a' },
  ];
  assert.deepEqual(cleanupCandidates(moved, 'Journal'),
    ['Journal/2026/Q4/11-16/files', 'Journal/2026/Q4/11-16', 'Journal/2026/Q4', 'Journal/2026']);
  assert.deepEqual(cleanupCandidates([{ kind: 'daily', from: 'Journal/2026-11-16.md', to: 'Journal/2026/11/11-16/November 16.md', date: '2026-11-16' }], 'Journal'), []);
  assert.deepEqual(cleanupCandidates([{ kind: 'daily', from: '2026/11-16.md', to: '2026/11/16.md', date: '2026-11-16' }], ''), ['2026']);
});

test('tracked paths follow the moved notes', () => {
  const state = {
    noteLinks: {
      a: { eventPath: 'Journal/Standup.md', dailyPath: 'journal/2026-11-16.md', bullet: '- x' },
      b: { eventPath: 'Journal/Other.md', dailyPath: 'Journal/2026-11-17.md', bullet: '- y' },
    },
    pathTypes: { 'journal/2026-11-16.md': { type: 'daily' as const }, 'journal/standup.md': { type: 'event' as const, ownerId: 'a' } },
    history: [{ id: 'h', eventId: 'a', sourceId: 's', sourceName: 'S', title: 'Standup', detectedAt: '', status: 'applied' as const, acceptedRevision: 1,
      notePath: 'Journal/Standup.md', beforeDailyPath: 'Journal/2026-11-16.md', afterDailyPath: 'Journal/2026-11-16.md' }],
  };
  const changed = retargetState(state, [
    { kind: 'daily', from: 'Journal/2026-11-16.md', to: 'Journal/2026/11/11-16/November 16.md' },
    { kind: 'event', from: 'Journal/Standup.md', to: 'Journal/2026/11/11-16/Standup.md' },
  ]);
  assert.ok(changed > 0);
  assert.equal(state.noteLinks.a.dailyPath, 'Journal/2026/11/11-16/November 16.md');
  assert.equal(state.noteLinks.b.dailyPath, 'Journal/2026-11-17.md');
  // The Event Note's own link is settled by the rename handler, which also rewrites its Daily entry.
  assert.equal(state.noteLinks.a.eventPath, 'Journal/Standup.md');
  assert.deepEqual(state.pathTypes, { 'journal/2026/11/11-16/november 16.md': { type: 'daily' }, 'journal/standup.md': { type: 'event', ownerId: 'a' } });
  assert.equal(state.history[0].notePath, 'Journal/2026/11/11-16/Standup.md');
  assert.equal(state.history[0].beforeDailyPath, 'Journal/2026/11/11-16/November 16.md');
  assert.equal(state.history[0].afterDailyPath, 'Journal/2026/11/11-16/November 16.md');
  assert.equal(retargetState(state, [{ kind: 'daily', from: 'Journal/2026-11-16.md', to: 'Journal/2026/11/11-16/November 16.md' }]), 0);
});

test('the wizard starts from the remembered format after a partial run', () => {
  assert.deepEqual(migrationDefaults('YYYY-MM-DD', ''), { from: 'YYYY-MM-DD', to: DEFAULT_TARGET_FORMAT });
  // The format was already changed; the notes left behind are still in the earlier one.
  assert.deepEqual(migrationDefaults('YYYY/MM/MM-DD/MMMM DD', QUARTERS), { from: QUARTERS, to: 'YYYY/MM/MM-DD/MMMM DD' });
  assert.deepEqual(migrationDefaults('YYYY/MM/DD', QUARTERS), { from: QUARTERS, to: 'YYYY/MM/DD' });
  assert.deepEqual(migrationDefaults(QUARTERS, QUARTERS), { from: QUARTERS, to: DEFAULT_TARGET_FORMAT });
});

/** An in-memory Vault: files are paths, folders exist while something is in them or they were made. */
function fakeVault(paths: string[]) {
  const files = new Set(paths);
  const folders = new Set<string>();
  const parents = (path: string) => path.split('/').slice(0, -1).map((_part, index, parts) => parts.slice(0, index + 1).join('/'));
  for (const path of paths) for (const folder of parents(path)) folders.add(folder);
  const recorded: PlannedMove[] = [];
  const failing = new Set<string>();
  const adapter: MigrationAdapter = {
    exists: async path => files.has(path) || folders.has(path),
    move: async move => {
      if (failing.has(move.from)) throw new Error('disk says no');
      files.delete(move.from); files.add(move.to);
      for (const folder of parents(move.to)) folders.add(folder);
    },
    record: async move => { recorded.push(move); },
    isEmptyFolder: async path => folders.has(path) && ![...files, ...folders].some(other => other.startsWith(`${path}/`)),
    removeFolder: async path => { folders.delete(path); },
  };
  return { files, folders, recorded, failing, adapter };
}

test('the move skips what changed, reports failures, and removes only emptied folders', async () => {
  const files = ['Journal/2026/Q4/11-16/Nov 16.md', 'Journal/2026/Q4/11-17/Nov 17.md', 'Journal/2026/Q4/11-17/keep.png',
    'Journal/2026/Q4/11-18/Nov 18.md', 'Journal/2026/Q3/09-01/Sep 01.md', 'Journal/2026/Q3/09-02/Sep 02.md'];
  const vault = fakeVault(files);
  const { moves } = plan(files, QUARTERS, DEFAULT_TARGET_FORMAT, { options: { moveExtras: false } });
  // After the preview: one target appeared, one source vanished, one move fails.
  vault.files.add('Journal/2026/11/11-18/November 18.md');
  vault.files.delete('Journal/2026/Q3/09-01/Sep 01.md');
  vault.failing.add('Journal/2026/Q3/09-02/Sep 02.md');
  const seen: number[] = [];
  const result = await runMigration(moves, 'Journal', vault.adapter, { progress: done => { seen.push(done); } });
  assert.deepEqual(pairs(result.moved), [
    ['Journal/2026/Q4/11-16/Nov 16.md', 'Journal/2026/11/11-16/November 16.md'],
    ['Journal/2026/Q4/11-17/Nov 17.md', 'Journal/2026/11/11-17/November 17.md'],
  ]);
  assert.deepEqual(vault.recorded, result.moved);
  assert.deepEqual(result.skipped.map(item => [item.move.from, item.reason]), [
    ['Journal/2026/Q3/09-01/Sep 01.md', 'The file is no longer there.'],
    ['Journal/2026/Q4/11-18/Nov 18.md', 'A file already exists at the new path.'],
  ]);
  assert.deepEqual(result.failed.map(item => [item.move.from, item.reason]), [['Journal/2026/Q3/09-02/Sep 02.md', 'disk says no']]);
  assert.equal(result.cancelled, false);
  assert.equal(result.remaining, 0);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
  // 11-16 is empty; 11-17 keeps its picture; Q4 and 2026 still hold other things.
  assert.deepEqual(result.removedFolders, ['Journal/2026/Q4/11-16']);
  assert.ok(vault.folders.has('Journal/2026/Q4/11-17'));
  assert.ok(vault.files.has('Journal/2026/Q4/11-18/Nov 18.md'));
});

test('a cancelled move stops between files and a second run finishes it', async () => {
  const files = ['Journal/2026/Q4/11-16/Nov 16.md', 'Journal/2026/Q4/11-17/Nov 17.md', 'Journal/2026/Q4/11-18/Nov 18.md'];
  const vault = fakeVault(files);
  const first = plan(files, QUARTERS, DEFAULT_TARGET_FORMAT);
  const stopped = await runMigration(first.moves, 'Journal', vault.adapter, { cancelled: () => vault.recorded.length >= 1 });
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.moved.length, 1);
  assert.equal(stopped.remaining, 2);
  assert.deepEqual(stopped.removedFolders, ['Journal/2026/Q4/11-16']);
  const second = plan([...vault.files], QUARTERS, DEFAULT_TARGET_FORMAT);
  assert.equal(second.found, 2);
  const finished = await runMigration(second.moves, 'Journal', vault.adapter);
  assert.equal(finished.moved.length, 2);
  assert.equal(finished.remaining, 0);
  assert.deepEqual([...vault.files].sort(), ['Journal/2026/11/11-16/November 16.md', 'Journal/2026/11/11-17/November 17.md', 'Journal/2026/11/11-18/November 18.md']);
  // Every quarter folder is gone; the base folder and the new folders stay.
  assert.deepEqual([...vault.folders].sort(), ['Journal', 'Journal/2026', 'Journal/2026/11', 'Journal/2026/11/11-16', 'Journal/2026/11/11-17', 'Journal/2026/11/11-18']);
  assert.equal((await runMigration(plan([...vault.files], QUARTERS, DEFAULT_TARGET_FORMAT).moves, 'Journal', vault.adapter)).moved.length, 0);
});
