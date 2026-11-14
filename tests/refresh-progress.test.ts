import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/settings';
import { freshState } from '../src/state';
import { safeSourceError } from '../src/history';
import { RefreshTracker, refreshSummary, type RefreshEvent } from '../src/refresh-progress';
import { SubscriptionService, type RequestResponse } from '../src/subscriptions';
import { SettingsUpdateQueue } from '../src/subscription-settings';
import type { CalendarStore } from '../src/store';
import type { SourceSyncService } from '../src/sync';
import type { CalendarSource } from '../src/types';

const feed = (id: string, enabled = true): CalendarSource => ({
  id, name: id.toUpperCase(), url: `https://example.test/${id}.ics`, color: '#123456', enabled,
});
const range = { start: '2026-10-20T00:00:00Z', end: '2026-10-30T00:00:00Z' };
const valid = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event\r\nDTSTART:20261022T100000Z\r\nDTEND:20261022T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const titles = { running: 'Refreshing calendars', failed: 'Calendar refresh failed' };

function harness(sources: CalendarSource[], request: (url: string) => Promise<RequestResponse>, accept: () => Promise<void> = async () => undefined) {
  const state = freshState({ ...DEFAULT_SETTINGS, sources });
  const store = {
    state,
    commit: async (_writes: unknown, mutate: (next: typeof state) => void) => { mutate(state); },
  } as unknown as CalendarStore;
  const service = new SubscriptionService(store, { accept } as unknown as SourceSyncService, (url) => request(url));
  return { state, service, store };
}
const steps = (events: RefreshEvent[], sourceId: string) => events
  .flatMap(event => event.type === 'step' && event.calendar.sourceId === sourceId ? [event.step] : []);

test('a refresh reports every step of each enabled subscription and one outcome', async () => {
  const { service } = harness([feed('a'), feed('off', false), feed('b')], async () => ({ status: 200, text: valid }));
  const events: RefreshEvent[] = [];
  const outcomes = await service.refresh(range, { force: true, onProgress: event => events.push(event) });
  assert.deepEqual(steps(events, 'a'), ['prepare', 'request', 'response', 'parse', 'sync', 'cache']);
  assert.deepEqual(steps(events, 'off'), []);
  assert.deepEqual(outcomes.map(outcome => [outcome.sourceId, outcome.status]), [['a', 'updated'], ['b', 'updated']]);
  const positions = events.flatMap(event => event.type === 'step' && event.step === 'request' ? [[event.calendar.index, event.calendar.total]] : []);
  assert.deepEqual(positions, [[0, 2], [1, 2]]);
  assert.equal(refreshSummary(outcomes), '2 of 2 calendars refreshed.');
});

test('each failure names the step it happened in, with a privacy-safe reason', async () => {
  const cases: [string, RequestResponse | Error, boolean, string, string][] = [
    ['network', new Error('secret host unreachable'), false, 'request', safeSourceError('fetch')],
    ['http', { status: 404, text: 'secret' }, false, 'request', safeSourceError('http', 404)],
    ['html', { status: 200, text: '<html>sign in</html>' }, false, 'response', safeSourceError('html')],
    ['syntax', { status: 200, text: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n' }, false, 'parse', ''],
    ['notes', { status: 200, text: valid }, true, 'sync', safeSourceError('sync')],
  ];
  for (const [label, response, syncFails, step, error] of cases) {
    const { service, state } = harness([feed('a')], async () => {
      if (response instanceof Error) throw response;
      return response;
    }, async () => { if (syncFails) throw new Error('secret note path'); });
    const [outcome] = await service.refresh(range, { force: true });
    assert.equal(outcome.status, 'failed', label);
    assert.equal(outcome.step, step, label);
    assert.equal(outcome.error, state.sourceCaches.a.error, label);
    if (error) assert.equal(outcome.error, error, label);
    assert.doesNotMatch(outcome.error!, /secret/, label);
  }
});

test('turning a subscription on retries it at once; the others keep waiting', async () => {
  let fail = true;
  const requested: string[] = [];
  const { service, state } = harness([feed('a'), feed('b')], async url => {
    requested.push(url);
    return fail ? { status: 500 } : { status: 200, text: valid };
  });
  await service.refresh(range, { force: true });
  assert.ok(state.sourceCaches.a.retryAfter && state.sourceCaches.b.retryAfter);
  fail = false;
  requested.length = 0;
  assert.deepEqual((await service.refresh(range)).map(outcome => outcome.status), ['skipped', 'skipped']);
  assert.deepEqual(requested, []);
  const outcomes = await service.refresh(range, { forceSources: ['b'] });
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['skipped', 'updated']);
  assert.deepEqual(requested, ['https://example.test/b.ics']);
  assert.equal(state.sourceCaches.b.error, undefined);
});

test('an unchanged feed (304) reuses the cached copy and counts as refreshed', async () => {
  let status = 200;
  const { service } = harness([feed('a')], async () => status === 200 ? { status, text: valid, headers: { ETag: '"1"' } } : { status });
  await service.refresh(range, { force: true });
  status = 304;
  const outcomes = await service.refresh(range, { force: true });
  assert.equal(outcomes[0].status, 'unchanged');
  assert.equal(refreshSummary(outcomes), '1 of 1 calendar refreshed.');
});

test('the tracker shows the running step, then a success that can close by itself', () => {
  const tracker = new RefreshTracker(titles);
  assert.equal(tracker.current().detail, 'Starting…');
  assert.equal(tracker.start('scan').detail, 'Scan Event Notes…');
  const calendar = { sourceId: 'b', name: 'Work', index: 1, total: 2 };
  const view = tracker.handle({ type: 'step', step: 'request', calendar })!;
  assert.equal(view.state, 'running');
  assert.equal(view.detail, 'Work (2 of 2): step 2 of 6, Download the feed…');
  assert.ok(view.fraction > 0.5 && view.fraction < 1);
  tracker.handle({ type: 'outcome', outcome: { sourceId: 'b', name: 'Work', status: 'updated' } });
  assert.deepEqual(tracker.finish('2 of 2 calendars refreshed.'), {
    state: 'done', title: '2 of 2 calendars refreshed.', detail: '', fraction: 1, failures: [],
  });
});

test('the tracker keeps a failure open and names the calendar, step, and reason', () => {
  const tracker = new RefreshTracker(titles);
  tracker.handle({ type: 'outcome', outcome: { sourceId: 'a', name: 'Home', status: 'updated' } });
  tracker.handle({ type: 'outcome', outcome: { sourceId: 'b', name: 'Work', status: 'failed', step: 'request', error: safeSourceError('http', 404) } });
  const view = tracker.finish('1 of 2 calendars refreshed.', '1 of 2 calendars refreshed.');
  assert.equal(view.state, 'failed');
  assert.equal(view.title, 'Calendar refresh failed');
  assert.deepEqual(view.failures, ['Work: failed at step 2 of 6, “Download the feed”. The calendar server returned HTTP 404. Cached events remain available.']);
});

test('a thrown error is reported against the step that was running', () => {
  const saving = new RefreshTracker(titles);
  saving.start('settings');
  assert.deepEqual(saving.fail(new Error('Choose an Event Notes folder.')).failures, ['Failed at “Save settings”. Choose an Event Notes folder.']);
  const writing = new RefreshTracker(titles);
  writing.handle({ type: 'step', step: 'cache', calendar: { sourceId: 'a', name: 'Home', index: 0, total: 1 } });
  assert.deepEqual(writing.fail(new Error(safeSourceError('cache'))).failures,
    [`Home: failed at step 6 of 6, “Save the result”. ${safeSourceError('cache')}`]);
});

test('a tracker for one subscription ignores the others', () => {
  const tracker = new RefreshTracker(titles, 'b');
  assert.equal(tracker.handle({ type: 'step', step: 'parse', calendar: { sourceId: 'a', name: 'Home', index: 0, total: 2 } }), undefined);
  assert.equal(tracker.handle({ type: 'outcome', outcome: { sourceId: 'a', name: 'Home', status: 'failed', step: 'parse', error: 'x' } }), undefined);
  const view = tracker.handle({ type: 'step', step: 'parse', calendar: { sourceId: 'b', name: 'Work', index: 1, total: 2 } })!;
  assert.equal(view.detail, 'Work: step 4 of 6, Read the events…');
  assert.equal(tracker.finish('“Work” is up to date.').state, 'done');
});

test('a settings edit hands its refresh options to the save that applies it', async () => {
  let current = { ...DEFAULT_SETTINGS, sources: [feed('a', false)] };
  const seen: (string | undefined)[] = [];
  const queue = new SettingsUpdateQueue<{ forceSources: string[] }>(() => current, async (next, context) => {
    seen.push(context?.forceSources.join());
    current = structuredClone(next);
  });
  await queue.update(next => { next.sources[0].enabled = true; }, undefined, { forceSources: ['a'] });
  await queue.update(next => { next.sources[0].name = 'Renamed'; });
  assert.deepEqual(seen, ['a', undefined]);
});
