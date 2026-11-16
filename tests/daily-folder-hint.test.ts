import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import { attachmentFolderSetting, attachmentPlacement, dailyNotesShareFolder, setCoreDailyFormat } from '../src/daily-folder-hint';
import { eventNotePath } from '../src/paths';
import { DEFAULT_SETTINGS, normalizePluginSettings, resolveDailySettings } from '../src/settings';
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

test('Daily Notes in one shared folder get the wizard suggested at startup', () => {
  assert.equal(dailyNotesShareFolder(fallbackApp, settings()), true);
  // Core Daily notes at the Vault root, the worst case: every Event Note would land in the root.
  assert.equal(dailyNotesShareFolder(coreApp({ folder: '', format: '' }), settings({ eventPattern: '{daily}/[Events]/{title}' })), true);
  // A literal folder in the format still puts every Daily Note in one folder.
  assert.equal(dailyNotesShareFolder(fallbackApp, settings({ dailyFolder: '', dailyFormat: '[Journal]/YYYY-MM-DD' })), true);
});

test('no suggestion when the format already adds date folders or the pattern ignores {daily}', () => {
  for (const dailyFormat of ['YYYY-MM-DD/YYYY-MM-DD', 'YYYY/MM/YYYY-MM-DD', 'YYYY/YYYY-MM-DD', 'YYYY/MM/MM-DD/MMMM DD']) {
    assert.equal(dailyNotesShareFolder(fallbackApp, settings({ dailyFormat })), false, dailyFormat);
  }
  assert.equal(dailyNotesShareFolder(coreApp({ folder: 'Journal', format: 'YYYY/MM/DD' }), settings()), false);
  assert.equal(dailyNotesShareFolder(fallbackApp, settings({ eventPattern: '[Calendar Notes]/{title}' })), false);
  assert.equal(dailyNotesShareFolder(fallbackApp, settings({ eventPattern: '\\{daily}/{title}' })), false);
  // Invalid settings are reported by the settings tab, not by this suggestion.
  assert.equal(dailyNotesShareFolder(fallbackApp, settings({ dailyFolder: '../Outside' })), false);
});

test('the core Daily notes format is changed through the plugin’s own save, or not at all', async () => {
  const core = (options: Record<string, unknown>, more: Record<string, unknown> = {}) => {
    const saved: unknown[] = [];
    const plugin: Record<string, unknown> = { enabled: true, instance: { options },
      saveData(this: { instance: { options: unknown } }) { saved.push(structuredClone(this.instance.options)); return Promise.resolve(); }, ...more };
    const app = { plugins: { plugins: {}, enabledPlugins: new Set() }, internalPlugins: { plugins: { 'daily-notes': plugin } } } as unknown as App;
    return { app, saved };
  };
  const options = { folder: 'Journal', format: 'YYYY-MM-DD', template: 'T' };
  const working = core(options);
  assert.equal(await setCoreDailyFormat(working.app, settings(), 'YYYY/MM/MM-DD/MMMM DD'), true);
  // The other options are saved untouched.
  assert.deepEqual(working.saved, [{ folder: 'Journal', format: 'YYYY/MM/MM-DD/MMMM DD', template: 'T' }]);
  assert.equal(resolveDailySettings(working.app, settings()).format, 'YYYY/MM/MM-DD/MMMM DD');
  // A default format is not stored at all; a failed save leaves it that way.
  const unset: Record<string, unknown> = { folder: '' };
  const failing = core(unset, { saveData: () => Promise.reject(new Error('disk')) });
  assert.equal(await setCoreDailyFormat(failing.app, settings(), 'YYYY/MM/DD'), false);
  assert.deepEqual(unset, { folder: '' });
  const kept = { format: 'YYYY-MM-DD' };
  assert.equal(await setCoreDailyFormat(core(kept, { saveData: () => { throw new Error('no'); } }).app, settings(), 'YYYY/MM/DD'), false);
  assert.deepEqual(kept, { format: 'YYYY-MM-DD' });
  // Missing parts of the undocumented API: nothing is touched.
  for (const more of [{ saveData: undefined }, { enabled: false }, { instance: {} }, { instance: { options: Object.freeze({ format: 'YYYY-MM-DD' }) } }, { instance: { options: { format: 7 } } }]) {
    const broken = core({ format: 'YYYY-MM-DD' }, more);
    assert.equal(await setCoreDailyFormat(broken.app, settings(), 'YYYY/MM/DD'), false, JSON.stringify(more));
    assert.deepEqual(broken.saved, []);
  }
  assert.equal(await setCoreDailyFormat(fallbackApp, settings(), 'YYYY/MM/DD'), false);
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
  // The format the wizard migrates from survives a restart, so a partial move can be finished.
  assert.equal(normalizePluginSettings({}).dailyFormerFormat, '');
  assert.equal(normalizePluginSettings({ dailyFormerFormat: 'YYYY/[Q]Q/MM-DD/MMM DD' }).dailyFormerFormat, 'YYYY/[Q]Q/MM-DD/MMM DD');
  assert.equal(normalizePluginSettings({ dailyFormerFormat: 7 }).dailyFormerFormat, '');
});
