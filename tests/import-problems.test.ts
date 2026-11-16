import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/settings';
import { freshState } from '../src/state';
import { emptySourceCache, safeSourceError } from '../src/history';
import { ICalError, parseICalendar, parseICalendarDetailed } from '../src/ical';
import { SubscriptionService, type RequestResponse } from '../src/subscriptions';
import { importReportText, importReports, skippedCount } from '../src/import-problems';
import { subscriptionStatus } from '../src/subscription-settings';
import type { CalendarStore } from '../src/store';
import type { SourceSyncService } from '../src/sync';
import type { CalendarEvent, CalendarSource } from '../src/types';

const range = { start: '2026-03-07T00:00:00Z', end: '2026-03-15T00:00:00Z' };
const feed = (...events: string[]) => `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Event Notes tests//EN
${events.map(event => event.trim()).join('\n')}
END:VCALENDAR
`.replace(/\n/g, '\r\n');
const event = (uid: string, lines: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260301T000000Z\n${lines.trim()}\nEND:VEVENT`;
const good = event('good', 'SUMMARY:Good\nDTSTART:20260310T090000Z\nDTEND:20260310T100000Z');
const reversed = event('reversed', 'SUMMARY:Ends before it starts\nDTSTART;TZID=Asia/Taipei:20260311T120000\nDTEND;TZID=Asia/Taipei:20260311T110000');

test('an event with an invalid interval is skipped and described; the rest of the feed is imported', () => {
  const raw = feed(good, reversed);
  assert.throws(() => parseICalendar(raw, 'x', range, 'UTC'), ICalError);
  const { events, skipped } = parseICalendarDetailed(raw, 'x', range, 'UTC');
  assert.deepEqual(events.map(item => item.uid), ['good']);
  assert.deepEqual(skipped, [{
    code: 'invalid-event-interval', uid: 'reversed', title: 'Ends before it starts',
    start: '2026-03-11T12:00:00 (Asia/Taipei)', end: '2026-03-11T11:00:00 (Asia/Taipei)',
  }]);
});

test('each kind of invalid event is skipped by itself', () => {
  const raw = feed(
    good,
    event('zone', 'SUMMARY:Zone\nDTSTART;TZID=Nowhere/Unknown:20260310T090000'),
    event('twice', 'SUMMARY:First\nDTSTART:20260310T090000Z'),
    event('twice', 'SUMMARY:Second\nDTSTART:20260311T090000Z'),
    event('no-start', 'SUMMARY:No start'),
    'BEGIN:VEVENT\nSUMMARY:No UID\nDTSTART:20260310T090000Z\nEND:VEVENT',
    event('all-day', 'SUMMARY:Zero days\nDTSTART;VALUE=DATE:20260310\nDTEND;VALUE=DATE:20260310'),
  );
  const { events, skipped } = parseICalendarDetailed(raw, 'x', range, 'UTC');
  assert.deepEqual(events.map(item => item.uid), ['good']);
  assert.deepEqual(skipped.map(item => [item.uid, item.code]).sort(), [
    ['all-day', 'invalid-event-interval'], ['no-start', 'missing-event-start'], ['twice', 'duplicate-event-uid'],
    ['zone', 'invalid-time-zone'], [undefined, 'missing-event-uid'],
  ].sort());
});

test('an invalid occurrence leaves out its whole series, never half of it', () => {
  const series = event('series', 'SUMMARY:Daily\nDTSTART:20260308T090000Z\nDTEND:20260308T100000Z\nRRULE:FREQ=DAILY;COUNT=4');
  const broken = event('series', 'SUMMARY:Broken day\nRECURRENCE-ID:20260310T090000Z\nDTSTART:20260310T120000Z\nDTEND:20260310T110000Z');
  const { events, skipped } = parseICalendarDetailed(feed(good, series, broken), 'x', range, 'UTC');
  assert.deepEqual(events.map(item => item.uid), ['good']);
  assert.equal(skipped.length, 1);
  assert.deepEqual([skipped[0].uid, skipped[0].title, skipped[0].code, skipped[0].recurrenceId],
    ['series', 'Broken day', 'invalid-event-interval', '2026-03-10T09:00:00Z']);
});

test('an event ical.js cannot parse is skipped; a feed broken outside its events still fails', () => {
  const badDate = event('bad-date', 'SUMMARY:Bad date\nDTSTART:not-a-date');
  const badLine = event('bad-line', 'SUMMARY:Bad\\, line\nDTSTART;TZID=Asia/Taipei:20260310T090000\nGARBAGE');
  const { events, skipped } = parseICalendarDetailed(feed(badLine, good, badDate), 'x', range, 'UTC');
  assert.deepEqual(events.map(item => item.uid), ['good']);
  assert.deepEqual(skipped, [
    { code: 'invalid-syntax', uid: 'bad-line', title: 'Bad, line', start: 'TZID=Asia/Taipei:20260310T090000' },
    { code: 'invalid-syntax', uid: 'bad-date', title: 'Bad date', start: 'not a valid date or time' },
  ]);
  for (const raw of [feed(good).replace('END:VEVENT\r\n', ''), feed(good).replace('VERSION:2.0', 'VERSION')]) {
    assert.throws(() => parseICalendarDetailed(raw, 'x', range, 'UTC'),
      (error: unknown) => error instanceof ICalError && error.code === 'invalid-syntax');
  }
});

const source: CalendarSource = { id: 'feed', name: 'Work', url: 'https://example.test/calendar.ics', color: '#123456', enabled: true };

function harness(request: () => Promise<RequestResponse>) {
  const state = freshState({ ...DEFAULT_SETTINGS, timeZone: 'UTC', sources: [source] });
  const store = {
    state,
    commit: async (_writes: unknown, mutate: (next: typeof state) => void) => { mutate(state); },
  } as unknown as CalendarStore;
  const accepted: CalendarEvent[][] = [];
  const sync = { accept: async (_source: CalendarSource, events: CalendarEvent[]) => { accepted.push(events); } } as unknown as SourceSyncService;
  return { state, accepted, service: new SubscriptionService(store, sync, request) };
}

test('a refresh with a skipped event succeeds, counts it, and reports it', async () => {
  const { state, accepted, service } = harness(async () => ({ status: 200, text: feed(good, reversed) }));
  const outcomes = await service.refresh(range, { force: true });
  assert.deepEqual(outcomes.map(outcome => [outcome.status, outcome.skipped]), [['updated', 1]]);
  assert.equal(state.sourceCaches.feed.error, undefined);
  assert.deepEqual(accepted[0].map(item => item.uid), ['good']);
  const reports = importReports(state.settings, state.sourceCaches, id => service.getSkipped(id));
  assert.equal(skippedCount(reports), 1);
  assert.equal(reports[0].skipped[0].kept, false);
  assert.match(subscriptionStatus(source, state.sourceCaches.feed, 1, 1), /1 event in the current view\. 1 event has invalid data and was skipped\./);
  assert.equal(importReportText(reports), [
    'Work: 1 event has invalid data and was skipped.',
    '- Ends before it starts',
    '  Problem: Its end is not after its start. An iCalendar event has to end after it starts. [invalid-event-interval]',
    '  Start: 2026-03-11T12:00:00 (Asia/Taipei)',
    '  End: 2026-03-11T11:00:00 (Asia/Taipei)',
    '  UID: reversed',
    '  Skipped. Not in the calendar.',
  ].join('\n'));
  // The skipped event's content stays out of the saved state.
  assert.doesNotMatch(JSON.stringify({ ...state.sourceCaches.feed, raw: undefined }), /Ends before it starts/);
});

test('an event that becomes invalid keeps its last valid version instead of being removed', async () => {
  let body = feed(good, reversed.replace('T110000', 'T130000'));
  const { state, accepted, service } = harness(async () => ({ status: 200, text: body }));
  await service.refresh(range, { force: true });
  const valid = accepted[0].find(item => item.uid === 'reversed')!;
  state.sourceCaches.feed.accepted[valid.id] = { event: valid, revision: 0 };
  body = feed(good, reversed);
  await service.refresh(range, { force: true });
  assert.deepEqual(accepted[1].find(item => item.uid === 'reversed'), valid);
  assert.equal(service.getSkipped('feed')[0].kept, true);
  // Reading the cached feed for another range reports the same event.
  await service.setRange(range);
  assert.deepEqual(service.getSkipped('feed').map(item => item.uid), ['reversed']);
});

test('reports list a failed feed next to skipped events, and only for enabled subscriptions', () => {
  const state = freshState({ ...DEFAULT_SETTINGS, sources: [source, { ...source, id: 'off', name: 'Off', enabled: false }] });
  state.sourceCaches.feed = { ...emptySourceCache(), error: safeSourceError('http', 404) };
  const reports = importReports(state.settings, state.sourceCaches, () => []);
  assert.deepEqual(reports, [{ sourceId: 'feed', name: 'Work', skipped: [], error: safeSourceError('http', 404) }]);
  assert.match(importReportText(reports), /^Work: refresh failed\. The calendar server returned HTTP 404\./);
});
