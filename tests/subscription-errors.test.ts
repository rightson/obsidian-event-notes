import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/settings';
import { freshState } from '../src/state';
import { emptySourceCache, safeSourceError } from '../src/history';
import { ICalError, ICalParser } from '../src/ical';
import { SubscriptionService, type RequestResponse } from '../src/subscriptions';
import { safeSubscriptionError, subscriptionFailureMessage, subscriptionStatus } from '../src/subscription-settings';
import type { CalendarStore } from '../src/store';
import type { SourceSyncService } from '../src/sync';
import type { CalendarSource } from '../src/types';

const source: CalendarSource = {
  id: 'feed', name: 'Feed', url: 'https://example.test/private/calendar.ics', color: '#123456', enabled: true,
};
const range = { start: '2026-10-20T00:00:00Z', end: '2026-10-30T00:00:00Z' };
const valid = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event\r\nDTSTART:20261022T100000Z\r\nDTEND:20261022T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

function harness(
  request: () => Promise<RequestResponse>,
  accept: () => Promise<void> = async () => undefined,
  parser?: ICalParser,
) {
  const state = freshState({ ...DEFAULT_SETTINGS, sources: [source] });
  const store = {
    state,
    commit: async (_writes: unknown, mutate: (next: typeof state) => void) => { mutate(state); },
  } as unknown as CalendarStore;
  const sync = { accept } as unknown as SourceSyncService;
  const service = new SubscriptionService(store, sync, request, parser);
  return { state, service, store };
}

test('valid feed followed by a sync failure retains prior success and reports application failure', async () => {
  let fail = false;
  let body = valid;
  const { state, service } = harness(async () => ({ status: 200, text: body }), async () => {
    if (fail) throw new Error('private URL and title from a write failure');
  });
  await service.refresh(range, { force: true });
  state.sourceCaches.feed.lastSuccess = '2026-01-01T00:00:00.000Z';
  const firstSuccess = state.sourceCaches.feed.lastSuccess;
  const firstRaw = state.sourceCaches.feed.raw;
  fail = true;
  body = valid.replace('UID:event', 'UID:changed');
  await service.refresh(range, { force: true });
  assert.equal(state.sourceCaches.feed.error, safeSourceError('sync'));
  assert.equal(state.sourceCaches.feed.lastSuccess, firstSuccess);
  assert.equal(state.sourceCaches.feed.raw, firstRaw);
  assert.doesNotMatch(state.sourceCaches.feed.error!, /private|title/i);
  fail = false;
  await service.refresh(range, { force: true });
  assert.equal(state.sourceCaches.feed.error, undefined);
  assert.equal(state.sourceCaches.feed.failures, 0);
  assert.equal(state.sourceCaches.feed.retryAfter, undefined);
  assert.equal(state.sourceCaches.feed.raw, body);
});

test('a failed cache write does not mark the fetched feed successful', async () => {
  let body = valid;
  const { state, service, store } = harness(async () => ({ status: 200, text: body }));
  await service.refresh(range, { force: true });
  state.sourceCaches.feed.lastSuccess = '2026-01-01T00:00:00.000Z';
  const firstSuccess = state.sourceCaches.feed.lastSuccess;
  const firstRaw = state.sourceCaches.feed.raw;
  const commit = store.commit.bind(store);
  let failNext = true;
  body = valid.replace('UID:event', 'UID:changed');
  store.commit = async (writes, mutate) => {
    if (failNext) {
      failNext = false;
      throw new Error('private cache write detail');
    }
    await commit(writes, mutate);
  };
  await service.refresh(range, { force: true });
  assert.equal(state.sourceCaches.feed.error, safeSourceError('cache'));
  assert.equal(state.sourceCaches.feed.lastSuccess, firstSuccess);
  assert.equal(state.sourceCaches.feed.raw, firstRaw);
});

test('an unavailable status store surfaces the original safe reason', async () => {
  const invalidDate = valid.replace('20261022T100000Z', 'bad');
  const { service, store } = harness(async () => ({ status: 200, text: invalidDate }));
  store.commit = async () => { throw new Error('private URL and raw persistence detail'); };
  await assert.rejects(service.refresh(range, { force: true }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, safeSourceError('parse', 'invalid-syntax'));
    assert.doesNotMatch(error.message, /private|URL|raw persistence/i);
    return true;
  });
});

test('raw parser exceptions, typed parser reasons, and cache reparses stay in parser stage', async () => {
  const invalidDate = valid.replace('20261022T100000Z', 'bad');
  const malformed = harness(async () => ({ status: 200, text: invalidDate }));
  await malformed.service.refresh(range, { force: true });
  assert.equal(malformed.state.sourceCaches.feed.error, safeSourceError('parse', 'invalid-syntax'));

  const limitParser = { parse: () => { throw new ICalError('limit', 'secret', 'recurrence-limit'); } } as unknown as ICalParser;
  const limited = harness(async () => ({ status: 200, text: valid }), undefined, limitParser);
  await limited.service.refresh(range, { force: true });
  assert.equal(limited.state.sourceCaches.feed.error, safeSourceError('parse', 'recurrence-limit'));

  const cached = harness(async () => ({ status: 200, text: valid }));
  await cached.service.refresh(range, { force: true });
  const brokenCachedParser = new SubscriptionService(cached.store,
    { accept: async () => undefined } as unknown as SourceSyncService,
    async () => { throw new Error('setRange must use cache'); },
    { parse: () => { throw new TypeError('private parser detail'); } } as unknown as ICalParser);
  await brokenCachedParser.setRange(range);
  assert.equal(cached.state.sourceCaches.feed.error, safeSourceError('parse', 'invalid-syntax'));
});

test('HTTP, empty, HTML, and non-calendar responses get distinct safe reasons', async () => {
  for (const status of [401, 404, 500]) {
    const { state, service } = harness(async () => ({ status, text: 'private body' }));
    await service.refresh(range, { force: true });
    assert.equal(state.sourceCaches.feed.error, safeSourceError('http', status));
    assert.equal(state.sourceCaches.feed.raw, undefined);
  }
  for (const [response, kind] of [
    [{ status: 200, text: '' }, 'empty'],
    [{ status: 200, text: '<html>login</html>' }, 'html'],
    [{ status: 200, text: `<html><pre>${valid}</pre></html>` }, 'html'],
    [{ status: 200, text: 'please log in', headers: { 'Content-Type': 'text/html; charset=utf-8' } }, 'html'],
    [{ status: 200, text: 'unrelated content' }, 'non-ical'],
  ] as const) {
    const { state, service } = harness(async () => response);
    await service.refresh(range, { force: true });
    assert.equal(state.sourceCaches.feed.error, safeSourceError(kind));
    assert.equal(state.sourceCaches.feed.raw, undefined);
  }

  const mislabeled = harness(async () => ({ status: 200, text: valid, headers: { 'Content-Type': 'text/html' } }));
  await mislabeled.service.refresh(range, { force: true });
  assert.equal(mislabeled.state.sourceCaches.feed.error, undefined);
  assert.equal(mislabeled.state.sourceCaches.feed.raw, valid);
});

test('304 without a cached feed is a cache failure rather than a parser failure', async () => {
  const { state, service } = harness(async () => ({ status: 304 }));
  await service.refresh(range, { force: true });
  assert.equal(state.sourceCaches.feed.error, safeSourceError('cache-missing'));
});

test('stored reasons are allowlisted before settings or banner display', () => {
  const cache = emptySourceCache();
  cache.error = safeSourceError('parse', 'missing-event-uid');
  assert.equal(safeSubscriptionError(cache.error), cache.error);
  assert.match(subscriptionStatus(source, cache, 0), /no UID/);
  assert.match(subscriptionFailureMessage({ ...DEFAULT_SETTINGS, sources: [source] }, { feed: cache })!, /no UID/);
  cache.error = 'https://example.test/private?token=secret';
  assert.equal(safeSubscriptionError(cache.error), safeSourceError('fetch'));
  assert.doesNotMatch(subscriptionStatus(source, cache, 0), /example|token|secret/);
  assert.doesNotMatch(subscriptionFailureMessage({ ...DEFAULT_SETTINGS, sources: [source] }, { feed: cache })!, /example|token|secret/);
});
