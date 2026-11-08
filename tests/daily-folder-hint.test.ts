import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import { attachmentFolderSetting, attachmentPlacement, dailyFolderHint, dayFolderFormat, existingDailyNotes } from '../src/daily-folder-hint';
import { eventNotePath } from '../src/paths';
import { DEFAULT_SETTINGS, normalizePluginSettings } from '../src/settings';
import type { CalendarEvent, PluginSettings } from '../src/types';

const settings = (changes: Partial<PluginSettings> = {}): PluginSettings => ({ ...DEFAULT_SETTINGS, ...changes });
const fallbackApp = { plugins: { plugins: {}, enabledPlugins: new Set() }, internalPlugins: { plugins: {} } } as unknown as App;
const coreApp = (options: Record<string, unknown>) => ({
  plugins: { plugins: {}, enabledPlugins: new Set() },
  internalPlugins: { plugins: { 'daily-notes': { enabled: true, instance: { options } } } },
}) as unknown as App;

test('new installs file Event Notes in the folder of their Daily Note', () => {
  assert.equal(DEFAULT_SETTINGS.eventPattern, '{daily}/{title}');
  const event: CalendarEvent = { id: 'local|a', sourceId: 'local', uid: 'a', title: 'Standup',
    start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T09:30:00+08:00', allDay: false };
  assert.equal(eventNotePath(event, 'Local', fallbackApp, settings()), 'Daily Notes/Standup.md');
  // Saved settings keep the pattern they were saved with.
  assert.equal(normalizePluginSettings({ eventPattern: '[Calendar Notes]/{title}' }).eventPattern, '[Calendar Notes]/{title}');
});

test('Daily Notes in one shared folder get a folder-per-day suggestion', () => {
  const hint = dailyFolderHint(fallbackApp, settings());
  assert.deepEqual(hint, {
    provider: 'calendar-note', folder: 'Daily Notes', format: 'YYYY-MM-DD', suggestedFormat: 'YYYY-MM-DD/YYYY-MM-DD',
    now: { daily: 'Daily Notes/2026-10-23.md', event: 'Daily Notes/Sample event.md' },
    suggested: { daily: 'Daily Notes/2026-10-23/2026-10-23.md', event: 'Daily Notes/2026-10-23/Sample event.md' },
  });
  // Core Daily notes at the Vault root, the worst case: every Event Note would land in the root.
  const root = dailyFolderHint(coreApp({ folder: '', format: '' }), settings({ eventPattern: '{daily}/[Events]/{title}' }));
  assert.equal(root?.provider, 'daily-notes');
  assert.equal(root?.folder, '');
  assert.deepEqual(root?.now, { daily: '2026-10-23.md', event: 'Events/Sample event.md' });
  assert.deepEqual(root?.suggested, { daily: '2026-10-23/2026-10-23.md', event: '2026-10-23/Events/Sample event.md' });
  // A literal folder in the format still puts every Daily Note in one folder.
  const literal = dailyFolderHint(fallbackApp, settings({ dailyFolder: '', dailyFormat: '[Journal]/YYYY-MM-DD' }));
  assert.equal(literal?.suggestedFormat, '[Journal]/YYYY-MM-DD/YYYY-MM-DD');
  assert.equal(literal?.suggested.event, 'Journal/2026-10-23/Sample event.md');
});

test('no suggestion when the format already adds date folders or the pattern ignores {daily}', () => {
  for (const dailyFormat of ['YYYY-MM-DD/YYYY-MM-DD', 'YYYY/MM/YYYY-MM-DD', 'YYYY/YYYY-MM-DD']) {
    assert.equal(dailyFolderHint(fallbackApp, settings({ dailyFormat })), undefined, dailyFormat);
  }
  assert.equal(dailyFolderHint(coreApp({ folder: 'Journal', format: 'YYYY/MM/DD' }), settings()), undefined);
  assert.equal(dailyFolderHint(fallbackApp, settings({ eventPattern: '[Calendar Notes]/{title}' })), undefined);
  assert.equal(dailyFolderHint(fallbackApp, settings({ eventPattern: '\\{daily}/{title}' })), undefined);
  // Invalid settings are reported by the settings tab, not by this suggestion.
  assert.equal(dailyFolderHint(fallbackApp, settings({ dailyFolder: '../Outside' })), undefined);
});

test('the day folder goes right above the note name', () => {
  assert.equal(dayFolderFormat(' YYYY-MM-DD '), 'YYYY-MM-DD/YYYY-MM-DD');
  assert.equal(dayFolderFormat('dddd, MMMM Do YYYY'), 'YYYY-MM-DD/dddd, MMMM Do YYYY');
  assert.equal(dayFolderFormat('[Journal]/YYYYMMDD'), '[Journal]/YYYY-MM-DD/YYYYMMDD');
});

test('Daily Notes that changing the format would leave behind are counted', () => {
  const hint = dailyFolderHint(fallbackApp, settings())!;
  const paths = ['Daily Notes/2026-10-23.md', 'Daily Notes/2026-10-24.MD', 'Daily Notes/Standup.md',
    'Daily Notes/2026-10-25/2026-10-25.md', 'Elsewhere/2026-10-23.md', 'Daily Notes/2026-13-01.md', 'Daily Notes/2026-10-23.png'];
  assert.deepEqual(existingDailyNotes(paths, hint, 'en'), ['Daily Notes/2026-10-23.md', 'Daily Notes/2026-10-24.MD']);
  const root = dailyFolderHint(coreApp({ folder: '', format: '' }), settings())!;
  assert.deepEqual(existingDailyNotes(['2026-10-23.md', 'Daily Notes/2026-10-23.md'], root, 'en'), ['2026-10-23.md']);
});

test('attachments follow the note only with a folder relative to it', () => {
  assert.equal(attachmentPlacement('./'), 'beside-note');
  assert.equal(attachmentPlacement('./attachments'), 'beside-note');
  assert.equal(attachmentPlacement('/'), 'elsewhere');
  assert.equal(attachmentPlacement('Attachments'), 'elsewhere');
  assert.equal(attachmentPlacement(undefined), 'unknown');
  const vault = { config: './', getConfig(this: { config: string }, _key: string) { return this.config; } };
  assert.equal(attachmentFolderSetting({ vault } as unknown as App), './');
  assert.equal(attachmentFolderSetting({ vault: {} } as unknown as App), undefined);
});

test('dismissing the suggestion is remembered and defaults to off', () => {
  assert.equal(normalizePluginSettings({}).dailyFolderHintDismissed, false);
  assert.equal(normalizePluginSettings({ dailyFolderHintDismissed: true }).dailyFolderHintDismissed, true);
  assert.equal(normalizePluginSettings({ dailyFolderHintDismissed: 'yes' }).dailyFolderHintDismissed, false);
});
