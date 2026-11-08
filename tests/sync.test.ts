import test from "node:test";
import assert from "node:assert/strict";
import { CalendarStore, type StoreIO, type RecoveryJournal } from "../src/store";
import { freshState, type StoredState } from "../src/state";
import { DEFAULT_SETTINGS as BASE_SETTINGS } from "../src/settings";

// These tests assert paths under a flat folder; the default {daily}/{title} is covered in providers-paths.
const DEFAULT_SETTINGS = { ...BASE_SETTINGS, eventPattern: "[Calendar Notes]/{title}" };
import { SourceSyncService } from "../src/sync";
import { SubscriptionService } from "../src/subscriptions";
import { sourceEventId, type CalendarRange } from "../src/ical";
import { EventNoteService } from "../src/events";
import type { App } from "obsidian";
import type { CalendarEvent, CalendarSource } from "../src/types";
import { historyForReview } from "../src/history";

class MemoryIO implements StoreIO {
  files = new Map<string, string>();
  data: StoredState | null = null;
  journal: RecoveryJournal | null = null;
  async read(path: string) { return this.files.get(path) ?? null; }
  async write(path: string, before: string | null, after: string | null) {
    assert.equal(await this.read(path), before);
    if (after === null) this.files.delete(path); else this.files.set(path, after);
  }
  async listMarkdown() { return [...this.files.keys()]; }
  async loadData() { return this.data ? structuredClone(this.data) : null; }
  async saveData(data: StoredState) { this.data = structuredClone(data); }
  async loadJournal() { return this.journal ? structuredClone(this.journal) : null; }
  async saveJournal(journal: RecoveryJournal) { this.journal = structuredClone(journal); }
  async clearJournal() { this.journal = null; }
}

const source: CalendarSource = { id: "work", name: "Work", url: "webcal://example.test/private/calendar", color: "#123456", enabled: true };
const range: CalendarRange = { start: "2026-10-20T00:00:00Z", end: "2026-10-30T00:00:00Z" };
const at = (day: number) => `2026-10-${day}T10:00:00+08:00`;
const until = (day: number) => `2026-10-${day}T11:00:00+08:00`;
const event = (day: number, sequence = 0): CalendarEvent => ({
  id: sourceEventId("work", "uid"), sourceId: "work", uid: "uid", title: "Meeting",
  start: at(day), end: until(day), allDay: false, status: "active", sequence,
});
const raw = (day: number, sequence = 0) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:uid\r\nSUMMARY:Meeting\r\nDTSTART;TZID=Asia/Taipei:202610${day}T100000\r\nDTEND;TZID=Asia/Taipei:202610${day}T110000\r\nSEQUENCE:${sequence}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

function setup(sources = [source]) {
  const io = new MemoryIO();
  const store = new CalendarStore(io, freshState({ ...DEFAULT_SETTINGS, sources }));
  let failPlan = false;
  const notes = {
    updateLinkedInterval: async (incoming: CalendarEvent) => {
      if (failPlan) throw new Error("Edited tracked bullet");
      return {
        writes: [], event: incoming,
        link: store.state.noteLinks[incoming.id],
      };
    },
  } as unknown as EventNoteService;
  const sync = new SourceSyncService(store, notes);
  return { io, store, sync, setFail: (value: boolean) => { failPlan = value; } };
}

test("baseline and identical times create no row; older SEQUENCE is rejected", async () => {
  const { store, sync } = setup();
  await sync.accept(source, [event(22, 1)], range);
  assert.equal(store.state.history.length, 0);
  await sync.accept(source, [event(22, 2)], range);
  assert.equal(store.state.history.length, 0);
  assert.equal(store.state.sourceCaches.work.accepted[event(22).id].event.sequence, 2);
  await sync.accept(source, [event(23, 1)], range);
  assert.equal(store.state.sourceCaches.work.accepted[event(22).id].event.start, at(22));
  await sync.accept(source, [event(23, 3)], range);
  assert.equal(store.state.history.length, 1);
  assert.equal(store.state.history[0].status, "applied");
  assert.equal(store.state.history[0].beforeSource?.start, at(22));
});

test("changing display offset for the same instant does not invent a source-time revision", async () => {
  const { store, sync } = setup();
  await sync.accept(source, [event(22)], range);
  await sync.accept(source, [{
    ...event(22), start: "2026-10-22T02:00:00Z", end: "2026-10-22T03:00:00Z",
  }], range);
  assert.equal(store.state.history.length, 0);
  assert.equal(store.state.sourceCaches.work.accepted[event(22).id].event.start, "2026-10-22T02:00:00Z");
});

test("failed revision retries same row; newer revisions supersede it, including A→C→A→B", async () => {
  const { store, sync, setFail, io } = setup();
  await sync.accept(source, [event(22)], range);
  store.state.noteLinks[event(22).id] = { eventPath: "Event.md", dailyPath: "Daily.md", bullet: "- link" };
  await store.commit([], () => undefined);
  setFail(true);
  await sync.accept(source, [event(23)], range);
  const failed = store.state.history[0];
  assert.equal(failed.status, "needs_attention");
  assert.equal(store.state.sourceCaches.work.accepted[event(22).id].event.start, at(22));
  await sync.accept(source, [event(23)], range);
  assert.equal(store.state.history.length, 1);
  assert.equal(store.state.history[0].id, failed.id);
  setFail(false);
  await sync.accept(source, [event(24)], range);
  assert.equal(store.state.history[0].status, "superseded");
  await sync.accept(source, [event(22)], range);
  await sync.accept(source, [event(23)], range);
  assert.equal(store.state.history.length, 4);
  assert.notEqual(store.state.history[3].id, failed.id);
  assert.equal(await sync.retry(failed.id), false);
  await sync.markReviewed(failed.id);
  assert.equal(historyForReview(store.state.history).some(row => row.id === failed.id), false);
  const restarted = new CalendarStore(io, freshState(DEFAULT_SETTINGS));
  await restarted.recover();
  assert.equal(restarted.state.history[0].status, "superseded");
  assert.equal(restarted.state.history[3].afterSource?.start, at(23));
});

test("a slow linked update cannot overwrite a newer accepted source revision", async () => {
  const io = new MemoryIO();
  const store = new CalendarStore(io, freshState({ ...DEFAULT_SETTINGS, sources: [source] }));
  let release!: () => void;
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const notes = {
    updateLinkedInterval: async (incoming: CalendarEvent) => {
      if (incoming.start === at(23)) { started(); await gate; }
      return { writes: [], event: incoming, link: store.state.noteLinks[incoming.id] };
    },
  } as unknown as EventNoteService;
  const sync = new SourceSyncService(store, notes);
  await sync.accept(source, [event(22)], range);
  await store.commit([], state => {
    state.noteLinks[event(22).id] = { eventPath: "Event.md", dailyPath: "Daily.md", bullet: "- linked" };
  });
  const older = sync.accept(source, [event(23)], range);
  await requested;
  await sync.accept(source, [event(24)], range);
  release();
  await older;
  assert.equal(store.state.sourceCaches.work.accepted[event(22).id].event.start, at(24));
  assert.equal(store.state.history.length, 1);
  assert.equal(store.state.history[0].afterSource?.start, at(24));
});

test("Use latest source times aborts if the accepted revision or local override changes during planning", async () => {
  for (const change of ["source", "override"] as const) {
    const io = new MemoryIO();
    const store = new CalendarStore(io, freshState({ ...DEFAULT_SETTINGS, sources: [source] }));
    let release!: () => void;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const notes = {
      updateLinkedInterval: async (incoming: CalendarEvent) => {
        started();
        await gate;
        return { writes: [], event: incoming };
      },
    } as unknown as EventNoteService;
    const sync = new SourceSyncService(store, notes);
    await sync.accept(source, [event(22)], range);
    await store.commit([], state => {
      state.overrides[event(22).id] = { start: at(25), end: until(25) };
    });
    const resolution = sync.useLatestSourceTimes(event(22).id);
    await requested;
    if (change === "source") await sync.accept(source, [event(23)], range);
    else await store.commit([], state => {
      state.overrides[event(22).id] = { start: at(26), end: until(26) };
    });
    release();
    assert.equal(await resolution, false, change);
    assert.equal(store.state.overrides[event(22).id].start, change === "source" ? at(25) : at(26));
    assert.equal(store.state.history.some(row => row.status === "resolved"), false);
  }
});

test("a local override remains effective until the source-times resolution", async () => {
  const { store, sync } = setup();
  await sync.accept(source, [event(22)], range);
  await store.commit([], state => {
    state.overrides[event(22).id] = { start: at(25), end: until(25) };
  });
  await sync.accept(source, [event(23)], range);
  assert.equal(store.state.history[0].status, "local_override");
  assert.equal(store.state.history[0].beforeEffective?.start, at(25));
  assert.equal(store.state.history[0].afterEffective?.start, at(25));
  assert.equal(sync.effectiveEvent(event(23)).start, at(25));
  assert.equal(await sync.useLatestSourceTimes(event(23).id), true);
  assert.equal(sync.effectiveEvent(event(23)).start, at(23));
  assert.equal(store.state.history[1].resolution, "source_times");
});

test("missing UID becomes removal attention and never reuses a different UID's note", async () => {
  const { store, sync } = setup();
  const first = event(22);
  await sync.accept(source, [first], range);
  store.state.noteLinks[first.id] = { eventPath: "Original.md", dailyPath: "Daily.md", bullet: "- original" };
  const replacement = { ...event(23), id: sourceEventId("work", "different-uid"), uid: "different-uid" };
  await sync.accept(source, [replacement], range);
  assert.equal(store.state.history.length, 1);
  assert.equal(store.state.history[0].status, "removal_attention");
  assert.equal(store.state.noteLinks[first.id].eventPath, "Original.md");
  assert.equal(store.state.noteLinks[replacement.id], undefined);
  assert.equal(store.state.sourceCaches.work.accepted[replacement.id].revision, 0);
});

test("blank sources do not fetch; one failed source retains cache while another succeeds", async () => {
  const blank: CalendarSource = { ...source, id: "blank", url: "" };
  const broken: CalendarSource = { ...source, id: "broken", url: "https://example.test/broken" };
  const { store, sync } = setup([blank, broken, source]);
  const calls: string[] = [];
  const subscriptions = new SubscriptionService(store, sync, async (url, headers) => {
    calls.push(url);
    if (url.includes("broken")) throw new Error("secret=https://private.test/token");
    if (headers["If-None-Match"]) return { status: 304 };
    return { status: 200, text: raw(22), headers: { ETag: "\"revision-1\"" } };
  });
  await subscriptions.refresh(range, { force: true });
  assert.equal(calls.length, 2);
  assert.equal(store.state.sourceCaches.blank, undefined);
  assert.match(store.state.sourceCaches.broken.error!, /Cached events/);
  assert.doesNotMatch(store.state.sourceCaches.broken.error!, /private|token/);
  assert.equal(subscriptions.getEvents(range).length, 1);
  await subscriptions.refresh(range, { force: true });
  assert.equal(calls.length, 4);
  assert.equal(store.state.sourceCaches.work.etag, "\"revision-1\"");
  assert.equal(store.state.sourceCaches.work.failures, 0);
});

test("invalid feed leaves last accepted event and raw cache intact", async () => {
  const { store, sync } = setup();
  let body = raw(22);
  const subscriptions = new SubscriptionService(store, sync, async () => ({ status: 200, text: body }));
  await subscriptions.refresh(range, { force: true });
  const validRaw = store.state.sourceCaches.work.raw;
  body = "<html>login</html>";
  await subscriptions.refresh(range, { force: true });
  assert.equal(store.state.sourceCaches.work.raw, validRaw);
  assert.equal(subscriptions.getEvents(range)[0].start, at(22));
  assert.match(store.state.sourceCaches.work.error!, /valid iCalendar/);
});

test("BOM feed accepts a timed point and normal event; removing the boundary point is reconciled", async () => {
  const { store, sync } = setup();
  const point = `BEGIN:VEVENT\r\nUID:point\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261020T000000Z\r\nEND:VEVENT\r\n`;
  const atEnd = `BEGIN:VEVENT\r\nUID:at-end\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261030T000000Z\r\nEND:VEVENT\r\n`;
  const normal = `BEGIN:VEVENT\r\nUID:normal\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261022T100000Z\r\nDTEND:20261022T110000Z\r\nEND:VEVENT\r\n`;
  const feed = (includePoint: boolean) => `\uFEFFBEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Calendar-Note tests//EN\r\n${includePoint ? point : ""}${atEnd}${normal}END:VCALENDAR\r\n`;
  let body = feed(true);
  const subscriptions = new SubscriptionService(store, sync, async () => ({ status: 200, text: body }));
  await subscriptions.refresh(range, { force: true });
  const pointId = sourceEventId("work", "point");
  assert.equal(store.state.sourceCaches.work.error, undefined);
  assert.equal(store.state.sourceCaches.work.raw, body);
  assert.equal(store.state.sourceCaches.work.accepted[pointId].event.start,
    store.state.sourceCaches.work.accepted[pointId].event.end);
  assert.deepEqual(subscriptions.getEvents(range).map(event => event.uid), ["point", "normal"]);
  assert.equal(store.state.sourceCaches.work.accepted[sourceEventId("work", "at-end")], undefined);

  body = feed(false);
  await subscriptions.refresh(range, { force: true });
  assert.equal(store.state.sourceCaches.work.accepted[pointId].event.status, "removed");
  assert.equal(store.state.history.find(entry => entry.eventId === pointId)?.status, "removal_attention");
});

test("changing an endpoint does not send the prior feed's conditional validator", async () => {
  const { store, sync } = setup();
  const headersSeen: Record<string, string>[] = [];
  const subscriptions = new SubscriptionService(store, sync, async (_url, headers) => {
    headersSeen.push(headers);
    return { status: 200, text: raw(22), headers: { ETag: "\"private-validator\"" } };
  });
  await subscriptions.refresh(range, { force: true });
  await store.commit([], state => { state.settings.sources[0].url = "https://other.test/calendar"; });
  await subscriptions.refresh(range, { force: true });
  assert.equal(headersSeen[0]["If-None-Match"], undefined);
  assert.equal(headersSeen[1]["If-None-Match"], undefined);
  assert.equal(store.state.sourceCaches.work.etag, "\"private-validator\"");
});

test("setRange does not reparse raw data cached for a different endpoint", async () => {
  const { store, sync } = setup();
  const subscriptions = new SubscriptionService(store, sync, async () => ({
    status: 200, text: raw(22), headers: { ETag: "\"old\"" },
  }));
  await subscriptions.refresh(range, { force: true });
  await sync.accept(source, [event(24, 1)], range);
  assert.equal(store.state.history.length, 1);
  await store.commit([], state => { state.settings.sources[0].url = "https://new.test/calendar"; });
  const replacement = new SubscriptionService(store, sync, async () => { throw new Error("setRange must not fetch"); });
  await replacement.setRange(range);
  assert.equal(store.state.sourceCaches.work.accepted[event(22).id].event.start, at(24));
  assert.equal(store.state.history.length, 1);
  assert.equal(store.state.sourceCaches.work.raw, raw(22));
});

test("normal refresh honors the interval and backoff while force and endpoint changes can fetch", async () => {
  const { store, sync } = setup();
  let calls = 0;
  const subscriptions = new SubscriptionService(store, sync, async () => {
    calls++;
    return { status: 200, text: raw(22) };
  });
  await subscriptions.refresh(range, { force: true });
  await subscriptions.refresh(range);
  assert.equal(calls, 1);
  await subscriptions.refresh(range, { force: true });
  assert.equal(calls, 2);
  await store.commit([], state => { state.settings.sources[0].url = "https://new.test/calendar"; });
  await subscriptions.refresh(range);
  assert.equal(calls, 3);

  const failing = setup();
  let attempts = 0;
  const failedSource = new SubscriptionService(failing.store, failing.sync, async () => {
    attempts++;
    throw new Error("offline");
  });
  await failedSource.refresh(range, { force: true });
  await failedSource.refresh(range);
  assert.equal(attempts, 1);
  await failing.store.commit([], state => { state.settings.sources[0].url = "https://new.test/calendar"; });
  await failedSource.refresh(range);
  assert.equal(attempts, 2);
});

test("an in-flight response is discarded after its source URL changes, is disabled, or is removed", async () => {
  for (const change of ["url", "disabled", "removed"] as const) {
    const { store, sync } = setup();
    let release!: (response: { status: number; text: string; headers: Record<string, string> }) => void;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<{ status: number; text: string; headers: Record<string, string> }>(resolve => { release = resolve; });
    const subscriptions = new SubscriptionService(store, sync, async () => {
      started();
      return response;
    });
    const pending = subscriptions.refresh(range, { force: true });
    await requested;
    await store.commit([], state => {
      if (change === "url") state.settings.sources[0].url = "https://new.test/calendar";
      if (change === "disabled") state.settings.sources[0].enabled = false;
      if (change === "removed") state.settings.sources = [];
    });
    release({ status: 200, text: raw(23, 1), headers: { ETag: "\"old-endpoint\"" } });
    await pending;
    assert.equal(store.state.sourceCaches.work, undefined, change);
    assert.equal(store.state.history.length, 0, change);
  }
});

test("disposing a service prevents its old request from overwriting a new service's cache", async () => {
  const { store, sync } = setup();
  let release!: (response: { status: number; text: string; headers: Record<string, string> }) => void;
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<{ status: number; text: string; headers: Record<string, string> }>(resolve => { release = resolve; });
  const oldService = new SubscriptionService(store, sync, async () => {
    started();
    return response;
  });
  const pending = oldService.refresh(range, { force: true });
  await requested;
  oldService.dispose();
  const newService = new SubscriptionService(store, sync, async () => ({
    status: 200, text: raw(24, 2), headers: { ETag: "\"new-service\"" },
  }));
  await newService.refresh(range, { force: true });
  release({ status: 200, text: raw(23, 1), headers: { ETag: "\"old-service\"" } });
  await pending;
  assert.equal(store.state.sourceCaches.work.raw, raw(24, 2));
  assert.equal(store.state.sourceCaches.work.etag, "\"new-service\"");
  assert.equal(store.state.sourceCaches.work.accepted[event(24).id].event.start, at(24));
  assert.equal(store.state.history.length, 0);
});

test("source replacement during note planning cannot apply the old endpoint's event", async () => {
  const io = new MemoryIO();
  const store = new CalendarStore(io, freshState({ ...DEFAULT_SETTINGS, sources: [source] }));
  let release!: () => void;
  let started!: () => void;
  const planning = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const notes = {
    updateLinkedInterval: async (incoming: CalendarEvent) => {
      started();
      await gate;
      return { writes: [], event: incoming, link: store.state.noteLinks[incoming.id] };
    },
  } as unknown as EventNoteService;
  const sync = new SourceSyncService(store, notes);
  await sync.accept(source, [event(22)], range);
  await store.commit([], state => {
    state.noteLinks[event(22).id] = { eventPath: "Event.md", dailyPath: "Daily.md", bullet: "- linked" };
  });
  const subscriptions = new SubscriptionService(store, sync, async () => ({ status: 200, text: raw(23, 1) }));
  const pending = subscriptions.refresh(range, { force: true });
  await planning;
  await store.commit([], state => { state.settings.sources[0].url = "https://new.test/calendar"; });
  subscriptions.dispose();
  release();
  await pending;
  assert.equal(store.state.sourceCaches.work.accepted[event(22).id].event.start, at(22));
  assert.equal(store.state.history.length, 0);
});

test("a linked source move updates managed note times and relocates its tracked Daily bullet", async () => {
  const io = new MemoryIO();
  const store = new CalendarStore(io, freshState({ ...DEFAULT_SETTINGS, sources: [source] }));
  const app = {
    vault: { getAbstractFileByPath: (path: string) => io.files.has(path) ? { path, extension: "md" } : null },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
  } as unknown as App;
  const notes = new EventNoteService(app, store);
  const sync = new SourceSyncService(store, notes);
  const first = event(22);
  await sync.accept(source, [first], range);
  await notes.openEvent(first);
  const before = store.state.noteLinks[first.id];
  io.files.set(before.eventPath, io.files.get(before.eventPath)! + "\nUser body survives.\n");
  io.files.set(before.dailyPath, io.files.get(before.dailyPath)! + "\nJournal survives.\n");
  await sync.accept(source, [event(23, 1)], range);
  const after = store.state.noteLinks[first.id];
  assert.equal(after.eventPath, before.eventPath);
  assert.notEqual(after.dailyPath, before.dailyPath);
  assert.match(io.files.get(after.eventPath)!, /2026-10-23T10:00:00\+08:00/);
  assert.match(io.files.get(after.eventPath)!, /User body survives/);
  assert.match(io.files.get(before.dailyPath)!, /Journal survives/);
  assert.doesNotMatch(io.files.get(before.dailyPath)!, /\[\[Calendar Notes\/Meeting/);
  assert.match(io.files.get(after.dailyPath)!, /\[\[Calendar Notes\/Meeting/);
  assert.equal(store.state.history[0].afterDailyPath, after.dailyPath);
});

test("an edited tracked bullet leaves a retryable row and keeps the accepted note intact", async () => {
  const io = new MemoryIO();
  const store = new CalendarStore(io, freshState({ ...DEFAULT_SETTINGS, sources: [source] }));
  const app = {
    vault: { getAbstractFileByPath: (path: string) => io.files.has(path) ? { path, extension: "md" } : null },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
  } as unknown as App;
  const notes = new EventNoteService(app, store);
  const sync = new SourceSyncService(store, notes);
  const first = event(22);
  await sync.accept(source, [first], range);
  await notes.openEvent(first);
  const link = store.state.noteLinks[first.id];
  io.files.set(link.dailyPath, io.files.get(link.dailyPath)!.replace(link.bullet, "- Edited by user"));
  await sync.accept(source, [event(23, 1)], range);
  const row = store.state.history[0];
  assert.equal(row.status, "needs_attention");
  assert.equal(store.state.sourceCaches.work.accepted[first.id].event.start, at(22));
  assert.match(io.files.get(link.eventPath)!, /2026-10-22T10:00:00\+08:00/);
  assert.equal(await sync.retry(row.id), false);
  io.files.set(link.dailyPath, io.files.get(link.dailyPath)!.replace("- Edited by user", link.bullet));
  assert.equal(await sync.retry(row.id), true);
  assert.equal(store.state.history.length, 1);
  assert.equal(store.state.history[0].status, "applied");
  assert.equal(store.state.history[0].afterEffective?.start, at(23));
  assert.equal(store.state.sourceCaches.work.accepted[first.id].event.start, at(23));
});
