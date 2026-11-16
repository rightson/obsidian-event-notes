import { Modal, Notice, Setting, type App } from 'obsidian';
import { attachmentFolderSetting, attachmentPlacement } from './daily-folder-hint';
import { checkDailyFormat, dailyPathFor, findDailyNotes, migrationDefaults, planMigration, runMigration,
  type ConflictReason, type FormatCheck, type FormatContext, type MigrationAdapter, type MigrationPlan, type MigrationResult,
  type PlanOptions, type PlannedMove, type TrackedEventNote } from './daily-migration';
import type { NoteProvider } from './types';

/** What the wizard needs from the plugin. It reads the Vault and settings only through this. */
export interface DailyFolderWizardHost {
  /** Who provides Daily Notes now, and their base folder and format. */
  daily(): { provider: NoteProvider; folder: string; format: string };
  /** The format the last run migrated from; empty when none is pending. */
  formerFormat(): string;
  context(): FormatContext;
  /** Today as YYYY-MM-DD. */
  today(): string;
  /** Every file path in the Vault. */
  files(): string[];
  /** Event Notes that follow their Daily Note's folder; empty when the pattern does not use {daily}. */
  trackedEventNotes(): TrackedEventNote[];
  /** The sample Event Note path, given each date's Daily Note folder. */
  eventSample(date: string, dailyFolder: (date: string) => string): string;
  /** How Obsidian itself names this date; undefined when unknown. */
  obsidianName(date: string, format: string): string | undefined;
  /** Changes the format where that can be done from here; false asks the user to change it in Obsidian's settings. */
  applyFormat(format: string): Promise<boolean>;
  rememberFormerFormat(format: string): Promise<void>;
  openSettingsTab(id: string): boolean;
  /** Pauses the plugin's own writes to Daily Notes, once those already running are done, until the returned function is called. */
  hold(): Promise<() => void>;
  adapter: MigrationAdapter;
  /** Present when the wizard opened by itself at startup. */
  dismiss?: () => Promise<void>;
}

type Step = 'format' | 'preview' | 'apply' | 'move' | 'result';
const STEPS: Step[] = ['format', 'preview', 'apply', 'move', 'result'];
const STEP_NAMES: Record<Step, string> = { format: 'Path rule', preview: 'Preview', apply: 'Apply format', move: 'Move', result: 'Result' };

const CONFLICTS: Record<ConflictReason, string> = {
  'target-exists': 'A file is already at the new path.',
  'same-target': 'Another file would get the same new path.',
  'target-moving': 'The new path is held by a note that is itself moving. Run the wizard again afterwards.',
  ambiguous: 'This path fits both formats as different days, so it may already have been moved.',
};

const count = (number: number, one: string, many = `${one}s`): string => `${number} ${number === 1 ? one : many}`;
const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0));
const message = (error: unknown, fallback: string): string => error instanceof Error && error.message ? error.message : fallback;

/** Changes the Daily Note path rule, then moves existing Daily Notes and their Event Notes to match. */
export class DailyFolderWizard extends Modal {
  private step: Step = 'format';
  private from: string;
  private to: string;
  private options: PlanOptions = { moveEvents: true, moveExtras: true, includeAmbiguous: false };
  private plan?: MigrationPlan;
  private result?: MigrationResult;
  private release?: () => void;
  private running = false;
  private cancelled = false;
  private manual = false;
  private entering = false;
  private closed = false;
  private timer?: number;

  constructor(app: App, private host: DailyFolderWizardHost) {
    super(app);
    ({ from: this.from, to: this.to } = migrationDefaults(host.daily().format, host.formerFormat()));
  }

  onOpen(): void {
    this.modalEl.addClass('cn-daily-wizard');
    this.render();
  }

  onClose(): void {
    this.stopWatching();
    this.cancelled = true;
    this.closed = true;
    // A running move stops after the current file and releases the hold itself.
    if (!this.running) this.letGo();
    this.contentEl.empty();
  }

  private letGo(): void {
    this.release?.();
    this.release = undefined;
  }

  private stopWatching(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private go(step: Step): void {
    this.step = step;
    this.render();
  }

  private render(): void {
    this.stopWatching();
    const root = this.contentEl;
    root.empty();
    this.titleEl.setText('Change Daily Note folders');
    root.createEl('p', { cls: 'cn-daily-wizard-step', text: `Step ${STEPS.indexOf(this.step) + 1} of ${STEPS.length}: ${STEP_NAMES[this.step]}` });
    if (this.step === 'format') this.renderFormat(root);
    else if (this.step === 'preview') this.renderPreview(root);
    else if (this.step === 'apply') this.renderApply(root);
    else if (this.step === 'move') this.renderMove(root);
    else this.renderResult(root);
  }

  private layouts(): { folder: string; from: FormatCheck; to: FormatCheck } {
    const context = this.host.context();
    return { folder: this.host.daily().folder, from: checkDailyFormat(this.from, context), to: checkDailyFormat(this.to, context) };
  }

  private buildPlan(): MigrationPlan {
    return planMigration({ files: this.host.files(), folder: this.host.daily().folder, from: this.from, to: this.to,
      ctx: this.host.context(), tracked: this.host.trackedEventNotes(), options: this.options });
  }

  // Step 1: the two formats, checked as they are typed.
  private renderFormat(root: HTMLElement): void {
    const daily = this.host.daily();
    const where = daily.folder ? `the ${daily.folder} folder` : 'the Vault root';
    const provider = daily.provider === 'calendar-note' ? 'Event Notes' : daily.provider === 'daily-notes' ? 'the core Daily notes plugin' : daily.provider;
    root.createEl('p', { text: `This wizard changes the rule for where Daily Notes are saved, then moves your existing Daily Notes, and the Event Notes filed with them, to the new paths. Obsidian updates every link to a moved note.` });
    root.createEl('p', { text: `Your Daily Notes come from ${provider} and live in ${where}. That folder stays the same; only the path below it changes. Nothing is changed on this step or the next.` });

    let detail: HTMLElement;
    let next: HTMLButtonElement | undefined;
    let pending: number | undefined;
    const update = (): void => { next?.toggleAttribute('disabled', !this.renderFormatDetail(detail)); };
    const typed = (set: (value: string) => void) => (value: string): void => {
      set(value.trim());
      if (pending !== undefined) window.clearTimeout(pending);
      // Counting notes reads every path in the Vault, so wait for a pause in typing.
      pending = window.setTimeout(update, 250);
    };
    new Setting(root).setName('Migrate from')
      .setDesc('The date format your existing Daily Notes are in. A note is recognised by its whole path below the Daily Notes folder; files this format does not name are left alone.')
      .addText(text => text.setValue(this.from).onChange(typed(value => { this.from = value; })));
    new Setting(root).setName('New format')
      .setDesc('A Moment date format. The last part is the note’s name and the parts before it are folders, so YYYY/MM/MM-DD/MMMM DD gives each day the folder YYYY/MM/MM-DD.')
      .addText(text => text.setValue(this.to).onChange(typed(value => { this.to = value; })));
    detail = root.createDiv();

    const actions = new Setting(root);
    const dismiss = this.host.dismiss;
    if (dismiss) actions.addButton(button => button.setButtonText('Don’t show again').onClick(async () => {
      try { await dismiss(); this.close(); }
      catch (error) { new Notice(message(error, 'Could not save settings.')); }
    }));
    actions.addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
    actions.addButton(button => {
      next = button.setButtonText('Preview').setCta().onClick(() => {
        if (pending !== undefined) window.clearTimeout(pending);
        try { this.plan = this.buildPlan(); this.go('preview'); }
        catch (error) { new Notice(message(error, 'Could not plan the move.')); }
      }).buttonEl;
    });
    update();
  }

  /** Draws the checks and the Now and After table; returns whether the wizard can go on. */
  private renderFormatDetail(el: HTMLElement): boolean {
    el.empty();
    const daily = this.host.daily();
    const context = this.host.context();
    const { folder, from, to } = this.layouts();
    const problem = (text: string): void => { el.createDiv({ cls: 'cn-daily-wizard-error', text }); };
    const warning = (text: string): void => { el.createDiv({ cls: 'cn-daily-wizard-warning', text }); };
    if (from.error) problem(`Migrate from: ${from.error}`);
    else if (!from.parseable) problem('Migrate from: notes in this format cannot be recognised by their path, so they cannot be moved safely.');
    if (to.error) problem(`New format: ${to.error}`);
    else if (to.warning) warning(`New format: ${to.warning}`);
    if (from.error || !from.parseable || to.error) return false;

    let found: { path: string; date: string }[] = [];
    try { found = findDailyNotes(this.host.files(), { folder, format: this.from }, context); }
    catch (error) { problem(message(error, 'Could not read the Daily Notes folder.')); return false; }
    const same = this.from === this.to;
    const current = daily.format === this.to;
    el.createEl('p', { text: found.length
      ? `${count(found.length, 'Daily Note')} in your Vault ${found.length === 1 ? 'is' : 'are'} named by the Migrate from format.`
      : 'No Daily Note in your Vault is named by the Migrate from format, so no notes will move.' });
    if (same) {
      el.createEl('p', { text: current
        ? 'Your Daily Notes already use this format. To move notes left in an earlier format, enter that format in Migrate from.'
        : 'Both formats are the same, so there is nothing to move.' });
      if (current) return false;
    }

    // Real days from the Vault where there are any: the newest and the oldest.
    const dates = found.map(note => note.date).sort();
    const samples = [...new Set(dates.length ? [dates[dates.length - 1], dates[0]] : [this.host.today()])];
    const table = el.createEl('table', { cls: 'cn-daily-folder-paths' });
    const head = table.createEl('thead').createEl('tr');
    for (const text of ['', daily.format === this.from ? 'Now' : 'Before', 'After']) head.createEl('th', { text });
    const body = table.createEl('tbody');
    const row = (label: string, before: string, after: string): void => {
      const line = body.createEl('tr');
      line.createEl('th', { text: label });
      line.createEl('td').createEl('code', { text: before });
      line.createEl('td').createEl('code', { text: after });
      if (before === after) line.createEl('td', { text: 'No change', cls: 'cn-daily-wizard-muted' });
    };
    const oldLayout = { folder, format: this.from };
    const newLayout = { folder, format: this.to };
    try {
      for (const date of samples) row(`Daily Note, ${date}`, dailyPathFor(date, oldLayout, context), dailyPathFor(date, newLayout, context));
      row(`Event Note, ${samples[0]}`,
        this.host.eventSample(samples[0], date => folderOf(dailyPathFor(date, oldLayout, context))),
        this.host.eventSample(samples[0], date => folderOf(dailyPathFor(date, newLayout, context))));
    } catch (error) { problem(message(error, 'Could not work out the sample paths.')); return false; }

    // The plugin names months in its own locale setting; Obsidian may use another.
    const ours = dailyPathFor(samples[0], { folder: '', format: this.to }, context).replace(/\.md$/i, '');
    const theirs = this.host.obsidianName(samples[0], this.to);
    if (theirs !== undefined && theirs !== ours) {
      warning(`Obsidian names ${samples[0]} as ${theirs} in this format, but Event Notes names it ${ours}, because their languages differ. Use number tokens such as MM and DD, or the two will create separate Daily Notes.`);
    }
    return true;
  }

  // Step 2: everything that would move, before anything does.
  private renderPreview(root: HTMLElement): void {
    const plan = this.plan ??= this.buildPlan();
    const daily = this.host.daily();
    const moves = (kind: PlannedMove['kind']): PlannedMove[] => plan.moves.filter(move => move.kind === kind);
    root.createEl('p', { text: daily.format === this.to
      ? `The Daily Note format is already ${this.to}, so it stays as it is.`
      : `The Daily Note format will change from ${daily.format} to ${this.to}.` });
    const total = plan.moves.length;
    root.createEl('p', { text: total
      ? `${count(total, 'file')} will move: ${count(moves('daily').length, 'Daily Note')}, ${count(moves('event').length, 'Event Note')} and ${count(moves('extra').length, 'other file')}. ${count(plan.conflicts.length, 'file is', 'files are')} skipped.`
      : 'No files will move.' });
    root.createEl('p', { text: 'Nothing has been changed yet. The text of your notes is not edited; Obsidian only updates links that point to a moved file. Files not listed below stay where they are, and no file is ever overwritten.' });

    const choose = (key: keyof PlanOptions) => (value: boolean): void => {
      this.options[key] = value;
      this.plan = undefined;
      this.render();
    };
    this.renderMoves(root, 'Daily Notes', moves('daily'), true);
    if (plan.eventNotes) {
      new Setting(root).setName('Move Event Notes with their day')
        .setDesc(`${count(plan.eventNotes, 'Event Note')} filed in a Daily Note’s folder by your Event Note pattern can move to the folder the pattern gives now. Turn this off to leave them where they are.`)
        .addToggle(toggle => toggle.setValue(this.options.moveEvents).onChange(choose('moveEvents')));
      this.renderMoves(root, 'Event Notes', moves('event'));
    }
    if (plan.extras) {
      new Setting(root).setName('Move the other files in each day’s folder')
        .setDesc(`${count(plan.extras, 'other file')}, such as attachments, ${plan.extras === 1 ? 'is' : 'are'} in a folder that holds a single day. Turn this off to leave them where they are.`)
        .addToggle(toggle => toggle.setValue(this.options.moveExtras).onChange(choose('moveExtras')));
      this.renderMoves(root, 'Other files', moves('extra'));
    }
    if (plan.ambiguous) {
      new Setting(root).setName('Move notes that fit both formats')
        .setDesc(`${count(plan.ambiguous, 'Daily Note')} could be read as either format, as different days. Turn this on only if you have not run this wizard on them before.`)
        .addToggle(toggle => toggle.setValue(this.options.includeAmbiguous).onChange(choose('includeAmbiguous')));
    }
    if (plan.conflicts.length) {
      const section = this.section(root, `Skipped: ${count(plan.conflicts.length, 'file')}`, true);
      section.createEl('p', { text: 'These stay where they are. Rename or merge them yourself, then run the wizard again.' });
      const list = section.createEl('ul', { cls: 'cn-daily-wizard-list' });
      for (const conflict of plan.conflicts) {
        const item = list.createEl('li');
        this.pair(item, conflict.from, conflict.to);
        item.createDiv({ cls: 'cn-daily-wizard-muted', text: CONFLICTS[conflict.reason] });
      }
    }
    if (plan.left.length) {
      const section = this.section(root, `Left in place: ${count(plan.left.length, 'file')}`);
      section.createEl('p', { text: 'These are beside the Daily Notes that move, and stay where they are.' });
      const list = section.createEl('ul', { cls: 'cn-daily-wizard-list' });
      for (const path of plan.left) list.createEl('li').createEl('code', { text: path });
    }

    const actions = new Setting(root);
    actions.addButton(button => button.setButtonText('Back').onClick(() => this.go('format')));
    actions.addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
    const nothing = !total && daily.format === this.to;
    actions.addButton(button => button.setButtonText('Continue').setCta().setDisabled(nothing).onClick(() => void this.enterApply()));
  }

  private section(root: HTMLElement, title: string, open = false): HTMLElement {
    const details = root.createEl('details', { cls: 'cn-daily-wizard-section' });
    if (open) details.setAttribute('open', '');
    details.createEl('summary', { text: title });
    return details;
  }

  private pair(el: HTMLElement, from: string, to: string): void {
    el.createEl('code', { text: from });
    el.appendText(' → ');
    el.createEl('code', { text: to });
  }

  private renderMoves(root: HTMLElement, title: string, moves: PlannedMove[], open = false): void {
    if (!moves.length) return;
    const list = this.section(root, `${title}: ${moves.length}`, open).createEl('ul', { cls: 'cn-daily-wizard-list' });
    for (const move of moves) this.pair(list.createEl('li'), move.from, move.to);
  }

  /** From here on the format and the notes may disagree, so the plugin's own Daily Note updates wait. */
  private async enterApply(): Promise<void> {
    if (this.entering) return;
    this.entering = true;
    try {
      if (this.from !== this.to && this.host.formerFormat() !== this.from) await this.host.rememberFormerFormat(this.from);
      // Waits for a scan already running, so it cannot meet the new format halfway through.
      this.release ??= await this.host.hold();
    } catch (error) { new Notice(message(error, 'Could not save settings.')); return; }
    finally { this.entering = false; }
    // Closed while waiting: nobody is left to give the hold back later.
    if (this.closed) { this.letGo(); return; }
    this.go('apply');
  }

  // Step 3: the format, changed here or by the user in Obsidian's settings.
  private renderApply(root: HTMLElement): void {
    const daily = this.host.daily();
    const total = this.plan?.moves.length ?? 0;
    const done = daily.format === this.to;
    const actions = (): void => {
      const row = new Setting(root);
      row.addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
      row.addButton(button => button.setButtonText(total ? 'Continue' : 'Finish').setCta().setDisabled(!done)
        .onClick(() => { if (total) this.go('move'); else this.finish(); }));
    };
    if (done) {
      root.createEl('p', { text: `The Daily Note format is ${this.to}. New Daily Notes are created at the new path.` });
      root.createEl('p', { text: total
        ? `Your existing notes have not moved yet; that is the next step. While this window is open, Event Notes pauses its own updates to Daily Notes. If you close it now, a day that already has a Daily Note keeps using that note until you run the wizard again and move it.`
        : 'There are no notes to move.' });
      actions();
      return;
    }
    root.createEl('p', { text: `This step changes the Daily Note format from ${daily.format} to ${this.to}. From then on, new Daily Notes are created at the new path. No existing file is touched on this step.` });
    const step = new Setting(root).setName(`Change the format to ${this.to}`);
    if (!this.manual) {
      step.setDesc(daily.provider === 'calendar-note'
        ? 'Event Notes provides your Daily Notes, so this changes its Daily fallback format.'
        : 'The core Daily notes plugin provides your Daily Notes, so this changes Date format in its settings. Its other settings are not touched.');
      step.addButton(button => button.setButtonText('Change format').setCta().onClick(async () => {
        button.setDisabled(true);
        try { this.manual = !await this.host.applyFormat(this.to); }
        catch (error) { new Notice(message(error, 'Could not change the format.')); }
        if (this.step === 'apply') this.render();
      }));
    } else {
      const tab = daily.provider === 'daily-notes' ? 'Daily notes' : daily.provider;
      step.setDesc(`Event Notes cannot change this setting itself. In Settings → ${tab}, set Date format to ${this.to}. This step continues by itself once the format matches.`);
      step.addButton(button => button.setButtonText('Copy format').onClick(async () => {
        try { await navigator.clipboard.writeText(this.to); new Notice(`Copied ${this.to}`); }
        catch { new Notice('Could not copy. Select the format above instead.'); }
      }));
      if (daily.provider === 'daily-notes') step.addButton(button => button.setButtonText('Open Daily notes settings').onClick(() => {
        if (!this.host.openSettingsTab('daily-notes')) new Notice('Open Settings → Daily notes to change the date format.');
      }));
      this.timer = window.setInterval(() => { if (this.host.daily().format === this.to) this.render(); }, 1000);
    }
    actions();
  }

  // Step 4: the move, one file at a time.
  private renderMove(root: HTMLElement): void {
    const moves = this.plan?.moves ?? [];
    root.createEl('p', { text: `${count(moves.length, 'file')} will move now. Each one is moved the way Obsidian renames a file, so links, embeds and Markdown links to it are updated across the Vault. Missing folders are created, and folders the move leaves empty are removed.` });
    root.createEl('p', { text: 'A file is skipped if something already sits at its new path. You can cancel between files; run the wizard again later to finish the rest.' });
    const bar = root.createDiv({ cls: 'cn-refresh-bar' });
    const fill = bar.createDiv({ cls: 'cn-refresh-bar-fill' });
    const status = root.createDiv({ cls: 'cn-daily-wizard-status', text: 'Not started.' });
    const actions = new Setting(root);
    actions.addButton(cancel => {
      cancel.setButtonText('Cancel').onClick(() => {
        if (!this.running) { this.close(); return; }
        this.cancelled = true;
        cancel.setDisabled(true).setButtonText('Stopping…');
      });
    });
    actions.addButton(start => start.setButtonText(`Move ${count(moves.length, 'file')}`).setCta().onClick(() => {
      start.setDisabled(true);
      void this.move(moves, (done, current) => {
        fill.style.setProperty('--cn-refresh-progress', `${moves.length ? Math.round(done / moves.length * 100) : 100}%`);
        status.setText(current ? `${done + 1} of ${moves.length}: ${current.from}` : `${done} of ${moves.length} done.`);
      });
    }));
  }

  private async move(moves: PlannedMove[], show: (done: number, current?: PlannedMove) => void): Promise<void> {
    this.running = true;
    this.cancelled = false;
    try {
      this.result = await runMigration(moves, this.host.daily().folder, this.host.adapter, {
        cancelled: () => this.cancelled,
        progress: async (done, _total, current) => {
          show(done, current);
          // Let the window redraw and take a click on Cancel.
          await new Promise(resolve => window.setTimeout(resolve, 0));
        },
      });
    } catch (error) {
      new Notice(message(error, 'The move stopped unexpectedly.'));
    } finally {
      this.running = false;
    }
    this.finish();
  }

  /** The earlier format is forgotten only when nothing is left in it. */
  private finish(): void {
    const result = this.result;
    const unfinished = !!this.plan?.conflicts.length || (this.plan?.moves.length ? !result : false)
      || !!result && (result.remaining > 0 || result.failed.length > 0 || result.skipped.length > 0);
    const settle = unfinished || !this.host.formerFormat() ? Promise.resolve() : this.host.rememberFormerFormat('');
    void settle.catch(() => undefined).then(() => {
      this.letGo();
      // Closed while the last file moved: there is no window to show the result in.
      if (this.contentEl.isConnected && this.step !== 'result') this.go('result');
    });
  }

  // Step 5: what happened, and what is left.
  private renderResult(root: HTMLElement): void {
    const result = this.result;
    const plan = this.plan;
    const daily = this.host.daily();
    root.createEl('p', { text: daily.format === this.to ? `New Daily Notes use the format ${this.to}.` : `The Daily Note format is still ${daily.format}.` });
    const moved = result?.moved.length ?? 0;
    const removed = result?.removedFolders.length ?? 0;
    root.createEl('p', { text: `${count(moved, 'file')} moved${removed ? `, and ${count(removed, 'empty folder')} removed` : ''}. Links to the moved files were updated by Obsidian.` });
    if (result?.remaining) {
      root.createDiv({ cls: 'cn-daily-wizard-warning', text: `Stopped with ${count(result.remaining, 'file')} still to move. Run the wizard again to finish: it remembers ${this.from} as the format to migrate from.` });
    }
    const outcomes = (title: string, items: { from: string; to: string; reason: string }[]): void => {
      if (!items.length) return;
      const list = this.section(root, `${title}: ${items.length}`, true).createEl('ul', { cls: 'cn-daily-wizard-list' });
      for (const item of items) {
        const line = list.createEl('li');
        this.pair(line, item.from, item.to);
        line.createDiv({ cls: 'cn-daily-wizard-muted', text: item.reason });
      }
    };
    outcomes('Failed', (result?.failed ?? []).map(item => ({ ...item.move, reason: item.reason })));
    outcomes('Skipped', [
      ...(plan?.conflicts ?? []).map(conflict => ({ ...conflict, reason: CONFLICTS[conflict.reason] })),
      ...(result?.skipped ?? []).map(item => ({ ...item.move, reason: item.reason })),
    ]);
    if (result?.failed.length || result?.skipped.length || plan?.conflicts.length) {
      root.createEl('p', { text: 'Skipped and failed files are where they were before. Fix what is in the way, then run the wizard again.' });
    }
    if (plan?.left.length) root.createEl('p', { text: `${count(plan.left.length, 'file')} beside the moved Daily Notes ${plan.left.length === 1 ? 'was' : 'were'} left in place.` });
    if (result?.moved.length) this.renderMoves(root, 'Moved', result.moved);

    root.createEl('h4', { text: 'Tip: attachments' });
    this.renderAttachmentTip(root.createDiv());
    new Setting(root).addButton(button => button.setButtonText('Close').setCta().onClick(() => this.close()));
  }

  private renderAttachmentTip(el: HTMLElement): void {
    const placement = attachmentPlacement(attachmentFolderSetting(this.app));
    if (placement === 'beside-note') {
      el.createEl('p', { text: 'Already set: new attachments are saved beside the note they are added to, so they land in the day’s folder.' });
      return;
    }
    const step = new Setting(el).setName('Save attachments beside their note')
      .setDesc('In Settings → Files and links, set Default location for new attachments to Same folder as current file, or In subfolder under current folder. Attachments added to a Daily Note or Event Note then go in that day’s folder. This applies to the whole Vault.');
    step.addButton(button => button.setButtonText('Open Files and links settings').onClick(() => {
      if (!this.host.openSettingsTab('file')) new Notice('Open Settings → Files and links to change where attachments go.');
    }));
  }
}
