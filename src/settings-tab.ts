import { Notice, PluginSettingTab, setIcon, type App, type Setting, type SettingDefinition, type SettingDefinitionGroup, type SettingDefinitionItem, type SettingDefinitionRender, type SettingGroup, type ToggleComponent } from 'obsidian';
import moment from 'moment-timezone';
import type CalendarNotePlugin from './main';
import type { CalendarSource, PluginSettings } from './types';
import { isEventClickAction, isEventPropertiesDefault, isMainDateClickAction, isMiniDateClickAction, isMonthsMinimum, MONTHS_MINIMUM_MAX, resolveDailySettings, resolveWeeklySettings } from './settings';
import { dailyNotePath, eventNotePath, weeklyNotePath, folderPath } from './paths';
import { dailyFolderHint } from './daily-folder-hint';
import { patchSubscription, subscriptionStatus } from './subscription-settings';
import { PROBLEM_LABELS, PROBLEM_ORDER } from './note-problems';
import { holidayOptions, isCalendarKind, isHolidayShade, type HolidayOptions } from './holidays';
import {
  agendaSummary, clickingSummary, diagnosticsSummary, displaySummary, ganttSummary, monthsSummary, notePathsSummary,
  readOpenSections, revealOnLookup, sectionHeading, sourceSectionKey, sourceSummary, startsOpen, subscriptionsSummary, withSectionOpen, type SectionSummary,
} from './settings-sections';

const sample = { id: 'local|sample', sourceId: 'local', uid: 'sample', title: 'Sample event', start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T10:00:00+08:00', allDay: false };
type TextSettingKey = 'eventPattern' | 'dailyFolder' | 'dailyFormat' | 'dailyTemplate'
  | 'weeklyFolder' | 'weeklyFormat' | 'weeklyTemplate' | 'locale' | 'timeZone' | 'ganttPeopleFolder';

const SOURCE_GROUP_CLASS = 'cn-source-settings';
// Which sections are open is a per-device habit, so it stays out of the synced plugin data.
const OPEN_SECTIONS_KEY = 'event-notes-open-settings-sections';

interface Section {
  key: string;
  listEl: HTMLElement;
  summary: () => SectionSummary;
}

export function validatePluginSettings(app: App, settings: PluginSettings): { event: string; daily: string; weekly: string } {
  if (!moment.tz.zone(settings.timeZone)) throw new Error('Enter a valid IANA time zone.');
  if (![5, 10, 15, 20, 30, 60].includes(settings.snapMinutes)) throw new Error('Choose a valid snap interval.');
  if (!Number.isInteger(settings.defaultDurationMinutes) || settings.defaultDurationMinutes < 15 || settings.defaultDurationMinutes > 1440) throw new Error('Default duration must be 15–1440 minutes.');
  if (!Number.isInteger(settings.syncIntervalMinutes) || settings.syncIntervalMinutes < 1 || settings.syncIntervalMinutes > 1440) throw new Error('Sync interval must be 1–1440 minutes.');
  if (!Number.isInteger(settings.customDays) || settings.customDays < 2 || settings.customDays > 14) throw new Error('Custom days must be 2–14.');
  if (!isEventPropertiesDefault(settings.eventPropertiesDefault)) throw new Error('Choose a valid Event Note Properties default.');
  if (!isEventClickAction(settings.eventClickAction)) throw new Error('Choose a valid event click action.');
  if (!isMiniDateClickAction(settings.miniDateClickAction)) throw new Error('Choose a valid mini calendar click action.');
  if (!isMainDateClickAction(settings.mainDateClickAction)) throw new Error('Choose a valid main calendar click action.');
  if (!isMonthsMinimum(settings.monthsMinimum)) throw new Error(`Show at least 1–${MONTHS_MINIMUM_MAX} months.`);
  folderPath(settings.dailyFolder); folderPath(settings.weeklyFolder); folderPath(settings.ganttPeopleFolder);
  const event = eventNotePath(sample, 'Local', app, settings);
  const daily = dailyNotePath('2026-10-23', app, settings);
  const weekly = weeklyNotePath('2026-10-23', app, settings);
  const normalized = [event, daily, weekly].map(path => path.normalize('NFC').toLocaleLowerCase('en-US'));
  if (new Set(normalized).size !== 3) throw new Error('Event, Daily, and Weekly Note paths collide for the sample date.');
  const seen = new Set<string>();
  for (const source of settings.sources) {
    if (!source.name.trim()) throw new Error('Every subscription needs a name.');
    if (!source.url.trim()) continue;
    let parsed: URL;
    try { parsed = new URL(source.url.trim()); } catch { throw new Error('Enter a valid HTTPS or webcal subscription URL.'); }
    if (!['https:', 'webcal:'].includes(parsed.protocol)) throw new Error('Use an HTTPS or webcal subscription URL.');
    if (seen.has(source.id)) throw new Error('Duplicate subscription identity.');
    if (source.kind !== undefined && !isCalendarKind(source.kind)) throw new Error('Choose a valid calendar type.');
    if (source.holidayShade !== undefined && !isHolidayShade(source.holidayShade)) throw new Error('Choose a valid holiday background.');
    seen.add(source.id);
  }
  return { event, daily, weekly };
}

export class CalendarNoteSettingTab extends PluginSettingTab {
  private statusElements = new Map<string, HTMLElement>();
  private samples = new Set<() => void>();
  private sourceGroups = new Map<string, SettingGroup>();
  private diagnostics = new Set<() => void>();
  // Rows are rendered while hidden, so visibility follows this count rather than the live scan.
  // Settings search reads visibility without rendering, so every scan has to set it too.
  private shownProblems = 0;
  // Keyed by group element, because Obsidian reuses a group for whatever sits at its position after a redraw.
  private sections = new Map<HTMLElement, Section>();
  // Open state for this showing of the tab. A redraw keeps it; attention is only looked at when a section first appears.
  private open = new Map<string, boolean>();
  private wiredHeaders = new WeakSet<HTMLElement>();
  private sectionIds = 0;
  constructor(app: App, private plugin: CalendarNotePlugin) { super(app, plugin); }

  // Reopening the tab reruns every render and visible callback but not this method, so
  // anything that can change has to be read inside those callbacks, not captured here.
  getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = () => this.plugin.store.state.settings;
    return [
      this.section('paths', () => notePathsSummary(settings()), { type: 'group', heading: 'Note paths', items: [
        this.text('Event Note pattern', 'Moment date tokens, {title}, {calendar}, and {uid}. Start with {daily}/ to use the folder of the event’s Daily Note, such as {daily}/{title}.', 'eventPattern'),
        this.live('Event Note sample', current => eventNotePath(sample, 'Local', this.app, current)),
        { name: 'Give each day its own folder', desc: 'All your Daily Notes share one folder, so {daily} files every Event Note and attachment there too. A folder per day keeps each day together.',
          visible: () => !!dailyFolderHint(this.app, this.plugin.store.state.settings), render: setting => {
            setting.addButton(button => button.setButtonText('Show how').onClick(() => { this.plugin.showDailyFolderHint(); }));
          } },
        this.toggle('Move Event Notes when dates change', 'When an event moves to another date, move its Event Note to the folder the pattern gives for that date, such as the new Daily Note’s folder with {daily}. Notes you moved yourself stay put.', 'moveEventNotes'),
        this.dropdown('Event Note Properties', 'eventPropertiesDefault', [
          ['obsidian', 'Follow Obsidian'], ['collapsed', 'Collapsed'], ['expanded', 'Expanded'],
        ], 'Initial Properties state when an Event Note opens. You can toggle it in the note.'),
        this.live('Daily Notes provider', current => {
          const { provider } = resolveDailySettings(this.app, current);
          return provider === 'calendar-note' ? 'this plugin' : provider;
        }),
        this.text('Daily fallback folder', 'Used when core Daily Notes is disabled.', 'dailyFolder'),
        this.text('Daily fallback format', 'Moment date format; no event placeholders.', 'dailyFormat'),
        this.text('Daily fallback template', 'Vault-relative Markdown template path, optional.', 'dailyTemplate'),
        this.live('Daily Note sample', current => dailyNotePath('2026-10-23', this.app, current)),
        this.live('Weekly Notes provider', current => {
          const { provider } = resolveWeeklySettings(this.app, current);
          return provider === 'calendar-note' ? 'this plugin' : provider;
        }),
        this.text('Weekly fallback folder', 'Used when Calendar and Periodic Notes have no active weekly settings.', 'weeklyFolder'),
        this.text('Weekly fallback format', 'Moment locale week tokens: gggg and ww. ISO: GGGG and WW.', 'weeklyFormat'),
        this.text('Weekly fallback template', 'Vault-relative Markdown template path, optional.', 'weeklyTemplate'),
        this.live('Weekly Note sample', current => weeklyNotePath('2026-10-23', this.app, current)),
      ] }),
      this.section('display', () => displaySummary(settings()), { type: 'group', heading: 'Calendar display', items: [
        this.dropdown('Week numbering', 'weekMode', [['calendar', 'Calendar locale'], ['iso', 'ISO 8601']]),
        this.dropdown('Week starts on', 'weekStart', [
          ['locale', 'Locale default'], ['sunday', 'Sunday'], ['monday', 'Monday'], ['tuesday', 'Tuesday'],
          ['wednesday', 'Wednesday'], ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday'],
        ]),
        this.text('Date locale', 'For example en, en-gb, or zh-tw.', 'locale'),
        this.text('Display time zone', 'IANA zone, such as Asia/Taipei.', 'timeZone'),
        this.dropdown('Snap interval', 'snapMinutes', [['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['20', '20 minutes'], ['30', '30 minutes'], ['60', '60 minutes']]),
        this.number('Default event duration (minutes)', 'defaultDurationMinutes'),
        this.number('Custom view days', 'customDays'),
      ] }),
      this.section('clicking', () => clickingSummary(settings()), { type: 'group', heading: 'Clicking', items: [
        this.dropdown('Clicking a date in the mini calendar', 'miniDateClickAction', [
          ['navigate', 'Go to the date in the main calendar'],
          ['split', 'Go to the date and open its Daily Note beside the calendar'],
          ['tab', 'Go to the date and open its Daily Note in a new tab'],
        ], 'The calendar on the left. With the main calendar hidden, going to a date opens its Daily Note beside the calendar. Week numbers always open the Weekly Note.'),
        this.dropdown('Clicking an empty slot in the main calendar', 'mainDateClickAction', [
          ['auto', 'New event in Week and Day; Daily Note in Month and Year'],
          ['event', 'Always create a new event'],
          ['split', 'Open the Daily Note beside the calendar'],
          ['tab', 'Open the Daily Note in a new tab'],
          ['none', 'Do nothing'],
        ], 'A time slot or date cell with no event. A new event in Month or Year is all-day. Right-click still offers New event, and date headers and day numbers still open the Daily Note.'),
        this.dropdown('Clicking an event', 'eventClickAction', [
          ['dialog', 'Show event details'], ['split', 'Open Event Note beside the calendar'], ['tab', 'Open Event Note in a new tab'],
        ], 'In the main calendar. The event details dialog can still open the Event Note either way.'),
      ] }),
      this.section('months', () => monthsSummary(settings()), { type: 'group', heading: 'Month calendar', items: [
        this.toggle('Add to the right sidebar at startup', 'Only when the month calendar is not already open. Drag its tab to move it; it stays where you put it.', 'monthsOnStartup'),
        this.dropdown('Show at least', 'monthsMinimum',
          Array.from({ length: MONTHS_MINIMUM_MAX }, (_, i) => [String(i + 1), i ? `${i + 1} months` : '1 month'] as [string, string]),
          'In a short panel, month cards get smaller until this many months fit. A taller panel shows more at full size.'),
        { name: 'Place below the file explorer', desc: 'Moves the month calendar to the left sidebar, under the file explorer.', render: setting => {
          setting.addButton(button => button.setButtonText('Move').onClick(() => void this.plugin.openMonths('below-explorer')));
        } },
      ] }),
      this.section('agenda', () => agendaSummary(settings()), { type: 'group', heading: 'Events sidebar', items: [
        this.toggle('Keep the time of day when changing dates', 'Another date opens at the hours you were looking at. Turn it off to open each date at its first event (or 08:00). Today always opens at the current time.', 'agendaKeepTime'),
      ] }),
      this.section('gantt', () => ganttSummary(settings()), { type: 'group', heading: 'Gantt', items: [
        this.text('People folder', 'Where the + button next to a [[name]] assignee creates the person\'s note.', 'ganttPeopleFolder'),
        this.toggle('Preview the first change to each note', 'Show the change as a diff before the Gantt view first writes to a note in this session.', 'ganttConfirmWrites'),
      ] }),
      this.section('subscriptions', () => subscriptionsSummary(settings(), this.plugin.store.state.sourceCaches),
        { type: 'group', heading: 'Subscriptions', items: [this.number('Refresh interval (minutes)', 'syncIntervalMinutes')] }),
      ...this.plugin.store.state.settings.sources.map(source => this.sourceGroup(source.id)),
      { type: 'group', items: [{ name: 'Add subscription', desc: 'Local events work without a calendar subscription. A blank URL stays inactive.', render: (setting, group) => {
        group.listEl.parentElement?.removeClass(SOURCE_GROUP_CLASS);
        this.detachSection(group);
        setting.addButton(button => button.setButtonText('Add calendar').onClick(async () => {
          const id = crypto.randomUUID();
          // The new calendar still needs its URL, so it arrives open.
          this.open.set(sourceSectionKey(id), true);
          await this.save(next => { next.sources.push({ id, name: 'New calendar', url: '', color: '#5885d8', enabled: false }); }, true);
        }));
      } }] },
      this.section('diagnostics', () => diagnosticsSummary(this.plugin.notes.problems.length), { type: 'group', heading: 'Event Note diagnostics', items: [
        { name: 'No invalid Event Notes found.', visible: () => !this.shownProblems },
        { name: 'Problems found', visible: () => !!this.shownProblems, render: setting => {
          setting.addButton(button => button.setButtonText('Review and fix…').setCta().onClick(() => this.plugin.showProblems()));
          return this.showDiagnostics(() => {
            const problems = this.plugin.notes.problems;
            const counts = PROBLEM_ORDER.map(kind => [PROBLEM_LABELS[kind], problems.filter(problem => problem.kind === kind).length] as const)
              .filter(([, count]) => count).map(([label, count]) => `${label}: ${count}`).join(' · ');
            this.shownProblems = problems.length;
            setting.setName(`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} found`)
              .setDesc(`${counts}. Compare the notes involved side by side and fix each one in place.`);
          });
        } },
        { name: 'Show as text', visible: () => !!this.shownProblems, render: setting => {
          setting.setName('');
          const details = setting.descEl.createEl('details', { cls: 'cn-diagnostics' });
          details.createEl('summary', { text: 'Show as text' });
          const list = details.createEl('ul');
          return this.showDiagnostics(() => {
            list.empty();
            for (const diagnostic of this.plugin.notes.diagnostics) list.createEl('li', { text: diagnostic });
          });
        } },
      ] }),
    ];
  }

  // The next opening looks again at what needs attention.
  hide(): void {
    super.hide();
    this.open.clear();
  }

  /**
   * Obsidian's settings search calls this to find the row it scrolls to and highlights. It is not
   * in the public typings, so without it search still opens the tab but leaves the section folded.
   */
  getElementForDefinition(definition: SettingDefinitionItem): HTMLElement | undefined {
    type Lookup = (definition: SettingDefinitionItem) => HTMLElement | undefined;
    const lookup = (PluginSettingTab.prototype as unknown as { getElementForDefinition?: Lookup }).getElementForDefinition;
    return revealOnLookup(lookup && ((item: SettingDefinitionItem) => lookup.call(this, item)), element => { this.revealSection(element); })(definition);
  }

  refreshSubscriptionStatus(): void {
    for (const [id, element] of this.statusElements) this.showStatus(id, element);
    this.syncSections();
  }

  refreshDiagnostics(): void {
    this.shownProblems = this.plugin.notes.problems.length;
    for (const update of this.diagnostics) update();
    this.refreshDomState();
    this.syncSections();
  }

  /**
   * Makes a group a section that folds under its heading. The group is only reachable from its
   * rows, so every row is wrapped and whichever renders first sets the section up.
   */
  private section(key: string, summary: () => SectionSummary, group: SettingDefinitionGroup): SettingDefinitionGroup {
    return { ...group, items: group.items?.map(item => {
      const { render } = item as Partial<SettingDefinitionRender>;
      return { ...item, render: (setting, settingGroup) => {
        // After the row, because a calendar's Name row is what gives its group a heading.
        const cleanup = render?.(setting, settingGroup);
        this.attachSection(key, summary, settingGroup);
        return cleanup;
      } } as SettingDefinitionRender;
    }) };
  }

  private attachSection(key: string, summary: () => SectionSummary, group: SettingGroup): void {
    const groupEl = group.listEl.parentElement;
    if (!groupEl) return;
    const header = this.sectionHeader(group.listEl);
    if (this.sections.get(groupEl)?.key === key && this.open.has(key) && header?.hasClass('cn-section-header')) return;
    this.sections.set(groupEl, { key, listEl: group.listEl, summary });
    if (!this.open.has(key)) this.open.set(key, startsOpen(this.rememberedSections().includes(key), summary().attention));
    this.syncSection(groupEl);
  }

  /** The Add subscription group can inherit the element of a removed calendar's section. */
  private detachSection(group: SettingGroup): void {
    const groupEl = group.listEl.parentElement;
    if (groupEl) this.sections.delete(groupEl);
    group.listEl.show();
    const header = this.sectionHeader(group.listEl);
    if (!header?.hasClass('cn-section-header')) return;
    header.removeClass('cn-section-header');
    for (const name of ['role', 'tabindex', 'aria-expanded', 'aria-controls']) header.removeAttribute(name);
    header.querySelectorAll(':scope > .cn-section-chevron, :scope > .cn-section-summary').forEach(element => { element.remove(); });
  }

  /** Null while the group has no heading: Obsidian takes the heading row out of the page then. */
  private sectionHeader(listEl: HTMLElement): HTMLElement | null {
    const header = sectionHeading(listEl.parentElement?.children ?? []);
    return header instanceof HTMLElement ? header : null;
  }

  private rememberedSections(): string[] {
    return readOpenSections(this.app.loadLocalStorage(OPEN_SECTIONS_KEY));
  }

  private toggleSection(groupEl: HTMLElement): void {
    const section = this.sections.get(groupEl);
    if (!section) return;
    const open = !this.open.get(section.key);
    this.open.set(section.key, open);
    const sourceIds = this.plugin.store.state.settings.sources.map(source => source.id);
    this.app.saveLocalStorage(OPEN_SECTIONS_KEY, withSectionOpen(this.rememberedSections(), section.key, open, sourceIds));
    this.syncSection(groupEl);
  }

  /** Opens the section for this showing only: the user did not choose to keep it open. */
  private revealSection(element: HTMLElement): void {
    const groupEl = element.closest<HTMLElement>('.setting-group');
    const section = groupEl && this.sections.get(groupEl);
    if (!groupEl || !section || this.open.get(section.key)) return;
    this.open.set(section.key, true);
    this.syncSection(groupEl);
  }

  private syncSections(): void {
    for (const groupEl of [...this.sections.keys()]) {
      if (groupEl.isConnected) this.syncSection(groupEl);
      else this.sections.delete(groupEl);
    }
  }

  // Runs after every change, and rebuilds its own elements, because setting a heading may replace the header's content.
  private syncSection(groupEl: HTMLElement): void {
    const section = this.sections.get(groupEl);
    if (!section) return;
    const header = this.sectionHeader(section.listEl);
    // Without a heading there is nothing to click, so the rows must stay reachable.
    if (!header) { section.listEl.show(); return; }
    const open = this.open.get(section.key) ?? false;
    const { text, attention } = section.summary();
    if (!section.listEl.id) section.listEl.id = `cn-settings-section-${++this.sectionIds}`;
    header.addClass('cn-section-header');
    header.setAttrs({ role: 'button', tabindex: '0', 'aria-expanded': String(open), 'aria-controls': section.listEl.id });
    let chevron = header.querySelector<HTMLElement>(':scope > .cn-section-chevron');
    if (!chevron) {
      chevron = header.createSpan({ cls: 'cn-section-chevron', attr: { 'aria-hidden': 'true' } });
      setIcon(chevron, 'chevron-right');
      header.prepend(chevron);
    }
    let summary = header.querySelector<HTMLElement>(':scope > .cn-section-summary');
    if (!summary) {
      summary = createSpan({ cls: 'cn-section-summary' });
      // Between the heading text and the heading's own buttons, so it reads as part of the heading.
      header.insertBefore(summary, header.querySelector(':scope > .setting-item-control'));
    }
    summary.setText(text);
    summary.toggleClass('is-attention', attention);
    section.listEl.toggle(open);
    if (this.wiredHeaders.has(header)) return;
    this.wiredHeaders.add(header);
    header.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('.setting-item-control')) return;
      this.toggleSection(groupEl);
    });
    header.addEventListener('keydown', event => {
      if (event.target !== header || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      this.toggleSection(groupEl);
    });
  }

  private showDiagnostics(update: () => void): () => void {
    update();
    this.diagnostics.add(update);
    return () => { this.diagnostics.delete(update); };
  }

  private showStatus(id: string, element: HTMLElement): void {
    const source = this.plugin.store.state.settings.sources.find(item => item.id === id);
    if (!source) return;
    const count = this.plugin.getVisibleRange()
      ? this.plugin.events.filter(event => event.sourceId === id && event.status !== 'cancelled' && event.status !== 'removed').length
      : undefined;
    element.setText(subscriptionStatus(source, this.plugin.store.state.sourceCaches[id], count, this.plugin.subscriptions?.getSkipped(id).length));
  }

  /** A read-only row whose description follows the settings. */
  private live(name: string, text: (settings: PluginSettings) => string): SettingDefinition {
    return { name, render: setting => {
      const update = () => { setting.setDesc(text(this.plugin.store.state.settings)); };
      update();
      this.samples.add(update);
      return () => { this.samples.delete(update); };
    } };
  }

  // Only adding or removing a subscription changes the page structure; every other edit
  // updates in place so focus, typed input, and scroll position survive the save.
  private async save(change: (settings: PluginSettings) => void, redraw = false): Promise<boolean> {
    try {
      await this.plugin.updateSettings(change, next => { validatePluginSettings(this.app, next); });
      if (redraw) this.update();
      else {
        for (const update of this.samples) update();
        this.refreshSubscriptionStatus();
        this.refreshDomState();
      }
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not save settings.');
      return false;
    }
  }
  private text(name: string, desc: string, key: TextSettingKey): SettingDefinition {
    return { name, desc, render: setting => {
      setting.addText(input => {
        input.setValue(this.plugin.store.state.settings[key]);
        input.inputEl.addEventListener('blur', () => {
          const value = input.getValue().trim();
          if (value === this.plugin.store.state.settings[key]) return;
          void this.save(next => { (next as unknown as Record<string, unknown>)[key] = value; });
        });
        input.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') input.inputEl.blur(); });
      });
    } };
  }
  private toggle(name: string, desc: string, key: 'moveEventNotes' | 'monthsOnStartup' | 'agendaKeepTime' | 'ganttConfirmWrites'): SettingDefinition {
    return { name, desc, render: setting => {
      setting.addToggle(toggle => {
        toggle.setValue(this.plugin.store.state.settings[key]).onChange(value => {
          void this.save(next => { next[key] = value; });
        });
      });
    } };
  }
  private number(name: string, key: 'defaultDurationMinutes' | 'syncIntervalMinutes' | 'customDays'): SettingDefinition {
    return { name, render: setting => {
      setting.addText(input => {
        input.inputEl.type = 'number'; input.inputEl.min = '1'; input.inputEl.step = '1';
        input.setValue(String(this.plugin.store.state.settings[key]));
        input.inputEl.addEventListener('blur', () => {
          const value = Number(input.getValue());
          if (value === this.plugin.store.state.settings[key]) return;
          void this.save(next => { next[key] = value; });
        });
        input.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') input.inputEl.blur(); });
      });
    } };
  }
  private dropdown(name: string, key: 'weekMode' | 'weekStart' | 'snapMinutes' | 'eventPropertiesDefault' | 'eventClickAction' | 'miniDateClickAction' | 'mainDateClickAction' | 'monthsMinimum', values: [string, string][], desc?: string): SettingDefinition {
    return { name, desc, render: setting => {
      setting.addDropdown(select => {
        for (const [value, label] of values) select.addOption(value, label);
        select.setValue(String(this.plugin.store.state.settings[key]));
        select.onChange(value => {
          void this.save(next => { (next as unknown as Record<string, unknown>)[key] = key === 'snapMinutes' || key === 'monthsMinimum' ? Number(value) : value; });
        });
      });
    } };
  }
  /** Holiday options appear only for holiday calendars, and the color only for a custom background. */
  private sourceGroup(id: string): SettingDefinitionGroup {
    const current = () => this.plugin.store.state.settings.sources.find(item => item.id === id);
    let enabledToggle: ToggleComponent | undefined;
    let syncingToggle = false;
    let currentUrl = () => current()?.url ?? '';
    // A holiday choice shows at once; this holds it until the save reaches the store.
    let draft: Partial<CalendarSource> = {};
    const update = async (patch: Partial<CalendarSource>) => {
      // The on/off switch reports its own progress and failures.
      const saved = patch.enabled === undefined
        ? await this.save(next => { patchSubscription(next, id, patch); })
        : await this.plugin.setSubscriptionEnabled(id, patch.enabled, patch, false);
      if (patch.enabled !== undefined) {
        for (const sample of this.samples) sample();
        this.refreshSubscriptionStatus();
      }
      if (saved && patch.name !== undefined) {
        this.sourceGroups.get(id)?.setHeading(patch.name);
        this.syncSections();
      }
      const latest = current();
      if (latest && enabledToggle && enabledToggle.getValue() !== latest.enabled) {
        syncingToggle = true;
        try { enabledToggle.setValue(latest.enabled); }
        finally { syncingToggle = false; }
      }
    };
    const choose = (patch: Partial<CalendarSource>) => {
      const choice = draft = { ...draft, ...patch };
      this.refreshDomState();
      void update(patch).then(() => {
        if (draft === choice) draft = {};
        this.refreshDomState();
      });
    };
    const row = (name: string, desc: string | undefined, build: (setting: Setting, source: CalendarSource, group: SettingGroup) => void | (() => void), shown: (options: HolidayOptions) => boolean = () => true): SettingDefinition => ({
      name, desc,
      visible: () => {
        const source = current();
        return !!source && shown(holidayOptions({ ...source, ...draft }));
      },
      render: (setting, settingGroup) => {
        const source = current();
        return source ? build(setting, source, settingGroup) : undefined;
      },
    });
    const holiday = (options: HolidayOptions) => options.kind === 'holidays';
    const summary = (): SectionSummary => {
      const source = current();
      return source
        ? sourceSummary(source, this.plugin.store.state.sourceCaches[id], this.plugin.subscriptions?.getSkipped(id).length)
        : { text: '', attention: false };
    };
    return this.section(sourceSectionKey(id), summary, { type: 'group', cls: SOURCE_GROUP_CLASS, items: [
      row('Name', undefined, (setting, source, settingGroup) => {
        // Group keys are positions, so adding a subscription can reuse a group built without cls.
        settingGroup.addClass(SOURCE_GROUP_CLASS).setHeading(source.name);
        this.sourceGroups.set(id, settingGroup);
        setting.addText(input => {
          input.setValue(source.name);
          input.inputEl.addEventListener('blur', () => void update({ name: input.getValue().trim() }));
        });
        return () => { if (this.sourceGroups.get(id) === settingGroup) this.sourceGroups.delete(id); };
      }),
      row('Subscription URL', 'HTTPS or webcal. Stored privately in plugin data.', (setting, source) => {
        setting.addText(input => {
          input.setPlaceholder('https://example.com/calendar.ics').setValue(source.url);
          currentUrl = () => input.getValue().trim();
          input.inputEl.addEventListener('blur', () => void update({ url: input.getValue().trim() }));
        });
      }),
      row('Color', undefined, (setting, source) => {
        setting.addColorPicker(picker => picker.setValue(source.color).onChange(value => void update({ color: value })));
      }),
      row('Calendar type', 'A holiday calendar marks the days its events cover, in the main calendar and the mini calendar.', (setting, source) => {
        setting.addDropdown(select => select.addOption('events', 'Events').addOption('holidays', 'Holidays').setValue(holidayOptions(source).kind).onChange(value => {
          if (isCalendarKind(value)) choose({ kind: value });
        }));
      }),
      row('Holiday background', 'Background for holiday dates. Gray follows the theme.', (setting, source) => {
        setting.addDropdown(select => select.addOption('gray', 'Gray').addOption('custom', 'Custom color').addOption('none', 'None').setValue(holidayOptions(source).shade).onChange(value => {
          if (isHolidayShade(value)) choose({ holidayShade: value });
        }));
      }, holiday),
      row('Holiday background color', undefined, (setting, source) => {
        setting.addColorPicker(picker => picker.setValue(holidayOptions(source).color).onChange(value => void update({ holidayColor: value })));
      }, options => holiday(options) && options.shade === 'custom'),
      row('Show holiday names', 'Show the holidays as events. When off, holiday dates keep their background and the mini calendar names them on hover.', (setting, source) => {
        setting.addToggle(toggle => toggle.setValue(holidayOptions(source).showEvents).onChange(value => void update({ showHolidayEvents: value })));
      }, holiday),
      row('Enabled', undefined, (setting, source) => {
        setting.addToggle(toggle => {
          enabledToggle = toggle;
          toggle.setValue(source.enabled).onChange(value => {
            if (!syncingToggle) void update({ url: currentUrl(), enabled: value });
          });
        });
      }),
      row('Remove subscription', 'Existing Event Notes remain in the Vault and are reused if you add the same calendar again.', setting => {
        setting.addButton(button => button.setButtonText('Remove').onClick(() => {
          void this.save(next => { next.sources = next.sources.filter(item => item.id !== id); }, true);
        }));
      }),
      row('Status', undefined, setting => {
        const element = setting.descEl;
        this.statusElements.set(id, element);
        this.showStatus(id, element);
        setting.addButton(button => button.setButtonText('Import problems…')
          .setTooltip('See why a refresh failed and which events were skipped')
          .onClick(() => { this.plugin.showImportProblems(); }));
        // A removed row's cleanup runs after its replacement rendered, possibly for this same id.
        return () => { if (this.statusElements.get(id) === element) this.statusElements.delete(id); };
      }),
    ] });
  }
}
