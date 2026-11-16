import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarVisibility, describeProblem, matchNotesToEvents, summaryMessage } from '../src/note-problems';
import type { CalendarEvent } from '../src/types';

const start = '2026-10-22T10:00:00+08:00';
const end = '2026-10-22T11:00:00+08:00';
const event = (uid: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: `work|${uid}`, sourceId: 'work', uid,
  title: 'Standup', start, end, allDay: false, ...extra });
const note = (path: string, extra: Partial<{ title: string; start: string; allDay: boolean }> = {}) => ({ path, title: 'Standup', start, allDay: false, ...extra });
const pairs = (notes: ReturnType<typeof note>[], events: CalendarEvent[]) =>
  matchNotesToEvents(notes, events).map(pair => [pair.note.path, pair.event.uid]);

test('a note and an event with the same start and title are paired', () => {
  assert.deepEqual(pairs([note('a.md')], [event('1')]), [['a.md', '1']]);
  // The end is not compared, and the same instant in another zone is the same start.
  assert.deepEqual(pairs([note('a.md', { start: '2026-10-22T02:00:00Z' })], [event('1', { end: '2026-10-22T12:00:00+08:00' })]), [['a.md', '1']]);
  assert.deepEqual(pairs([note('a.md'), note('b.md', { title: 'Retro' })], [event('2', { title: 'Retro' }), event('1')]), [['a.md', '1'], ['b.md', '2']]);
});

test('a different title, start or all-day flag is not a match', () => {
  assert.deepEqual(pairs([note('a.md')], [event('1', { title: 'Standup 2' })]), []);
  assert.deepEqual(pairs([note('a.md')], [event('1', { title: 'standup' })]), []);
  assert.deepEqual(pairs([note('a.md')], [event('1', { start: '2026-10-22T10:30:00+08:00' })]), []);
  assert.deepEqual(pairs([note('a.md')], [event('1', { allDay: true })]), []);
  assert.deepEqual(pairs([note('a.md', { start: 'soon' })], [event('1', { start: 'soon' })]), []);
});

test('titles are compared after trimming, collapsing whitespace and NFC', () => {
  assert.deepEqual(pairs([note('a.md', { title: ' Team   sync\t' })], [event('1', { title: 'Team sync' })]), [['a.md', '1']]);
  assert.deepEqual(pairs([note('a.md', { title: 'Café' })], [event('1', { title: 'Café' })]), [['a.md', '1']]);
});

test('all-day events are compared by date only', () => {
  const allDay = { allDay: true, start: '2026-10-22T00:00:00+08:00' };
  assert.deepEqual(pairs([note('a.md', { allDay: true, start: '2026-10-22' })], [event('1', allDay)]), [['a.md', '1']]);
  assert.deepEqual(pairs([note('a.md', { allDay: true, start: '2026-10-23' })], [event('1', allDay)]), []);
});

test('only one note for one event is paired; anything else is left alone', () => {
  assert.deepEqual(pairs([note('a.md')], [event('1'), event('2')]), []);
  assert.deepEqual(pairs([note('a.md'), note('b.md')], [event('1')]), []);
  assert.deepEqual(pairs([note('a.md'), note('b.md'), note('c.md', { title: 'Retro' })], [event('1'), event('2'), event('3', { title: 'Retro' })]), [['c.md', '3']]);
});

test('several notes with one cause are described and summarized as one problem', () => {
  const paths = Array.from({ length: 12 }, (_, index) => `n${index + 1}.md`);
  assert.equal(summaryMessage(paths.slice(0, 2), 'are not in any calendar'), '2 Event Notes are not in any calendar: n1.md, n2.md');
  assert.equal(summaryMessage(paths, 'are not in any calendar'),
    '12 Event Notes are not in any calendar: n1.md, n2.md, n3.md, n4.md, n5.md, n6.md, n7.md, n8.md, n9.md, n10.md and 2 more');
  const orphan = { kind: 'orphan' as const, paths, message: '' };
  const unlisted = { kind: 'unlisted' as const, paths, message: '', sourceId: 'work' };
  assert.equal(describeProblem(orphan, () => 'Work').title, '12 notes left by a removed calendar');
  assert.equal(describeProblem(unlisted, () => 'Work').title, '12 notes not in calendar “Work”');
  assert.match(describeProblem(unlisted, () => 'Work').explanation, /these notes/);
  assert.match(calendarVisibility(orphan), /^Not shown on the calendar: their calendar/);
  assert.equal(describeProblem({ ...orphan, paths: ['a.md'] }, () => 'Work').title, 'Left by a removed calendar');
});
