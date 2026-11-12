import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/settings';
import { freshState } from '../src/state';
import { safeSourceError } from '../src/history';
import { SubscriptionService, type RequestResponse } from '../src/subscriptions';
import { SyncProgress, type SyncProgressView, type SyncReporter, type SyncStep } from '../src/sync-progress';
import type { CalendarStore } from '../src/store';
import type { SourceSyncService } from '../src/sync';
import type { CalendarSource } from '../src/types';

const a = { id: 'a', name: 'Work' };
const b = { id: 'b', name: 'Holidays' };
const range = { start: '2026-10-20T00:00:00Z', end: '2026-10-30T00:00:00Z' };
const valid = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event\r\nDTSTART:20261022T100000Z\r\nDTEND:20261022T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

function tracker(sources = [a]) {
  const views: SyncProgressView[] = [];
  return { views, progress: new SyncProgress(sources, view => views.push(view)) };
}

test('success reports each step by name and ends in a success state', () => {
  const { views, progress } = tracker();
  for (const step of ['fetch', 'parse', 'update', 'save'] as const) progress.step(a, step);
  const last = progress.finish();
  assert.deepEqual(views.map(view => view.state), ['running', 'running', 'running', 'running', 'success']);
  assert.match(views[0].text, /“Work”: fetching the feed/);
  assert.match(views[1].text, /reading the events/);
  assert.match(views[2].text, /updating events and notes/);
  assert.match(views[3].text, /saving the result/);
  assert.equal(last.text, 'Event Notes: “Work” is synced.');
});

test('turning a subscription off shows its own step and succeeds', () => {
  const { views, progress } = tracker();
  progress.step(a, 'hide');
  assert.match(views[0].text, /hiding its events/);
  assert.equal(progress.finish().text, 'Event Notes: “Work” is turned off.');
});

for (const [step, phrase] of [['validate', 'checking the feed URL'], ['fetch', 'fetching the feed'], ['parse', 'reading the events'],
  ['update', 'updating events and notes'], ['save', 'saving the result']] as [SyncStep, string][]) {
  test(`a failure at ${step} names the subscription, the step, and the reason, and stays failed`, () => {
    const { views, progress } = tracker();
    const order: SyncStep[] = ['validate', 'fetch', 'parse', 'update', 'save'];
    for (const s of order.slice(order.indexOf(step) === 0 ? 0 : 1, order.indexOf(step) + 1)) progress.step(a, s);
    const reason = safeSourceError('http', 503);
    progress.fail(a, reason);
    assert.equal(views.at(-1)!.state, 'running');
    const last = progress.finish();
    assert.equal(last.state, 'failed');
    assert.ok(last.text.includes('“Work”') && last.text.includes(`failed while ${phrase}: ${reason}`));
  });
}

test('a failure without a started step is reported as the first step', () => {
  const { progress } = tracker();
  progress.fail(a, 'Enter a valid HTTPS or webcal subscription URL.');
  assert.match(progress.finish().text, /failed while checking the feed URL: Enter a valid/);
});

test('one failing source does not hide the others', () => {
  const { views, progress } = tracker([a, b]);
  progress.step(a, 'fetch');
  progress.fail(a, safeSourceError('fetch'));
  progress.step(b, 'fetch');
  assert.match(views.at(-1)!.text, /“Work” failed while fetching the feed/);
  assert.match(views.at(-1)!.text, /“Holidays”: fetching the feed/);
  progress.step(b, 'save');
  const last = progress.finish();
  assert.equal(last.state, 'failed');
  assert.match(last.text, /“Work” failed while fetching the feed/);
  assert.doesNotMatch(last.text, /“Holidays” failed/);
  assert.match(last.text, /1 other calendar finished/);
});

test('every failing source is listed with its own step', () => {
  const { progress } = tracker([a, b]);
  progress.step(a, 'fetch'); progress.fail(a, 'x');
  progress.step(b, 'parse'); progress.fail(b, 'y');
  const text = progress.finish().text;
  assert.match(text, /“Work” failed while fetching the feed: x/);
  assert.match(text, /“Holidays” failed while reading the events: y/);
});

test('a source that never ran is up to date, and the first failure reason wins', () => {
  const { progress } = tracker();
  assert.equal(progress.finish().text, 'Event Notes: “Work” is up to date.');
  const second = tracker();
  second.progress.step(a, 'fetch'); second.progress.fail(a, 'first'); second.progress.fail(a, 'second');
  assert.match(second.progress.finish().text, /first/);
  assert.doesNotMatch(second.progress.finish().text, /second/);
});

test('an unexpected error fails the source in flight, or the run when none started', () => {
  const running = tracker([a, b]);
  running.progress.step(a, 'update');
  running.progress.abort('boom');
  assert.match(running.progress.finish().text, /“Work” failed while updating events and notes: boom/);
  const idle = tracker([a]);
  idle.progress.abort('scan failed');
  const last = idle.progress.finish();
  assert.equal(last.state, 'failed');
  assert.match(last.text, /scan failed/);
});

// --- the real pipeline reports through SubscriptionService.refresh ---

function harness(request: () => Promise<RequestResponse>, sources: CalendarSource[], accept: () => Promise<void> = async () => undefined) {
  const state = freshState({ ...DEFAULT_SETTINGS, sources });
  const store = { state, commit: async (_w: unknown, mutate: (next: typeof state) => void) => { mutate(state); } } as unknown as CalendarStore;
  return new SubscriptionService(store, { accept } as unknown as SourceSyncService, request);
}
const feed = (id: string, name: string, url = `https://example.test/${id}.ics`): CalendarSource => ({ id, name, url, color: '#123456', enabled: true });

function recorder() {
  const events: string[] = [];
  const reporter: SyncReporter = {
    step: (source, step) => { events.push(`${source.id}:${step}`); },
    fail: (source, reason) => { events.push(`${source.id}:fail:${reason}`); },
  };
  return { events, reporter };
}

test('a forced refresh reports the real steps in order', async () => {
  const { events, reporter } = recorder();
  await harness(async () => ({ status: 200, text: valid }), [feed('a', 'Work')]).refresh(range, { force: true, progress: reporter });
  assert.deepEqual(events, ['a:fetch', 'a:parse', 'a:update', 'a:save']);
});

test('a 304 answer reports the cached parse, update and save steps', async () => {
  const service = harness(async () => ({ status: 200, text: valid }), [feed('a', 'Work')]);
  await service.refresh(range, { force: true });
  const { events, reporter } = recorder();
  const cached = harness(async () => ({ status: 304 }), [feed('a', 'Work')]);
  Object.assign(cached.store.state.sourceCaches, service.store.state.sourceCaches);
  await cached.refresh(range, { force: true, progress: reporter });
  assert.deepEqual(events, ['a:fetch', 'a:parse', 'a:update', 'a:save']);
});

test('failures report the step they stopped at with the stored safe reason', async () => {
  const http = recorder();
  await harness(async () => ({ status: 503 }), [feed('a', 'Work')]).refresh(range, { force: true, progress: http.reporter });
  assert.deepEqual(http.events, ['a:fetch', `a:fail:${safeSourceError('http', 503)}`]);

  const parse = recorder();
  await harness(async () => ({ status: 200, text: valid.replace('20261022T100000Z', 'bad') }), [feed('a', 'Work')])
    .refresh(range, { force: true, progress: parse.reporter });
  assert.deepEqual(parse.events, ['a:fetch', 'a:parse', `a:fail:${safeSourceError('parse', 'invalid-syntax')}`]);

  const sync = recorder();
  await harness(async () => ({ status: 200, text: valid }), [feed('a', 'Work')], async () => { throw new Error('private'); })
    .refresh(range, { force: true, progress: sync.reporter });
  assert.deepEqual(sync.events, ['a:fetch', 'a:parse', 'a:update', `a:fail:${safeSourceError('sync')}`]);

  const url = recorder();
  await harness(async () => ({ status: 200, text: valid }), [feed('a', 'Work', 'http://not-https.test/x.ics')])
    .refresh(range, { force: true, progress: url.reporter });
  assert.deepEqual(url.events, ['a:validate', `a:fail:${safeSourceError('url')}`]);
});

test('a failing source does not stop the next one from reporting', async () => {
  const { events, reporter } = recorder();
  await harness(async () => ({ status: 200, text: valid }), [feed('a', 'Work', 'http://bad.test/x.ics'), feed('b', 'Holidays')])
    .refresh(range, { force: true, progress: reporter });
  assert.deepEqual(events, ['a:validate', `a:fail:${safeSourceError('url')}`, 'b:fetch', 'b:parse', 'b:update', 'b:save']);
});

test('without a reporter the refresh behaves as before and reports nothing', async () => {
  const service = harness(async () => ({ status: 200, text: valid }), [feed('a', 'Work')]);
  await service.refresh(range, { force: true });
  assert.equal(service.store.state.sourceCaches.a.raw, valid);
  assert.equal(service.store.state.sourceCaches.a.error, undefined);
});
