import assert from 'node:assert/strict';
import test from 'node:test';
import { EventNoteService } from '../src/events';
import { CalendarStore, type RecoveryJournal, type StoreIO } from '../src/store';
import { freshState } from '../src/state';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { App } from 'obsidian';
import { addEventBullet, detachEventFrontmatter, managedEventKeys, newEventNote, noteBody, parseEventNote, removeDuplicateEventNoteTitle, validateInterval, validateSourceInterval, writeEventFrontmatter } from '../src/notes';
import { emptySourceCache } from '../src/history';
import { sourceEventId } from '../src/ical';
import type { CalendarEvent } from '../src/types';
import { SourceSyncService } from '../src/sync';

class FakeVault implements StoreIO {
  files = new Map<string, string>();
  data: ReturnType<typeof freshState> | null = null;
  journal: RecoveryJournal | null = null;
  failAt: 'write' | 'write-after' | 'save' | 'save-after' | 'clear' | null = null;
  writeNumber = 0;
  async read(path: string) { return this.files.get(path) ?? null; }
  async listMarkdown() { return [...this.files.keys()].filter(path => path.endsWith('.md')); }
  async write(path: string, before: string | null, after: string | null) {
    assert.equal(await this.read(path), before);
    this.writeNumber++;
    if (this.failAt === 'write' && this.writeNumber === 2) throw new Error('write failed');
    if (after === null) this.files.delete(path); else this.files.set(path, after);
    if (this.failAt === 'write-after' && this.writeNumber === 2) throw new Error('write failed after mutation');
  }
  async loadData() { return this.data ? structuredClone(this.data) : null; }
  async saveData(state: ReturnType<typeof freshState>) {
    if (this.failAt === 'save') throw new Error('save failed');
    this.data = structuredClone(state);
    if (this.failAt === 'save-after') throw new Error('save failed after persistence');
  }
  async loadJournal() { return this.journal ? structuredClone(this.journal) : null; }
  async saveJournal(journal: RecoveryJournal) { this.journal = structuredClone(journal); }
  async clearJournal() { if (this.failAt === 'clear') throw new Error('clear failed'); this.journal = null; }
}

function setup(io = new FakeVault()) {
  // These tests assert paths under a flat folder; the default {daily}/{title} is covered in providers-paths.
  const settings = { ...DEFAULT_SETTINGS, eventPattern: '[Calendar Notes]/{title}' };
  const store = new CalendarStore(io, freshState(settings));
  const opened: string[] = [];
  const trashed: string[] = [];
  const revealed: unknown[] = [];
  let service: EventNoteService;
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => io.files.has(path) ? { path, extension: 'md' } : null,
      createFolder: async () => undefined,
    },
    workspace: {
      getLeaf: () => ({ openFile: async (file: { path: string }) => { opened.push(file.path); } }),
      revealLeaf: async (leaf: unknown) => { revealed.push(leaf); },
    },
    fileManager: {
      trashFile: async (file: { path: string }) => { trashed.push(file.path); io.files.delete(file.path); },
      // As in the plugin: the Vault rename event, then the completed link update.
      renameFile: async (file: { path: string }, newPath: string) => {
        if (io.files.has(newPath)) throw new Error('Destination file already exists!');
        io.files.set(newPath, io.files.get(file.path)!);
        io.files.delete(file.path);
        await service.handleRename({ path: newPath, extension: 'md' } as never, file.path);
        await service.finalizePendingRenames(newPath);
      },
    },
  } as unknown as App;
  service = new EventNoteService(app, store);
  return { io, store, service, opened, trashed, revealed };
}

const start = '2026-10-22T10:00:00+08:00';
const end = '2026-10-22T11:00:00+08:00';
const imported = (): CalendarEvent => ({ id: sourceEventId('work', 'uid-1'), sourceId: 'work', uid: 'uid-1',
  title: 'Imported', start, end, allDay: false, status: 'active' });

test('local event creation immediately links its past Daily Note; later clicks deduplicate', async () => {
  const { io, service, store, opened } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  assert.equal((await service.indexLocal()).length, 1);
  assert.equal(io.files.size, 2);
  const link = store.state.noteLinks[event.id];
  assert.match(link.dailyPath, /2026-10-22/);
  assert.equal(io.files.get(link.dailyPath)!.startsWith('## Journal\n'), true);
  assert.doesNotMatch(io.files.get(link.dailyPath)!, /^# 2026-10-22/m);
  assert.doesNotMatch(io.files.get(link.eventPath)!, /^# Roadmap/m);
  assert.equal(io.files.get(link.dailyPath)!.split('[[Calendar Notes/Roadmap').length - 1, 1);
  await Promise.all([service.openEvent(event), service.openEvent(event)]);
  assert.equal(io.files.size, 2);
  assert.equal(io.files.get(link.dailyPath)!.split('[[Calendar Notes/Roadmap').length - 1, 1);
  assert.equal(opened.length, 2);
});

test('Daily link failure retains the created Event Note with a clear partial error', async () => {
  const { io, service, store } = setup();
  io.failAt = 'write';
  await assert.rejects(service.createLocal({ title: 'Partial', start, end }), /Event Note was created.*Daily Note link could not be added/);
  assert.equal(io.files.size, 1);
  assert.match([...io.files.values()][0], /event_id: "local\|/);
  assert.equal(Object.keys(store.state.noteLinks).length, 0);
  io.failAt = null;
  const event = (await service.scanEvents())[0];
  assert.equal(event.title, 'Partial');
  await service.openEvent(event);
  assert.equal(io.files.size, 2);
  assert.ok(store.state.noteLinks[event.id]);
});

test('first opening an imported event preflights a path collision without creating an orphan note', async () => {
  const { io, service, store } = setup();
  store.state.settings.eventPattern = '[Daily Notes]/YYYY-MM-DD';
  const event = imported();
  await assert.rejects(service.openEvent(event), /Event and Daily Note paths conflict/);
  assert.equal(io.files.size, 0);
  assert.equal(Object.keys(store.state.noteLinks).length, 0);
  assert.equal(Object.keys(store.state.pathTypes).length, 0);
});

test('rescheduling an unlinked imported cache event creates its note and Daily link with a local override', async () => {
  const { io, service, store } = setup();
  const event = imported();
  const cache = emptySourceCache();
  cache.accepted[event.id] = { event, revision: 0 };
  store.state.sourceCaches.work = cache;
  const updated = await service.reschedule(event, { start: '2026-10-23T14:00:00+08:00', end: '2026-10-23T15:00:00+08:00' });
  const link = store.state.noteLinks[event.id];
  assert.equal(updated.id, event.id);
  assert.equal(io.files.size, 2);
  assert.match(io.files.get(link.eventPath)!, /source: "work"[\s\S]*ical_uid: "uid-1"/);
  assert.match(io.files.get(link.dailyPath)!, /14:00–15:00/);
  assert.match(link.dailyPath, /2026-10-23/);
  assert.equal(store.state.overrides[event.id].start, updated.start);
  assert.equal(store.state.sourceCaches.work.accepted[event.id].event.start, start);
});

test('imported point Event Note survives reopening, restart, rescan, and a source move', async () => {
  const { io, service, store } = setup();
  const source = { id: 'work', name: 'Work', url: 'https://example.test/feed', color: '#888', enabled: true };
  store.state.settings.sources.push(source);
  const at = '2026-10-22T10:00:00+08:00';
  const event = { ...imported(), start: at, end: at };
  const cache = emptySourceCache();
  cache.accepted[event.id] = { event, revision: 0 };
  store.state.sourceCaches.work = cache;
  const path = await service.openEvent(event);
  const original = store.state.noteLinks[event.id];
  assert.match(original.bullet, /^- 10:00 \[\[/);
  assert.doesNotMatch(original.bullet, /10:00–10:00/);
  assert.throws(() => parseEventNote(io.files.get(path)!.replace('ical_uid: "uid-1"\n', ''), path), /15 minutes/);
  io.files.set(path, io.files.get(path)!.replace('\n---\n', '\nmy_field: retained\n---\n') + '\nMy meeting notes.\n');
  await service.openEvent(event);
  assert.deepEqual([parseEventNote(io.files.get(path)!, path)?.start, parseEventNote(io.files.get(path)!, path)?.end], [at, at]);
  assert.equal((await service.scanEvents()).find(item => item.id === event.id)?.end, at);
  assert.equal(store.state.overrides[event.id], undefined);

  const restarted = setup(io);
  await restarted.store.recover();
  assert.equal((await restarted.service.scanEvents()).find(item => item.id === event.id)?.start, at);
  assert.equal(restarted.store.state.overrides[event.id], undefined);
  const movedAt = '2026-10-23T09:30:00+08:00';
  await new SourceSyncService(restarted.store, restarted.service).accept(source,
    [{ ...event, start: movedAt, end: movedAt }], { start: '2026-10-20T00:00:00Z', end: '2026-10-26T00:00:00Z' });
  const moved = restarted.store.state.noteLinks[event.id];
  assert.match(moved.dailyPath, /2026-10-23\.md$/);
  assert.match(moved.bullet, /^- 09:30 \[\[/);
  assert.doesNotMatch(io.files.get(original.dailyPath)!, /\[\[Calendar Notes\/Imported/);
  assert.match(io.files.get(moved.dailyPath)!, /09:30 \[\[Calendar Notes\/Imported/);
  assert.match(io.files.get(path)!, /my_field: retained[\s\S]*My meeting notes\./);
  assert.deepEqual([parseEventNote(io.files.get(path)!, path)?.start, parseEventNote(io.files.get(path)!, path)?.end],
    [movedAt, movedAt]);
  assert.equal(restarted.store.state.overrides[event.id], undefined);
});

test('imported short source interval is kept while manual short changes are rejected', async () => {
  const { io, service, store } = setup();
  const short = { ...imported(), start: '2026-10-22T10:00:00+08:00', end: '2026-10-22T10:05:00+08:00' };
  const cache = emptySourceCache();
  cache.accepted[short.id] = { event: short, revision: 0 };
  store.state.sourceCaches.work = cache;
  const path = await service.openEvent(short);
  assert.equal(parseEventNote(io.files.get(path)!, path)?.end, short.end);
  assert.equal((await service.scanEvents()).find(item => item.id === short.id)?.end, short.end);
  await assert.rejects(service.reschedule(short, { start: short.start, end: short.start }), /15 minutes/);
  await assert.rejects(service.createLocal({ title: 'Too short', start: short.start, end: short.end }), /15 minutes/);
  io.files.set(path, io.files.get(path)!.replace(short.end, '2026-10-22T10:06:00+08:00'));
  await service.scanEvents();
  assert.match(service.diagnostics.join(' '), /15 minutes/);
  assert.equal(store.state.overrides[short.id], undefined);
});

for (const allDay of [false, true]) {
  test(`${allDay ? 'all-day date' : 'timed instant'} offset changes do not invent an imported override`, async () => {
    const { io, service, store } = setup();
    const source = { id: 'work', name: 'Work', url: 'https://example.test/feed', color: '#888', enabled: true };
    store.state.settings.sources.push(source);
    const original: CalendarEvent = { ...imported(), allDay,
      start: allDay ? '2026-10-23T00:00:00+08:00' : start,
      end: allDay ? '2026-10-24T00:00:00+08:00' : end };
    const cache = emptySourceCache();
    cache.accepted[original.id] = { event: original, revision: 0 };
    store.state.sourceCaches.work = cache;
    await service.openEvent(original);
    store.state.settings.timeZone = 'America/New_York';
    const equivalent = { ...original,
      start: allDay ? '2026-10-23T00:00:00-04:00' : '2026-10-22T22:00:00-04:00',
      end: allDay ? '2026-10-24T00:00:00-04:00' : '2026-10-22T23:00:00-04:00' };
    const sync = new SourceSyncService(store, service);
    const range = { start: '2026-10-20T00:00:00Z', end: '2026-10-30T00:00:00Z' };
    await sync.accept(source, [equivalent], range);
    await service.scanEvents();
    assert.equal(store.state.overrides[original.id], undefined);
    const changed = { ...equivalent,
      start: allDay ? '2026-10-24T00:00:00-04:00' : '2026-10-23T22:00:00-04:00',
      end: allDay ? '2026-10-25T00:00:00-04:00' : '2026-10-23T23:00:00-04:00' };
    await sync.accept(source, [changed], range);
    assert.equal(store.state.history.at(-1)?.status, 'applied');
    assert.equal(store.state.noteLinks[original.id].dailyPath.endsWith(allDay ? '2026-10-24.md' : '2026-10-23.md'), true);
    assert.match(io.files.get(store.state.noteLinks[original.id].eventPath)!, new RegExp(changed.start));
  });
}

test('all-day events keep their written calendar date after a display-zone change and reschedule', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'All day', start: '2026-10-23T00:00:00+08:00',
    end: '2026-10-24T00:00:00+08:00', allDay: true });
  const original = store.state.noteLinks[event.id];
  assert.match(original.dailyPath, /2026-10-23\.md$/);
  store.state.settings.timeZone = 'America/New_York';
  await service.openEvent(event);
  assert.equal(store.state.noteLinks[event.id].dailyPath, original.dailyPath);
  assert.equal(io.files.get(original.dailyPath)!.split('[[Calendar Notes/All day').length - 1, 1);
  const moved = await service.reschedule(event, { start: '2026-10-24T00:00:00+08:00',
    end: '2026-10-25T00:00:00+08:00', allDay: true });
  assert.match(store.state.noteLinks[event.id].dailyPath, /2026-10-24\.md$/);
  await service.openEvent(moved);
  assert.match(store.state.noteLinks[event.id].dailyPath, /2026-10-24\.md$/);
  assert.doesNotMatch(io.files.get(original.dailyPath)!, /\[\[Calendar Notes\/All day/);
});

test('timestamp validation rejects normalized impossible dates and short intervals but permits cross-day', () => {
  assert.throws(() => validateInterval('2026-02-30T10:00:00+08:00', '2026-02-30T11:00:00+08:00'), /15 minutes/);
  assert.throws(() => validateInterval('2026-10-23T10:00:00+08:00', '2026-10-23T10:14:00+08:00'), /15 minutes/);
  assert.doesNotThrow(() => validateInterval('2026-10-23T23:00:00+08:00', '2026-10-24T02:00:00+08:00'));
  assert.doesNotThrow(() => validateSourceInterval(start, start));
  assert.throws(() => validateSourceInterval(end, start), /cannot end before/);
  assert.throws(() => validateSourceInterval('2026-10-23T00:00:00+08:00', '2026-10-23T00:00:00+08:00', true), /exclusive end/);
  assert.throws(() => validateSourceInterval('2026-10-23T09:00:00+08:00', '2026-10-24T00:00:00+08:00', true), /midnight/);
});

test('local note properties remain compact and an edited body survives a cross-date move', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Review', start, end });
  await service.openEvent(event);
  const old = store.state.noteLinks[event.id];
  io.files.set(old.eventPath, io.files.get(old.eventPath)!.replace('\n---\n', '\ncustom: true\n---\n') + '\nMy notes.\n');
  io.files.set(old.dailyPath, io.files.get(old.dailyPath)!.replace('## Journal', '## Journal\n\nHandwritten entry'));
  await service.reschedule(event, { start: '2026-10-23T12:00:00+08:00', end: '2026-10-23T13:00:00+08:00' });
  const link = store.state.noteLinks[event.id];
  assert.equal(link.eventPath, old.eventPath);
  assert.notEqual(link.dailyPath, old.dailyPath);
  assert.match(io.files.get(link.eventPath)!, /custom: true[\s\S]*My notes/);
  assert.match(io.files.get(old.dailyPath)!, /Handwritten entry/);
  assert.doesNotMatch(io.files.get(old.dailyPath)!, /\[\[Calendar Notes\/Review/);
  assert.match(io.files.get(link.dailyPath)!, /\[\[Calendar Notes\/Review/);
});

test('moving an event whose entry the user rewrote keeps their text and adds a fresh entry', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'One', start, end });
  await service.openEvent(event);
  const link = store.state.noteLinks[event.id];
  io.files.set(link.dailyPath, io.files.get(link.dailyPath)!.replace(link.bullet, '- My edited entry'));
  await service.reschedule(event, { start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00' });
  const moved = store.state.noteLinks[event.id];
  assert.match(io.files.get(link.eventPath)!, /2026-10-23T10:00:00/);
  assert.match(io.files.get(link.dailyPath)!, /- My edited entry/);
  assert.notEqual(moved.dailyPath, link.dailyPath);
  assert.equal(io.files.get(moved.dailyPath)!.split(moved.bullet).length - 1, 1);
});

test('saving the same times from the details dialog restores a removed entry', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'One', start, end });
  const link = store.state.noteLinks[event.id];
  io.files.set(link.dailyPath, io.files.get(link.dailyPath)!.replace(`${link.bullet}\n`, ''));
  await service.reschedule(event, { start, end });
  assert.equal(io.files.get(link.dailyPath)!.split(link.bullet).length - 1, 1);
});

test('different titles that normalize to the same path receive distinct files', async () => {
  const { service, store } = setup();
  const one = await service.createLocal({ title: 'A/B', start, end });
  const two = await service.createLocal({ title: 'A:B', start, end });
  await service.openEvent(one);
  await service.openEvent(two);
  assert.notEqual(store.state.noteLinks[one.id].eventPath, store.state.noteLinks[two.id].eventPath);
  assert.match(store.state.noteLinks[two.id].eventPath, /\(2\)\.md$/);
});

test('failure on second file write restores both files and state', async () => {
  const { io, store } = setup();
  io.failAt = 'write-after';
  await assert.rejects(store.commit([
    { path: 'A.md', before: null, after: 'A', type: 'daily' },
    { path: 'B.md', before: null, after: 'B', type: 'weekly' },
  ], state => { state.pathTypes.test = { type: 'daily' }; }), /write failed/);
  assert.equal(io.files.size, 0);
  assert.equal(io.journal, null);
  assert.equal(store.state.pathTypes.test, undefined);
});

test('state save ambiguity and journal cleanup recover forward without overwriting edits', async () => {
  const { io, store } = setup();
  io.failAt = 'save-after';
  await store.commit([{ path: 'A.md', before: null, after: 'A', type: 'daily' }], () => undefined);
  assert.equal(io.files.get('A.md'), 'A');
  assert.equal(io.journal, null);
  io.failAt = null;
  const restarted = new CalendarStore(io, freshState(DEFAULT_SETTINGS));
  await restarted.recover();
  assert.equal(io.journal, null);
  io.failAt = 'clear';
  await restarted.commit([{ path: 'B.md', before: null, after: 'B', type: 'weekly' }], () => undefined);
  assert.ok(io.journal);
  io.files.set('B.md', 'User edit');
  const again = new CalendarStore(io, freshState(DEFAULT_SETTINGS));
  await assert.rejects(again.recover(), /needs attention/);
  assert.equal(io.files.get('B.md'), 'User edit');
});

test('advisory onChange failures cannot roll back a committed transaction', async () => {
  const { io, store } = setup();
  store.onChange = () => { throw new Error('UI failed'); };
  await store.commit([{ path: 'A.md', before: null, after: 'A', type: 'daily' }], () => undefined);
  assert.equal(io.files.get('A.md'), 'A');
  assert.equal(io.data?.pathTypes['a.md']?.type, 'daily');
});

test('direct daily and weekly opening use templates once and reject a shared path', async () => {
  const { io, service, store } = setup();
  store.state.settings.dailyTemplate = 'Templates/Day';
  store.state.settings.weeklyTemplate = 'Templates/Week';
  io.files.set('Templates/Day.md', '# {{date}}\n\nMy journal\n');
  io.files.set('Templates/Week.md', '# {{date}}\n\nWeekly plan\n');
  const daily = await service.openDaily('2026-10-22');
  const weekly = await service.openWeekly('2026-10-22');
  assert.match(io.files.get(daily)!, /2026-10-22[\s\S]*My journal/);
  assert.match(io.files.get(weekly)!, /Weekly plan/);
  assert.match(io.files.get(daily)!, /^# 2026-10-22/m);
  io.files.set(daily, `${io.files.get(daily)}Handwritten\n`);
  await service.openDaily('2026-10-22');
  assert.match(io.files.get(daily)!, /Handwritten/);
  store.state.settings.weeklyFolder = store.state.settings.dailyFolder;
  store.state.settings.weeklyFormat = store.state.settings.dailyFormat;
  await service.openDaily('2026-10-18');
  await assert.rejects(service.openWeekly('2026-10-22'), /conflicts/);
});

test('default Weekly Note starts with a review section without repeating its filename', async () => {
  const { io, service } = setup();
  const path = await service.openWeekly('2026-10-22');
  assert.match(io.files.get(path)!, /^## Weekly review\n/);
  assert.doesNotMatch(io.files.get(path)!, /^# 2026-W43/m);
});

test('Event Note H1 is generated only when its actual basename differs from the original title', () => {
  const event = { id: 'local|one', sourceId: 'local', uid: 'one', title: 'Roadmap', start, end, allDay: false };
  assert.doesNotMatch(newEventNote(event, 'Calendar Notes/Roadmap.md'), /^# Roadmap/m);
  assert.equal(parseEventNote(newEventNote(event, 'Calendar Notes/Roadmap.md'), 'Calendar Notes/Roadmap.md')?.title, 'Roadmap');
  const sanitized = newEventNote({ ...event, title: 'A/B' }, 'Calendar Notes/A B.md');
  assert.match(sanitized, /^# A\/B/m);
  const sanitizedParsed = parseEventNote(sanitized, 'Calendar Notes/A B.md');
  assert.deepEqual([sanitizedParsed?.id, sanitizedParsed?.title], [event.id, 'A/B']);
  const custom = newEventNote(event, 'Calendar Notes/2026-Roadmap.md');
  assert.match(custom, /^# Roadmap/m);
  const customParsed = parseEventNote(custom, 'Calendar Notes/2026-Roadmap.md');
  assert.deepEqual([customParsed?.id, customParsed?.title], [event.id, event.title]);
});

test('duplicate Event Note title cleanup removes only an exact leading basename H1', () => {
  const yaml = '---\r\nevent_id: "local|one"\r\nstart: "2026-10-22T10:00:00+08:00"\r\nend: "2026-10-22T11:00:00+08:00"\r\ncustom: keep\r\n---\r\n';
  const body = '\r\n# Roadmap\r\n\r\n## Discussion\r\nHandwritten notes.\r\n';
  const before = yaml + body;
  const after = yaml + '\r\n\r\n## Discussion\r\nHandwritten notes.\r\n';
  assert.equal(removeDuplicateEventNoteTitle(before, 'Calendar Notes/Roadmap.md'), after);
  assert.equal(parseEventNote(after, 'Calendar Notes/Roadmap.md')?.id, 'local|one');
  assert.equal(parseEventNote(after, 'Calendar Notes/Roadmap.md')?.title, 'Roadmap');
  assert.equal(removeDuplicateEventNoteTitle(after, 'Calendar Notes/Roadmap.md'), after);
});

test('duplicate title cleanup leaves ordinary, custom-title, fenced, and non-leading content untouched', () => {
  const fm = '---\nevent_id: "local|one"\nstart: "2026-10-22T10:00:00+08:00"\nend: "2026-10-22T11:00:00+08:00"\n---\n';
  const path = 'Calendar Notes/Roadmap.md';
  for (const body of [
    '# Custom title\n\n## Notes\n',
    '```md\n# Roadmap\n```\n',
    'Handwritten intro\n# Roadmap\n',
    '## Notes\n# Roadmap\n',
    '# Roadmap  \n',
    '# Roadmap ###\n',
  ]) {
    assert.equal(removeDuplicateEventNoteTitle(fm + body, path), fm + body);
  }
  assert.equal(removeDuplicateEventNoteTitle('# Roadmap\n', path), '# Roadmap\n');
  assert.equal(removeDuplicateEventNoteTitle('---\nevent_id: other\n---\n# Roadmap\n', path),
    '---\nevent_id: other\n---\n# Roadmap\n');
  assert.equal(removeDuplicateEventNoteTitle(fm + '# Roadmap\n', 'Calendar Notes/Other.md'), fm + '# Roadmap\n');
});

test('explicit duplicate title cleanup changes one recognized Event Note and preserves other content', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const path = store.state.noteLinks[event.id].eventPath;
  const original = io.files.get(path)!;
  const legacy = original + '# Roadmap\n\n## Discussion\nA handwritten paragraph.\n';
  io.files.set(path, legacy);
  assert.equal(await service.removeDuplicateTitle(path), true);
  assert.equal(io.files.get(path), original + '\n## Discussion\nA handwritten paragraph.\n');
  assert.equal(await service.removeDuplicateTitle(path), false);
  assert.equal(await service.removeDuplicateTitle(store.state.noteLinks[event.id].dailyPath), false);
  assert.equal((await service.indexLocal()).find(item => item.id === event.id)?.title, 'Roadmap');
});

test('duplicate Event Note identities block explicit title cleanup without changing either note', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const path = store.state.noteLinks[event.id].eventPath;
  const legacy = io.files.get(path)! + '# Roadmap\n';
  io.files.set(path, legacy);
  io.files.set('Calendar Notes/Roadmap copy.md', legacy);
  await assert.rejects(service.removeDuplicateTitle(path), /Duplicate event_id/);
  assert.equal(io.files.get(path), legacy);
  assert.equal(io.files.get('Calendar Notes/Roadmap copy.md'), legacy);
});

test('renaming waits for FileManager link completion before changing the tracked Daily bullet', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Rename', start, end });
  await service.openEvent(event);
  const old = store.state.noteLinks[event.id];
  const moved = 'Calendar Notes/Retitled.md';
  io.files.set(moved, io.files.get(old.eventPath)!);
  io.files.delete(old.eventPath);
  await service.handleRename({ path: moved, extension: 'md' } as never, old.eventPath);
  assert.equal(store.state.noteLinks[event.id].eventPath, moved);
  assert.deepEqual(store.state.noteLinks[event.id].pendingRename, { oldPath: old.eventPath, newPath: moved });
  assert.match(io.files.get(old.dailyPath)!, /\[\[Calendar Notes\/Rename/);
  const originalDaily = io.files.get(old.dailyPath)!;
  // Obsidian rewrites the wikilink using offsets from its original snapshot.
  io.files.set(old.dailyPath, originalDaily.replace('[[Calendar Notes/Rename|Rename]]', '[[Retitled|Retitled]]'));
  await service.finalizePendingRenames(moved);
  assert.match(io.files.get(old.dailyPath)!, /\[\[Calendar Notes\/Retitled/);
  assert.doesNotMatch(io.files.get(old.dailyPath)!, /\[\[Calendar Notes\/Rename/);
  assert.doesNotMatch(io.files.get(old.dailyPath)!, /\]\] .*\]\]/);
  assert.equal(store.state.noteLinks[event.id].pendingRename, undefined);
});

test('rename with automatic link updates disabled settles the old exact bullet after completion', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'No auto', start, end });
  const old = store.state.noteLinks[event.id];
  const moved = 'Calendar Notes/No auto renamed.md';
  io.files.set(moved, io.files.get(old.eventPath)!);
  io.files.delete(old.eventPath);
  await service.handleRename({ path: moved, extension: 'md' } as never, old.eventPath);
  const before = io.files.get(old.dailyPath)!;
  assert.match(before, /\[\[Calendar Notes\/No auto\|No auto\]\]/);
  await service.finalizePendingRenames(moved);
  const after = io.files.get(old.dailyPath)!;
  assert.match(after, /\[\[Calendar Notes\/No auto renamed\|No auto renamed\]\]/);
  assert.equal(after.split('No auto renamed').length - 1, 2);
});

test('pending rename survives restart and settles without changing unrelated Daily writing', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Restart', start, end });
  const old = store.state.noteLinks[event.id];
  io.files.set(old.dailyPath, io.files.get(old.dailyPath)! + '\nPersonal journal.\n');
  const moved = 'Calendar Notes/Restart moved.md';
  io.files.set(moved, io.files.get(old.eventPath)!);
  io.files.delete(old.eventPath);
  await service.handleRename({ path: moved, extension: 'md' } as never, old.eventPath);
  const restarted = setup(io);
  await restarted.store.recover();
  assert.ok(restarted.store.state.noteLinks[event.id].pendingRename);
  await restarted.service.finalizePendingRenames();
  assert.match(io.files.get(old.dailyPath)!, /Personal journal/);
  assert.match(io.files.get(old.dailyPath)!, /\[\[Calendar Notes\/Restart moved/);
  assert.equal(restarted.store.state.noteLinks[event.id].pendingRename, undefined);
});

function followingDaily() {
  const context = setup();
  Object.assign(context.store.state.settings, { dailyFolder: 'Daily Notes', dailyFormat: 'YYYY/MM/YYYY-MM-DD', eventPattern: '{daily}/{title}' });
  return context;
}
const at = (day: string) => ({ start: `${day}T10:00:00+08:00`, end: `${day}T11:00:00+08:00` });

test('a date change moves an Event Note to the folder of its new Daily Note', async () => {
  const { io, service, store } = followingDaily();
  const event = await service.createLocal({ title: 'Standup', ...at('2026-10-22') });
  assert.equal(store.state.noteLinks[event.id].eventPath, 'Daily Notes/2026/10/Standup.md');
  const moved = await service.reschedule(event, at('2026-11-02'));
  // The move waits for the commit, so Obsidian can update links to the note.
  assert.equal(store.state.noteLinks[event.id].moveTo, 'Daily Notes/2026/11/Standup.md');
  assert.deepEqual(await service.settleMoves(), []);
  const link = store.state.noteLinks[event.id];
  assert.equal(link.eventPath, 'Daily Notes/2026/11/Standup.md');
  assert.equal(link.moveTo, undefined);
  assert.equal(link.pendingRename, undefined);
  assert.equal(io.files.has('Daily Notes/2026/10/Standup.md'), false);
  assert.equal(parseEventNote(io.files.get(link.eventPath)!, link.eventPath)!.start, moved.start);
  assert.match(io.files.get('Daily Notes/2026/11/2026-11-02.md')!, /\[\[Daily Notes\/2026\/11\/Standup\|Standup\]\]/);
  assert.doesNotMatch(io.files.get('Daily Notes/2026/10/2026-10-22.md')!, /Standup/);
  // Another day in the same folder needs no move.
  await service.reschedule(moved, at('2026-11-03'));
  assert.equal(store.state.noteLinks[event.id].moveTo, undefined);
});

test('a renamed Event Note keeps its name when its date moves it; one moved elsewhere stays', async () => {
  const { io, service, store } = followingDaily();
  const renamed = await service.createLocal({ title: 'Renamed', ...at('2026-10-22') });
  const stays = await service.createLocal({ title: 'Stays', ...at('2026-10-22') });
  const rename = async (event: CalendarEvent, path: string) => {
    const from = store.state.noteLinks[event.id].eventPath;
    io.files.set(path, io.files.get(from)!);
    io.files.delete(from);
    await service.handleRename({ path, extension: 'md' } as never, from);
    await service.finalizePendingRenames(path);
  };
  await rename(renamed, 'Daily Notes/2026/10/Team sync.md');
  await rename(stays, 'Projects/Stays.md');
  await service.reschedule(renamed, at('2026-12-01'));
  await service.reschedule(stays, at('2026-12-01'));
  assert.equal(store.state.noteLinks[stays.id].moveTo, undefined);
  await service.settleMoves();
  assert.equal(store.state.noteLinks[renamed.id].eventPath, 'Daily Notes/2026/12/Team sync.md');
  assert.equal(store.state.noteLinks[stays.id].eventPath, 'Projects/Stays.md');
  assert.ok(io.files.has('Projects/Stays.md'));
});

test('a moved Event Note takes a free name, follows date tokens in its name, and old links fall back to the note', async () => {
  const { io, service, store } = followingDaily();
  const event = await service.createLocal({ title: 'Review', ...at('2026-10-22') });
  io.files.set('Daily Notes/2026/11/Review.md', 'Someone else\'s note\n');
  // Links saved before placements were recorded read the note's own time.
  delete store.state.noteLinks[event.id].placedAt;
  await service.reschedule(event, at('2026-11-05'));
  await service.settleMoves();
  assert.equal(store.state.noteLinks[event.id].eventPath, 'Daily Notes/2026/11/Review (2).md');
  assert.equal(io.files.get('Daily Notes/2026/11/Review.md'), 'Someone else\'s note\n');

  store.state.settings.eventPattern = '{daily}/MM-DD {title}';
  const dated = await service.createLocal({ title: 'Dated', ...at('2026-10-22') });
  assert.equal(store.state.noteLinks[dated.id].eventPath, 'Daily Notes/2026/10/10-22 Dated.md');
  await service.reschedule(dated, at('2026-11-05'));
  await service.settleMoves();
  assert.equal(store.state.noteLinks[dated.id].eventPath, 'Daily Notes/2026/11/11-05 Dated.md');
});

test('editing an Event Note start in its frontmatter moves the note too', async () => {
  const { io, service, store } = followingDaily();
  const event = await service.createLocal({ title: 'Edited', ...at('2026-10-22') });
  const path = store.state.noteLinks[event.id].eventPath;
  io.files.set(path, writeEventFrontmatter(io.files.get(path)!, { ...event, ...at('2026-11-09') }));
  await service.scanEvents();
  assert.equal(store.state.noteLinks[event.id].moveTo, 'Daily Notes/2026/11/Edited.md');
  await service.settleMoves();
  assert.equal(store.state.noteLinks[event.id].eventPath, 'Daily Notes/2026/11/Edited.md');
  assert.match(io.files.get('Daily Notes/2026/11/2026-11-09.md')!, /\[\[Daily Notes\/2026\/11\/Edited\|Edited\]\]/);
});

test('a failed move leaves the Event Note and its link in place and is not retried', async () => {
  const { io, service, store } = followingDaily();
  const event = await service.createLocal({ title: 'Stuck', ...at('2026-10-22') });
  await service.reschedule(event, at('2026-11-02'));
  const from = store.state.noteLinks[event.id].eventPath;
  (service as unknown as { app: App }).app.fileManager.renameFile = async () => { throw new Error('locked'); };
  const failures = await service.settleMoves();
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Could not move Daily Notes\/2026\/10\/Stuck\.md to Daily Notes\/2026\/11\/Stuck\.md: locked/);
  assert.equal(store.state.noteLinks[event.id].eventPath, from);
  assert.equal(store.state.noteLinks[event.id].moveTo, undefined);
  assert.ok(io.files.has(from));
});

test('with moving turned off, Event Notes stay and moves not carried out yet are cancelled', async () => {
  const { io, service, store } = followingDaily();
  const kept = await service.createLocal({ title: 'Kept', ...at('2026-10-22') });
  const pending = await service.createLocal({ title: 'Pending', ...at('2026-10-22') });
  await service.reschedule(pending, at('2026-11-02'));
  assert.equal(store.state.noteLinks[pending.id].moveTo, 'Daily Notes/2026/11/Pending.md');
  store.state.settings.moveEventNotes = false;
  await service.reschedule(kept, at('2026-11-02'));
  assert.equal(store.state.noteLinks[kept.id].moveTo, undefined);
  assert.deepEqual(await service.settleMoves(), []);
  assert.equal(store.state.noteLinks[pending.id].moveTo, undefined);
  for (const [event, path] of [[kept, 'Daily Notes/2026/10/Kept.md'], [pending, 'Daily Notes/2026/10/Pending.md']] as const) {
    assert.equal(store.state.noteLinks[event.id].eventPath, path);
    assert.ok(io.files.has(path));
  }
  // The Daily entry still moves to the new date and links the note where it is.
  assert.match(io.files.get('Daily Notes/2026/11/2026-11-02.md')!, /\[\[Daily Notes\/2026\/10\/Kept\|Kept\]\]/);
});

test('patterns without date folders never move Event Notes', async () => {
  const { service, store } = setup();
  const event = await service.createLocal({ title: 'Fixed', ...at('2026-10-22') });
  await service.reschedule(event, at('2026-12-24'));
  assert.equal(store.state.noteLinks[event.id].moveTo, undefined);
  assert.equal(store.state.noteLinks[event.id].eventPath, 'Calendar Notes/Fixed.md');
});

test('direct Event Note frontmatter edit reindexes and moves its managed bullet', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Manual', start, end });
  await service.openEvent(event);
  const original = store.state.noteLinks[event.id];
  io.files.set(original.eventPath, io.files.get(original.eventPath)!
    .replace(start, '2026-10-24T09:00:00+08:00').replace(end, '2026-10-24T10:00:00+08:00'));
  const events = await service.scanEvents();
  assert.equal(events[0].start, '2026-10-24T09:00:00+08:00');
  assert.match(store.state.noteLinks[event.id].dailyPath, /2026-10-24/);
  assert.doesNotMatch(io.files.get(original.dailyPath)!, /\[\[Calendar Notes\/Manual/);
});

test('invalid paths and a wrong event_id never overwrite an occupied note', async () => {
  const { io, service, store } = setup();
  store.state.settings.eventPattern = '../{title}';
  await assert.rejects(service.createLocal({ title: 'Bad', start, end }), /dot segments/);
  store.state.settings.eventPattern = '[Calendar Notes]/{title}';
  io.files.set('Calendar Notes/Occupied.md', '---\nevent_id: "local|someone-else"\nstart: "2026-10-22T10:00:00+08:00"\nend: "2026-10-22T11:00:00+08:00"\n---\n# Occupied\n');
  const event = await service.createLocal({ title: 'Occupied', start, end });
  await service.openEvent(event);
  assert.match(store.state.noteLinks[event.id].eventPath, /Occupied \(2\)\.md$/);
  assert.match(io.files.get('Calendar Notes/Occupied.md')!, /someone-else/);
});

test('literal true identity and special title stay strings after YAML round trip', () => {
  const event = { id: 'true', sourceId: 'true', uid: 'true', title: 'A [bracket] # plan', start, end, allDay: false };
  const note = newEventNote(event);
  assert.match(note, /event_id: "true"/);
  assert.match(note, /source: "true"/);
  assert.equal(parseEventNote(note, 'Note.md')?.title, event.title);
  assert.equal(writeEventFrontmatter(note, event), note);
});

test('apparent Event heading inside a code fence does not capture a managed bullet', () => {
  const content = '# Journal\n\n```md\n## Event\n```still code\n- example\n```\n\n## Journal\nText\n';
  const result = addEventBullet(content, '- 10:00 [[A]]');
  assert.match(result, /```still code\n- example\n```/);
  assert.match(result, /## Journal\nText\n\n## Events\n- 10:00 \[\[A\]\]/);
});

test('inline triple backticks at a line start do not hide the Event section', () => {
  const once = addEventBullet('## Journal\n```inline``` code\n', '- 10:00 [[A]]');
  assert.equal(once, '## Journal\n```inline``` code\n\n## Events\n- 10:00 [[A]]\n');
  assert.equal(addEventBullet(once, '- 10:00 [[A]]'), once);
});

test('an unclosed fence is closed before adding the Event entry so later adds find it', () => {
  const bullet = '- 10:00 [[A]]';
  const noSection = addEventBullet('## Journal\n````js\ncode', bullet);
  assert.equal(noSection, '## Journal\n````js\ncode\n````\n\n## Events\n- 10:00 [[A]]\n');
  assert.equal(addEventBullet(noSection, bullet), noSection);
  const inSection = addEventBullet('## Event\n\n~~~\nnote\n', bullet);
  assert.equal(inSection, '## Event\n\n~~~\nnote\n~~~\n- 10:00 [[A]]\n');
  assert.equal(addEventBullet(inSection, bullet), inSection);
  const later = '## Event\n\n## Journal\n```\ncode\n';
  assert.equal(addEventBullet(later, bullet), '## Event\n- 10:00 [[A]]\n\n## Journal\n```\ncode\n');
});

test('repeated event clicks add one Daily entry when the Daily Note has an unclosed fence', async () => {
  const { io, service, store } = setup();
  const event = imported();
  store.state.sourceCaches.work = { ...emptySourceCache(), accepted: { [event.id]: { event, revision: 0 } } };
  io.files.set('Daily Notes/2026-10-22.md', '## Journal\n```\npasted code\n');
  await service.openEvent(event);
  await service.openEvent(event);
  await service.scanEvents();
  await service.openEvent(event);
  const daily = io.files.get(store.state.noteLinks[event.id].dailyPath)!;
  assert.equal(daily.split('[[Calendar Notes/Imported').length - 1, 1);
  assert.equal(daily.split('## Events\n').length - 1, 1);
});

test('invalid Event Note edit keeps the last valid local event visible until repaired', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Retain', start, end });
  await service.openEvent(event);
  await service.scanEvents();
  const path = store.state.noteLinks[event.id].eventPath;
  const valid = io.files.get(path)!;
  io.files.set(path, valid.replace(end, 'invalid'));
  assert.equal((await service.scanEvents())[0].id, event.id);
  assert.match(service.diagnostics.join(' '), /Invalid event times|ISO timestamps/);
  io.files.set(path, valid);
  assert.equal((await service.scanEvents())[0].id, event.id);
  assert.equal(service.diagnostics.length, 0);
});

test('duplicate event_id blocks opening either note until ambiguity is resolved', async () => {
  const { io, service } = setup();
  const event = await service.createLocal({ title: 'Duplicate', start, end });
  const first = [...io.files.keys()][0];
  io.files.set('Other.md', io.files.get(first)!);
  assert.equal((await service.scanEvents()).length, 0);
  await assert.rejects(service.openEvent(event), /Duplicate event_id/);
  assert.equal(io.files.get('Other.md'), io.files.get(first));
});

test('deleting the Daily Note and Event Note lets a later click recreate both', async () => {
  const { io, service, store, opened } = setup();
  const event = imported();
  const cache = emptySourceCache();
  cache.accepted[event.id] = { event, revision: 0 };
  store.state.sourceCaches.work = cache;
  await service.openEvent(event);
  const link = store.state.noteLinks[event.id];
  io.files.delete(link.eventPath);
  io.files.delete(link.dailyPath);
  assert.ok((await service.scanEvents()).some(item => item.id === event.id));
  assert.equal(await service.openDaily('2026-10-22'), link.dailyPath);
  assert.equal(await service.openEvent(event), link.eventPath);
  assert.equal(io.files.get(link.dailyPath)!.split(link.bullet).length - 1, 1);
  assert.match(io.files.get(link.eventPath)!, /event_id:/);
  assert.deepEqual(opened.slice(-2), [link.dailyPath, link.eventPath]);
});

test('deleting only the Daily Note lets a later event click relink it', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const link = store.state.noteLinks[event.id];
  io.files.delete(link.dailyPath);
  await service.openEvent(event);
  assert.equal(io.files.get(link.dailyPath)!.split(link.bullet).length - 1, 1);
});

test('a source update does not recreate a deleted Event Note', async () => {
  const { io, service, store } = setup();
  const event = imported();
  await service.openEvent(event);
  const link = store.state.noteLinks[event.id];
  io.files.delete(link.eventPath);
  const plan = await service.updateLinkedInterval(event, { start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00' });
  assert.deepEqual(plan.writes, []);
});

test('a deleted renamed Event Note is recreated instead of reported as moved', async () => {
  const { io, service, store } = setup();
  const event = imported();
  await service.openEvent(event);
  const original = store.state.noteLinks[event.id];
  const renamed = original.eventPath.replace(/[^/]+\.md$/, 'Renamed.md');
  io.files.set(renamed, io.files.get(original.eventPath)!);
  io.files.delete(original.eventPath);
  await service.handleRename({ path: renamed, extension: 'md' } as never, original.eventPath);
  await service.finalizePendingRenames(renamed);
  const link = store.state.noteLinks[event.id];
  io.files.delete(link.eventPath);
  io.files.delete(link.dailyPath);
  const path = await service.openEvent(event);
  assert.equal(path, original.eventPath);
  assert.equal(io.files.get(link.dailyPath)!.split('[[').length - 1, 1);
});

test('an unrelated note at the deleted Event Note path does not block recreation', async () => {
  const { io, service, store } = setup();
  const event = imported();
  await service.openEvent(event);
  const original = store.state.noteLinks[event.id];
  const renamed = original.eventPath.replace(/[^/]+\.md$/, 'Renamed.md');
  io.files.set(renamed, io.files.get(original.eventPath)!);
  io.files.delete(original.eventPath);
  await service.handleRename({ path: renamed, extension: 'md' } as never, original.eventPath);
  await service.finalizePendingRenames(renamed);
  const link = store.state.noteLinks[event.id];
  io.files.set(link.eventPath, '# Something else\n');
  delete store.state.pathTypes[link.eventPath.toLocaleLowerCase('en-US')];
  const path = await service.openEvent(event);
  assert.equal(path, original.eventPath);
  assert.equal(io.files.get(link.eventPath), '# Something else\n');
});

test('clicking an event whose Daily entry was removed adds it back instead of failing', async () => {
  const { io, service, store, opened } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const link = store.state.noteLinks[event.id];
  io.files.set(link.dailyPath, io.files.get(link.dailyPath)!.replace(`${link.bullet}\n`, ''));
  await service.openEvent(event);
  assert.equal(io.files.get(link.dailyPath)!.split(link.bullet).length - 1, 1);
  assert.deepEqual(opened, [link.eventPath]);
});

test('a generated entry with a stale alias or time is rewritten in place on click', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const link = store.state.noteLinks[event.id];
  const stale = '- 09:00–09:30 [[Calendar Notes/Roadmap|Old name]]';
  io.files.set(link.dailyPath, `## Journal\n\n${stale}\n\n## Event\n\n- 08:00 [[Other|Other]]\n`);
  store.state.noteLinks[event.id] = { ...link, bullet: '- 07:00–08:00 [[Calendar Notes/Roadmap|Never written]]' };
  await service.openEvent(event);
  assert.equal(io.files.get(link.dailyPath), `## Journal\n\n${link.bullet}\n\n## Event\n\n- 08:00 [[Other|Other]]\n`);
  assert.equal(store.state.noteLinks[event.id].bullet, link.bullet);
});

test('repeated generated entries for one event collapse to one; handwritten links stay', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const link = store.state.noteLinks[event.id];
  const own = '- Discussed [[Calendar Notes/Roadmap|the roadmap]]';
  io.files.set(link.dailyPath, `## Event\n\n${link.bullet}\n- 09:00–10:00 [[Calendar Notes/Roadmap|Roadmap]]\n${own}\n\n## Event\n\n${link.bullet}\n`);
  await service.openEvent(event);
  assert.equal(io.files.get(link.dailyPath), `## Event\n\n${link.bullet}\n${own}\n\n## Event\n\n`);
});

test('a background move leaves a rewritten entry and says how to restore it', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const link = store.state.noteLinks[event.id];
  io.files.set(link.dailyPath, io.files.get(link.dailyPath)!.replace(link.bullet, '- Roadmap, moved to tomorrow'));
  const moved = { ...event, start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00' };
  await assert.rejects(service.updateLinkedInterval(event, moved), /Open the event from the calendar to add it again/);
  await service.openEvent(event);
  assert.match(io.files.get(link.dailyPath)!, /- Roadmap, moved to tomorrow\n[\s\S]*- 10:00–11:00 \[\[Calendar Notes\/Roadmap\|Roadmap\]\]/);
});

test('a rename settles when the Daily Note holds repeated entries for the event', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Twice', start, end });
  const old = store.state.noteLinks[event.id];
  io.files.set(old.dailyPath, `${io.files.get(old.dailyPath)!}${old.bullet}\n`);
  const moved = 'Calendar Notes/Twice renamed.md';
  io.files.set(moved, io.files.get(old.eventPath)!);
  io.files.delete(old.eventPath);
  await service.handleRename({ path: moved, extension: 'md' } as never, old.eventPath);
  await service.finalizePendingRenames(moved);
  const link = store.state.noteLinks[event.id];
  assert.equal(link.pendingRename, undefined);
  assert.equal(io.files.get(old.dailyPath)!.split('[[Calendar Notes/Twice').length - 1, 1);
  assert.equal(await service.openEvent(event), moved);
});

test('a scan replan queued beside a click leaves the link matching the Daily Note', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const link = store.state.noteLinks[event.id];
  io.files.set(link.eventPath, `${io.files.get(link.eventPath)!}# Renamed heading\n`);
  await Promise.all([service.openEvent(event), service.scanEvents()]);
  const current = store.state.noteLinks[event.id];
  assert.equal(io.files.get(current.dailyPath)!.split(current.bullet).length - 1, 1);
  await service.openEvent((await service.scanEvents())[0]);
});

test('a new Daily Note lists entries directly under ## Events', async () => {
  const { io, service, store } = setup();
  const one = await service.createLocal({ title: 'One', start, end });
  await service.createLocal({ title: 'Two', start: '2026-10-22T12:00:00+08:00', end: '2026-10-22T13:00:00+08:00' });
  assert.equal(io.files.get(store.state.noteLinks[one.id].dailyPath),
    '## Journal\n\n## Events\n- 10:00–11:00 [[Calendar Notes/One|One]]\n- 12:00–13:00 [[Calendar Notes/Two|Two]]\n');
});

test('entries join an existing section after its last entry, legacy ## Event included', () => {
  const bullet = '- 12:00 [[B]]';
  assert.equal(addEventBullet('## Events\n- 10:00 [[A]]\n\n## Journal\nText\n', bullet),
    '## Events\n- 10:00 [[A]]\n- 12:00 [[B]]\n\n## Journal\nText\n');
  assert.equal(addEventBullet('## Event\n\n- 10:00 [[A]]\n', bullet), '## Event\n\n- 10:00 [[A]]\n- 12:00 [[B]]\n');
  assert.equal(addEventBullet('## Events', bullet), '## Events\n- 12:00 [[B]]\n');
});

test('a linked Event Note that the Markdown listing misses still opens at its linked path', async () => {
  const { io, service, store } = setup();
  const event = imported();
  await service.openEvent(event);
  const link = store.state.noteLinks[event.id];
  const listMarkdown = io.listMarkdown.bind(io);
  io.listMarkdown = async () => (await listMarkdown()).filter(path => path !== link.eventPath);
  store.state.settings.eventPattern = 'Elsewhere/{title}';
  assert.equal(await service.openEvent(event), link.eventPath);
  assert.equal(store.state.noteLinks[event.id].eventPath, link.eventPath);
});

function resubscribed() {
  const context = setup();
  const source = (id: string) => ({ id, name: 'Work', url: 'https://example.test/work.ics', color: '#123456', enabled: true });
  const event = (sourceId: string): CalendarEvent => ({ id: sourceEventId(sourceId, 'uid-fw'), sourceId, uid: 'uid-fw',
    title: 'FW: Meeting', start, end, allDay: false, status: 'active' });
  context.store.state.settings = { ...context.store.state.settings, sources: [source('old')] };
  const resubscribe = () => { context.store.state.settings = { ...context.store.state.settings, sources: [source('new')] }; };
  return { ...context, old: event('old'), current: event('new'), resubscribe };
}

test('re-adding a removed subscription reuses its Event Note and Daily entry', async () => {
  const { io, service, store, old, current, resubscribe } = resubscribed();
  const path = await service.openEvent(old);
  const link = store.state.noteLinks[old.id];
  resubscribe();
  // 0.1.0 had already recorded a link to a "(2)" note it never wrote.
  store.state.noteLinks[current.id] = { eventPath: 'Calendar Notes/FW Meeting (2).md', dailyPath: link.dailyPath,
    bullet: '- 10:00–11:00 [[Calendar Notes/FW Meeting (2)|FW: Meeting]]' };
  assert.equal(await service.openEvent(current), path);
  assert.equal(parseEventNote(io.files.get(path)!, path)?.id, current.id);
  assert.match(io.files.get(path)!, /source: "new"/);
  assert.equal(io.files.has('Calendar Notes/FW Meeting (2).md'), false);
  assert.equal(store.state.noteLinks[old.id], undefined);
  assert.equal(store.state.noteLinks[current.id].eventPath, path);
  assert.equal(io.files.get(link.dailyPath)!.split('[[Calendar Notes/FW Meeting').length - 1, 1);
  assert.equal(await service.openEvent(current), path);
});

test('an adopted note keeps the times the user changed under the removed subscription', async () => {
  const { io, service, store, old, current, resubscribe } = resubscribed();
  await service.openEvent(old);
  const moved = { start: '2026-10-22T14:00:00+08:00', end: '2026-10-22T15:00:00+08:00', allDay: false };
  await service.reschedule(old, moved);
  resubscribe();
  const path = await service.openEvent(current);
  assert.match(io.files.get(path)!, /start: "2026-10-22T14:00:00\+08:00"/);
  assert.deepEqual(store.state.overrides[current.id], moved);
  assert.equal(store.state.overrides[old.id], undefined);
});

test('several notes from a removed subscription: the linked one is reused, otherwise the user is asked', async () => {
  const { io, service, store, old, current, resubscribe } = resubscribed();
  const path = await service.openEvent(old);
  const copy = 'Calendar Notes/FW Meeting 1.md';
  io.files.set(copy, io.files.get(path)!);
  resubscribe();
  assert.equal(await service.openEvent(current), path);
  assert.equal(parseEventNote(io.files.get(copy)!, copy)?.id, old.id);

  const other = resubscribed();
  const otherPath = await other.service.openEvent(other.old);
  other.io.files.set(copy, other.io.files.get(otherPath)!);
  const otherLink = other.store.state.noteLinks[other.old.id];
  other.io.files.set(otherLink.dailyPath, other.io.files.get(otherLink.dailyPath)!.replace(`${otherLink.bullet}\n`, ''));
  delete other.store.state.noteLinks[other.old.id];
  other.resubscribe();
  await assert.rejects(other.service.openEvent(other.current), /Several Event Notes from a removed calendar.*FW Meeting\.md.*FW Meeting 1\.md/);
  assert.equal(other.io.files.has('Calendar Notes/FW Meeting (2).md'), false);
});

test('notes of a still-configured subscription are never adopted by another one', async () => {
  const { io, service, store, old } = resubscribed();
  const path = await service.openEvent(old);
  const sibling = { ...old, id: sourceEventId('new', 'uid-fw'), sourceId: 'new' };
  store.state.settings = { ...store.state.settings, sources: [...store.state.settings.sources,
    { id: 'new', name: 'Other', url: 'https://example.test/other.ics', color: '#654321', enabled: true }] };
  const second = await service.openEvent(sibling);
  assert.notEqual(second, path);
  assert.equal(parseEventNote(io.files.get(path)!, path)?.id, old.id);
});

test('a scan reconnects a removed subscription note without a click and explains leftover copies', async () => {
  const { io, service, store, old, current, resubscribe } = resubscribed();
  const path = await service.openEvent(old);
  const copy = 'Calendar Notes/FW Meeting 1.md';
  io.files.set(copy, io.files.get(path)!);
  delete store.state.sourceCaches.old;
  resubscribe();
  store.state.sourceCaches.new = { ...emptySourceCache(), accepted: { [current.id]: { event: current, revision: 0 } } };
  await service.scanEvents();
  assert.equal(parseEventNote(io.files.get(path)!, path)?.id, current.id);
  assert.deepEqual(service.diagnostics, [`${copy}: Created by a calendar subscription that was removed; ${path} now holds this event. Delete this copy or merge it into that note.`]);
  const scanned = await service.scanEvents();
  assert.equal(scanned.find(event => event.id === current.id)?.title, 'FW: Meeting');
  assert.equal(service.diagnostics.length, 1);
});

test('scan diagnostics say why an imported note is not shown', async () => {
  const { io, service, store, old, resubscribe } = resubscribed();
  const path = await service.openEvent(old);
  io.files.set('Calendar Notes/Copy.md', io.files.get(path)!);
  store.state.sourceCaches.old = { ...emptySourceCache(), accepted: {} };
  await service.scanEvents();
  assert.deepEqual(service.diagnostics.sort(), [
    `Calendar Notes/Copy.md: Has the same event_id as ${path}, so both are skipped. Delete or merge one of them.`,
    `${path}: Calendar "Work" does not list this event. It may have been deleted from the calendar, or the note's event_id, ical_uid or recurrence_id was edited.`,
  ]);
  io.files.delete('Calendar Notes/Copy.md');
  await service.scanEvents();
  assert.deepEqual(service.diagnostics, [`${path}: Calendar "Work" does not list this event. It may have been deleted from the calendar, or the note's event_id, ical_uid or recurrence_id was edited.`]);
  resubscribe();
  delete store.state.sourceCaches.old;
  await service.scanEvents();
  assert.deepEqual(service.diagnostics, [`${path}: Created by a calendar subscription that was removed, and no current calendar lists this event. Delete the note if you no longer need it.`]);
});

test('with no old link, the copy the Daily Note lists keeps the event', async () => {
  const { io, service, store, old, current, resubscribe } = resubscribed();
  const path = await service.openEvent(old);
  const copy = 'Calendar Notes/FW Meeting 1.md';
  io.files.set(copy, io.files.get(path)!);
  delete store.state.noteLinks[old.id];
  resubscribe();
  assert.equal(await service.openEvent(current), path);
  assert.equal(parseEventNote(io.files.get(copy)!, copy)?.id, old.id);
});

test('when nothing tells the copies apart, a click asks which note keeps the event', async () => {
  const { io, service, store, old, current, resubscribe, opened } = resubscribed();
  const path = await service.openEvent(old);
  const copy = 'Calendar Notes/FW Meeting 1.md';
  io.files.set(copy, io.files.get(path)!);
  const link = store.state.noteLinks[old.id];
  io.files.set(link.dailyPath, io.files.get(link.dailyPath)!.replace(`${link.bullet}\n`, ''));
  delete store.state.noteLinks[old.id];
  resubscribe();
  let offered: string[] = [];
  await assert.rejects(service.openEvent(current, async paths => { offered = paths; return undefined; }), /No Event Note was chosen/);
  assert.deepEqual(offered.sort(), [copy, path].sort());
  assert.equal(await service.openEvent(current, async () => copy), copy);
  assert.equal(parseEventNote(io.files.get(copy)!, copy)?.id, current.id);
  assert.equal(parseEventNote(io.files.get(path)!, path)?.id, old.id);
  assert.equal(opened.at(-1), copy);
  store.state.sourceCaches.new = { ...emptySourceCache(), accepted: { [current.id]: { event: current, revision: 0 } } };
  await service.scanEvents();
  assert.deepEqual(service.diagnostics, [`${path}: Created by a calendar subscription that was removed; ${copy} now holds this event. Delete this copy or merge it into that note.`]);
});

test('an event can be linked to an existing note, keeping both notes\' other content', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const old = store.state.noteLinks[event.id];
  io.files.set(old.eventPath, `${io.files.get(old.eventPath)!}Agenda written here.\n`);
  await service.scanEvents();
  io.files.set('Projects/Plan.md', '---\ntags: [plan]\n---\nExisting plan.\n');
  assert.equal(await service.linkNote(event, 'Projects/Plan.md'), 'Projects/Plan.md');
  const plan = io.files.get('Projects/Plan.md')!;
  assert.equal(parseEventNote(plan, 'Projects/Plan.md')?.id, event.id);
  assert.match(plan, /^---\ntags: \[plan\]\nevent_id: /);
  assert.match(plan, /Existing plan\.\n$/);
  assert.equal(io.files.get(old.eventPath), 'Agenda written here.\n');
  const link = store.state.noteLinks[event.id];
  assert.equal(link.eventPath, 'Projects/Plan.md');
  assert.equal(link.bullet, '- 10:00–11:00 [[Projects/Plan|Plan]]');
  const daily = io.files.get(link.dailyPath)!;
  assert.equal(daily.split(link.bullet).length - 1, 1);
  assert.doesNotMatch(daily, /Calendar Notes\/Roadmap/);
  assert.equal(store.state.pathTypes['calendar notes/roadmap.md'], undefined);
  assert.equal(store.state.pathTypes['projects/plan.md'].ownerId, event.id);
  const scanned = await service.scanEvents();
  assert.deepEqual(scanned.map(item => [item.id, item.title]), [[event.id, 'Plan']]);
  assert.deepEqual(service.diagnostics, []);
  // The original note can take the event back.
  await service.linkNote(event, old.eventPath);
  assert.equal(parseEventNote(io.files.get(old.eventPath)!, old.eventPath)?.id, event.id);
  assert.equal(io.files.get('Projects/Plan.md'), '---\ntags: [plan]\n---\nExisting plan.\n');
  assert.equal(io.files.get(link.dailyPath)!.split('[[').length - 1, 1);
});

test('linking an unopened imported event to a new path creates the note and its Daily entry', async () => {
  const { io, service, store } = setup();
  const event = imported();
  const cache = emptySourceCache();
  cache.accepted[event.id] = { event, revision: 0 };
  store.state.sourceCaches.work = cache;
  await service.linkNote(event, 'Meetings/Weekly sync.md');
  const note = parseEventNote(io.files.get('Meetings/Weekly sync.md')!, 'Meetings/Weekly sync.md');
  assert.deepEqual([note?.id, note?.source, note?.uid, note?.title], [event.id, 'work', 'uid-1', 'Imported']);
  const link = store.state.noteLinks[event.id];
  assert.equal(io.files.get(link.dailyPath)!.split('[[Meetings/Weekly sync|Imported]]').length - 1, 1);
  assert.equal(io.files.size, 2);
});

test('a note that belongs elsewhere or uses managed properties is never linked', async () => {
  const { io, service, store } = setup();
  const first = await service.createLocal({ title: 'First', start, end });
  const second = await service.createLocal({ title: 'Second', start, end });
  io.files.set('Timed.md', '---\nstart: tomorrow\n---\nBody\n');
  io.files.set('Broken.md', '---\ntags: [\n---\nBody\n');
  const before = new Map(io.files);
  const links = structuredClone(store.state.noteLinks);
  await assert.rejects(service.linkNote(first, store.state.noteLinks[second.id].eventPath), /another event/);
  await assert.rejects(service.linkNote(first, 'Timed.md'), /already has the start property/);
  await assert.rejects(service.linkNote(first, 'Broken.md'), /Invalid YAML/);
  await assert.rejects(service.linkNote(first, store.state.noteLinks[first.id].dailyPath), /Daily Note/);
  await assert.rejects(service.linkNote(first, 'Picture.png'), /Markdown/);
  assert.deepEqual(io.files, before);
  assert.deepEqual(store.state.noteLinks, links);
});

test('detaching an Event Note drops only managed properties', () => {
  const note = writeEventFrontmatter('---\ntags: [x]\n---\nBody\n', { id: 'local|a', sourceId: 'local', uid: 'a', title: 'A', start, end, allDay: false });
  assert.equal(detachEventFrontmatter(note), '---\ntags: [x]\n---\nBody\n');
  assert.equal(detachEventFrontmatter(writeEventFrontmatter('Body\n', { id: 'local|a', sourceId: 'local', uid: 'a', title: 'A', start, end, allDay: false })), 'Body\n');
  assert.deepEqual(managedEventKeys(note), ['event_id', 'start', 'end']);
});

test('a chosen leaf receives and shows Event, Daily, and Weekly Notes instead of a new tab', async () => {
  const { service, opened, revealed } = setup();
  const beside: string[] = [];
  const leaf = { openFile: async (file: { path: string }) => { beside.push(file.path); } };
  const target = () => leaf as never;
  const event = await service.createLocal({ title: 'Beside', start, end });
  const eventPath = await service.openEvent(event, undefined, target);
  const daily = await service.openDaily('2026-10-22', target);
  const weekly = await service.openWeekly('2026-10-22', target);
  assert.deepEqual(beside, [eventPath, daily, weekly]);
  assert.deepEqual(revealed, [leaf, leaf, leaf]);
  assert.deepEqual(opened, []);
});

test('notes sharing an event_id are reported as one problem, and keeping one fixes it', async () => {
  const { io, service, store, trashed } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const link = store.state.noteLinks[event.id];
  const original = io.files.get(link.eventPath)!;
  io.files.set('Copies/Roadmap 1.md', original);
  io.files.set('Copies/Roadmap 2.md', `${original}Notes only in this copy.\n`);
  await service.scanEvents();
  assert.equal(service.problems.length, 1);
  const [problem] = service.problems;
  assert.equal(problem.kind, 'duplicate');
  assert.deepEqual([...problem.paths].sort(), [link.eventPath, 'Copies/Roadmap 1.md', 'Copies/Roadmap 2.md'].sort());
  const facts = await service.inspectNotes(problem.paths);
  assert.deepEqual(facts.filter(note => note.linked).map(note => note.path), [link.eventPath]);
  assert.deepEqual(facts.filter(note => note.listed).map(note => note.path), [link.eventPath]);
  const seen = Object.fromEntries(facts.map(note => [note.path, note.content]));
  // A note edited after the user compared it is never overwritten.
  io.files.set('Copies/Roadmap 1.md', `${original}Typed meanwhile.\n`);
  await assert.rejects(service.resolveDuplicate(link.eventPath, [{ path: 'Copies/Roadmap 1.md', action: 'trash' }], seen), /changed after you reviewed it/);
  assert.equal(io.files.get('Copies/Roadmap 1.md'), `${original}Typed meanwhile.\n`);
  io.files.set('Copies/Roadmap 1.md', original);
  await service.resolveDuplicate(link.eventPath, [
    { path: 'Copies/Roadmap 1.md', action: 'trash' },
    { path: 'Copies/Roadmap 2.md', action: 'merge' },
  ], seen);
  assert.deepEqual(trashed, ['Copies/Roadmap 1.md', 'Copies/Roadmap 2.md']);
  assert.match(io.files.get(link.eventPath)!, /## Merged from Roadmap 2\n\nNotes only in this copy\.\n$/);
  const scanned = await service.scanEvents();
  assert.deepEqual(service.problems, []);
  assert.deepEqual(scanned.map(item => item.id), [event.id]);
});

test('keeping a copy instead of the linked note moves the Daily entry to it', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  const link = store.state.noteLinks[event.id];
  io.files.set('Projects/Roadmap.md', `${io.files.get(link.eventPath)!}Better notes.\n`);
  await service.scanEvents();
  assert.equal(service.problems[0].kind, 'duplicate');
  await service.resolveDuplicate('Projects/Roadmap.md', [{ path: link.eventPath, action: 'detach' }]);
  assert.equal(parseEventNote(io.files.get(link.eventPath)!, link.eventPath), null);
  assert.equal(io.files.get(link.eventPath), '');
  const moved = store.state.noteLinks[event.id];
  assert.equal(moved.eventPath, 'Projects/Roadmap.md');
  const daily = io.files.get(moved.dailyPath)!;
  assert.equal(daily.split('[[').length - 1, 1);
  assert.match(daily, /\[\[Projects\/Roadmap\|Roadmap\]\]/);
  await service.scanEvents();
  assert.deepEqual(service.problems, []);
});

test('copies of a reconnected note are grouped with the note that holds the event', async () => {
  const { io, service, store, old, current, resubscribe, trashed } = resubscribed();
  const path = await service.openEvent(old);
  const copies = ['Calendar Notes/FW Meeting 1.md', 'Calendar Notes/FW Meeting 2.md'];
  for (const copy of copies) io.files.set(copy, io.files.get(path)!);
  delete store.state.sourceCaches.old;
  resubscribe();
  store.state.sourceCaches.new = { ...emptySourceCache(), accepted: { [current.id]: { event: current, revision: 0 } } };
  await service.scanEvents();
  assert.deepEqual(service.problems.map(problem => [problem.kind, problem.holder, problem.paths]), [['duplicate', path, [path, ...copies]]]);
  await service.resolveDuplicate(path, copies.map(copy => ({ path: copy, action: 'trash' as const })));
  assert.deepEqual(trashed, copies);
  await service.scanEvents();
  assert.deepEqual(service.problems, []);
  assert.equal(parseEventNote(io.files.get(path)!, path)?.id, current.id);
});

test('a note its calendar no longer lists can be kept as an ordinary note', async () => {
  const { io, service, store, old } = resubscribed();
  const path = await service.openEvent(old);
  io.files.set(path, `${io.files.get(path)!}Minutes.\n`);
  store.state.sourceCaches.old = { ...emptySourceCache(), accepted: {} };
  await service.scanEvents();
  assert.deepEqual(service.problems.map(problem => [problem.kind, problem.sourceId]), [['unlisted', 'old']]);
  await service.releaseNote(path, 'detach');
  assert.equal(io.files.get(path), '# FW: Meeting\n\nMinutes.\n');
  assert.equal(store.state.noteLinks[old.id], undefined);
  assert.equal(store.state.pathTypes['calendar notes/fw meeting.md'], undefined);
  await service.scanEvents();
  assert.deepEqual(service.problems, []);
});

test('a removed calendar note matched by two calendars is given to the one the user picks', async () => {
  const { io, service, store, old, current, resubscribe } = resubscribed();
  const path = await service.openEvent(old);
  delete store.state.sourceCaches.old;
  resubscribe();
  const other = { ...current, id: sourceEventId('home', 'uid-fw'), sourceId: 'home' };
  store.state.settings = { ...store.state.settings, sources: [...store.state.settings.sources,
    { id: 'home', name: 'Home', url: 'https://example.test/home.ics', color: '#654321', enabled: true }] };
  store.state.sourceCaches.new = { ...emptySourceCache(), accepted: { [current.id]: { event: current, revision: 0 } } };
  store.state.sourceCaches.home = { ...emptySourceCache(), accepted: { [other.id]: { event: other, revision: 0 } } };
  await service.scanEvents();
  const [problem] = service.problems;
  assert.equal(problem.kind, 'orphan');
  assert.deepEqual(problem.candidates?.map(candidate => candidate.sourceId).sort(), ['home', 'new']);
  await service.reconnectNote(path, other.id);
  assert.equal(parseEventNote(io.files.get(path)!, path)?.id, other.id);
  await service.scanEvents();
  assert.deepEqual(service.problems, []);
});

test('hand-edited event properties can be put back from the last valid version', async () => {
  const { io, service } = setup();
  const event = await service.createLocal({ title: 'Roadmap', start, end });
  await service.scanEvents();
  const path = 'Calendar Notes/Roadmap.md';
  const valid = io.files.get(path)!;
  io.files.set(path, valid.replace(/end: "[^"]+"/, 'end: "2026-10-22T10:05:00+08:00"'));
  let scanned = await service.scanEvents();
  assert.equal(service.problems[0].kind, 'invalid');
  assert.equal(service.problems[0].lastValid?.end, end);
  assert.equal(scanned.length, 1);
  await service.restoreNote(path);
  assert.equal(io.files.get(path), valid);
  io.files.set(path, valid.replace(/event_id: "[^"]+"\n/, ''));
  scanned = await service.scanEvents();
  assert.deepEqual(service.problems.map(problem => problem.kind), ['missing-id']);
  await service.restoreNote(path);
  assert.equal(parseEventNote(io.files.get(path)!, path)?.id, event.id);
  await service.scanEvents();
  assert.deepEqual(service.problems, []);
});

test('a removed calendar note that no calendar lists can be moved to trash', async () => {
  const { io, service, store, old, resubscribe, trashed } = resubscribed();
  const path = await service.openEvent(old);
  delete store.state.sourceCaches.old;
  resubscribe();
  await service.scanEvents();
  assert.deepEqual(service.problems.map(problem => [problem.kind, problem.paths, problem.candidates]), [['orphan', [path], undefined]]);
  const [facts] = await service.inspectNotes([path]);
  await service.releaseNote(path, 'trash', { [path]: facts.content });
  assert.deepEqual(trashed, [path]);
  assert.equal(io.files.has(path), false);
  assert.equal(store.state.noteLinks[old.id], undefined);
  await service.scanEvents();
  assert.deepEqual(service.problems, []);
});

test('notes named like the Event Note beside it are offered for binding, but not other events\' notes', async () => {
  const { io, service, store } = setup();
  const event = await service.createLocal({ title: 'Standup', start, end });
  const other = await service.createLocal({ title: 'Standup sync', start, end });
  const eventPath = store.state.noteLinks[event.id].eventPath;
  const otherPath = store.state.noteLinks[other.id].eventPath;
  const folder = eventPath.slice(0, eventPath.lastIndexOf('/'));
  io.files.set(`${folder}/Standup (2).md`, 'Second copy\n');
  io.files.set(`${folder}/Standup draft.md`, 'Draft\n');
  io.files.set(`${folder}/Retro.md`, 'Unrelated\n');
  io.files.set(`Elsewhere/Standup.md`, 'Another folder\n');
  const candidates = await service.noteCandidates(event);
  assert.deepEqual(candidates, [eventPath, `${folder}/Standup (2).md`, `${folder}/Standup draft.md`].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  assert.ok(!candidates.includes(otherPath));
  assert.ok(!candidates.includes(store.state.noteLinks[event.id].dailyPath));
});

test('the dialog preview shows the note text without its frontmatter', () => {
  assert.equal(noteBody('---\nevent_id: a\nstart: x\n---\n# Title\n\nBody\n'), '# Title\n\nBody');
  assert.equal(noteBody('---\n---\nOnly body'), 'Only body');
  assert.equal(noteBody('No frontmatter\n---\nrule'), 'No frontmatter\n---\nrule');
  assert.equal(noteBody('---\nevent_id: a\n---\n'), '');
});

test('a problem note reports its event, its Daily entry and the notes that link to it', async () => {
  const { io, service, store, old, resubscribe } = resubscribed();
  const path = await service.openEvent(old);
  const link = store.state.noteLinks[old.id];
  io.files.set('Projects/Q4.md', `See [[${path.replace(/\.md$/, '')}]]\n`);
  delete store.state.sourceCaches.old;
  resubscribe();
  await service.scanEvents();
  const app = {
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { resolvedLinks: { 'Projects/Q4.md': { [path]: 1 }, [link.dailyPath]: { [path]: 1 } } },
  } as unknown as App;
  const [facts] = await new EventNoteService(app, store).inspectNotes([path]);
  assert.deepEqual(facts.event, { title: 'FW: Meeting', start, end, allDay: false, sourceId: 'old' });
  assert.deepEqual(facts.references, [
    { path: link.dailyPath, kind: 'daily', line: link.bullet },
    { path: 'Projects/Q4.md', kind: 'link' },
  ]);
  assert.equal(facts.listed, true);
  assert.equal(service.problems[0].kind, 'orphan');
});
