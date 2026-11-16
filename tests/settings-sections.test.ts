import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/settings';
import { emptySourceCache } from '../src/history';
import {
  agendaSummary, clickingSummary, diagnosticsSummary, displaySummary, ganttSummary, monthsSummary, notePathsSummary,
  readOpenSections, sourceSectionKey, sourceSummary, startsOpen, subscriptionsSummary, withSectionOpen,
} from '../src/settings-sections';
import type { CalendarSource, PluginSettings } from '../src/types';

const url = 'https://example.test/calendar.ics';
const feed = (id: string, patch: Partial<CalendarSource> = {}): CalendarSource => ({ id, name: id, url, color: '#5885d8', enabled: true, ...patch });
const settings = (patch: Partial<PluginSettings> = {}): PluginSettings => ({ ...DEFAULT_SETTINGS, ...patch });
const failed = { ...emptySourceCache(), error: 'The calendar server returned HTTP 404.' };
const fresh = { ...emptySourceCache(), lastSuccess: '2026-10-23T01:00:00.000Z' };

test('a section starts open when the user left it open or it needs attention', () => {
  assert.equal(startsOpen(false, false), false);
  assert.equal(startsOpen(true, false), true);
  assert.equal(startsOpen(false, true), true);
});

test('remembered open sections survive bad stored data', () => {
  assert.deepEqual(readOpenSections(['paths', 'source:a']), ['paths', 'source:a']);
  assert.deepEqual(readOpenSections(['paths', 3, null, 'paths']), ['paths']);
  for (const bad of [null, undefined, 'paths', { paths: true }, 7]) assert.deepEqual(readOpenSections(bad), []);
});

test('opening and closing a section updates the remembered list and forgets removed calendars', () => {
  assert.deepEqual(withSectionOpen([], 'paths', true, []), ['paths']);
  assert.deepEqual(withSectionOpen(['paths'], 'paths', true, []), ['paths']);
  assert.deepEqual(withSectionOpen(['paths', 'gantt'], 'paths', false, []), ['gantt']);
  assert.deepEqual(withSectionOpen(['source:gone', 'source:a', 'gantt'], sourceSectionKey('b'), true, ['a', 'b']), ['source:a', 'gantt', 'source:b']);
});

test('Note paths shows the Event Note pattern', () => {
  assert.deepEqual(notePathsSummary(settings()), { text: 'Event Notes: {daily}/{title}', attention: false });
});

test('Calendar display shows the time zone, week start, and snap interval', () => {
  assert.equal(displaySummary(settings()).text, 'Asia/Taipei · week starts by locale · 15-minute snap');
  assert.equal(displaySummary(settings({ weekStart: 'monday', snapMinutes: 30, timeZone: 'Europe/Paris' })).text, 'Europe/Paris · week starts Monday · 30-minute snap');
});

test('Clicking shows what an event and an empty slot do', () => {
  assert.equal(clickingSummary(settings()).text, 'Event: details · Empty slot: by view');
  assert.equal(clickingSummary(settings({ eventClickAction: 'tab', mainDateClickAction: 'none' })).text, 'Event: note in new tab · Empty slot: nothing');
  assert.equal(clickingSummary(settings({ eventClickAction: 'split', mainDateClickAction: 'event' })).text, 'Event: note beside · Empty slot: new event');
});

test('Month calendar shows the minimum months and whether it opens at startup', () => {
  assert.equal(monthsSummary(settings()).text, 'At least 3 months · added at startup');
  assert.equal(monthsSummary(settings({ monthsMinimum: 1, monthsOnStartup: false })).text, 'At least 1 month · not added at startup');
});

test('Events sidebar and Gantt show their current choices', () => {
  assert.equal(agendaSummary(settings()).text, 'Keeps the time of day');
  assert.equal(agendaSummary(settings({ agendaKeepTime: false })).text, 'Opens each date at its first event');
  assert.equal(ganttSummary(settings()).text, 'People in People · previews first change');
  assert.equal(ganttSummary(settings({ ganttPeopleFolder: '', ganttConfirmWrites: false })).text, 'People in the Vault root · no preview');
});

test('Subscriptions counts calendars and the ones that failed to refresh', () => {
  assert.deepEqual(subscriptionsSummary(settings(), {}), { text: 'No calendars · refresh every 15 minutes', attention: false });
  assert.deepEqual(subscriptionsSummary(settings({ sources: [feed('a')], syncIntervalMinutes: 1 }), { a: fresh }),
    { text: '1 calendar · refresh every minute', attention: false });
  assert.deepEqual(subscriptionsSummary(settings({ sources: [feed('a'), feed('b'), feed('c')] }), { a: fresh, b: failed }),
    { text: '3 calendars, 1 failed to refresh · refresh every 15 minutes', attention: true });
});

test('a failure of a disabled or blank subscription is not counted', () => {
  const sources = [feed('a', { enabled: false }), feed('b', { url: ' ' })];
  assert.deepEqual(subscriptionsSummary(settings({ sources }), { a: failed, b: failed }),
    { text: '2 calendars · refresh every 15 minutes', attention: false });
});

test('a calendar shows its type and refresh status', () => {
  assert.deepEqual(sourceSummary(feed('a'), fresh), { text: 'Events · Refreshed', attention: false });
  assert.deepEqual(sourceSummary(feed('a', { kind: 'holidays' }), undefined), { text: 'Holidays · Not refreshed yet', attention: false });
  assert.deepEqual(sourceSummary(feed('a'), failed), { text: 'Events · Last refresh failed', attention: true });
  assert.deepEqual(sourceSummary(feed('a', { enabled: false }), failed), { text: 'Events · Disabled', attention: false });
  assert.deepEqual(sourceSummary(feed('a', { url: '' }), undefined), { text: 'Events · Inactive, no URL', attention: false });
});

test('a calendar with skipped events says so without asking for attention', () => {
  assert.deepEqual(sourceSummary(feed('a'), fresh, 1), { text: 'Events · Refreshed, 1 event skipped', attention: false });
  assert.deepEqual(sourceSummary(feed('a'), failed, 2), { text: 'Events · Last refresh failed, 2 events skipped', attention: true });
});

test('Event Note diagnostics counts problems', () => {
  assert.deepEqual(diagnosticsSummary(0), { text: 'No problems', attention: false });
  assert.deepEqual(diagnosticsSummary(1), { text: '1 problem found', attention: true });
  assert.deepEqual(diagnosticsSummary(4), { text: '4 problems found', attention: true });
});
