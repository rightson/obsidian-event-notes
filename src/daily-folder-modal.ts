import { Modal, Notice, Setting, type App } from 'obsidian';
import { attachmentFolderSetting, attachmentPlacement, type DailyFolderHint } from './daily-folder-hint';

export interface DailyFolderHintActions {
  /** Applies the suggested format to this plugin's own Daily Notes settings; absent when another plugin provides Daily Notes. */
  applyFormat?: (format: string) => Promise<void>;
  /** Opens an Obsidian settings tab; false when the settings window cannot be opened. */
  openSettingsTab: (id: string) => boolean;
  dismiss: () => Promise<void>;
}

/** Suggests a folder per day, so a day's Daily Note, Event Notes, and attachments stay together. */
export class DailyFolderHintModal extends Modal {
  private applied = false;

  constructor(app: App, private hint: DailyFolderHint, private existing: number, private actions: DailyFolderHintActions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('cn-daily-folder-modal');
    this.titleEl.setText('Give each day its own folder');
    this.render();
  }

  onClose(): void { this.contentEl.empty(); }

  private render(): void {
    const { hint } = this;
    const root = this.contentEl;
    root.empty();
    const where = hint.folder ? `the ${hint.folder} folder` : 'the Vault root';
    root.createEl('p', { text: `Your Event Note pattern starts with {daily}, so each Event Note goes in the folder of its Daily Note. All your Daily Notes are in ${where}, so every Event Note, and every attachment saved beside a note, ends up there too.` });
    root.createEl('p', { text: `Adding a folder for each day to the Daily Note format keeps a day's Daily Note, Event Notes, and attachments together:` });
    const table = root.createEl('table', { cls: 'cn-daily-folder-paths' });
    const head = table.createEl('thead').createEl('tr');
    for (const text of ['', 'Now', 'Suggested']) head.createEl('th', { text });
    const body = table.createEl('tbody');
    for (const [label, now, suggested] of [
      ['Daily Note', hint.now.daily, hint.suggested.daily],
      ['Event Note', hint.now.event, hint.suggested.event],
    ]) {
      const row = body.createEl('tr');
      row.createEl('th', { text: label });
      row.createEl('td').createEl('code', { text: now });
      row.createEl('td').createEl('code', { text: suggested });
    }

    root.createEl('h4', { text: '1. Daily Note format' });
    // Ahead of the button: changing the format first would split each day across two notes.
    if (this.existing > 0 && !this.applied) {
      const warning = root.createDiv({ cls: 'cn-daily-folder-warning' });
      const notes = this.existing === 1 ? '1 Daily Note' : `${this.existing} Daily Notes`;
      warning.createEl('p', { text: `${notes} in ${where} will not be moved. After the format changes, Event Notes adds each event's entry to the Daily Note at the new path, creating it if it is missing, and removes the entry from the old note. Move your Daily Notes into their day folders first, such as ${hint.now.daily} to ${hint.suggested.daily}, so a day's entries and writing stay in one note.` });
    }
    this.renderFormatStep(root.createDiv());

    root.createEl('h4', { text: '2. Attachments' });
    this.renderAttachmentStep(root.createDiv());

    const actions = new Setting(root);
    actions.addButton(button => button.setButtonText('Don’t show again').onClick(async () => {
      try { await this.actions.dismiss(); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : 'Could not save settings.'); }
    }));
    actions.addButton(button => button.setButtonText('Close').setCta().onClick(() => this.close()));
  }

  private renderFormatStep(el: HTMLElement): void {
    const { hint } = this;
    if (this.applied) {
      el.createEl('p', { text: `Done. New Daily Notes use ${hint.suggestedFormat}.` });
      return;
    }
    const step = new Setting(el).setName(`Change ${hint.format} to ${hint.suggestedFormat}`);
    const apply = this.actions.applyFormat;
    if (apply) {
      step.setDesc('Event Notes provides your Daily Notes, so it can change its own Daily fallback format.');
      step.addButton(button => button.setButtonText('Use this format').setCta().onClick(async () => {
        button.setDisabled(true);
        try { await apply(hint.suggestedFormat); this.applied = true; this.render(); }
        catch (error) {
          button.setDisabled(false);
          new Notice(error instanceof Error ? error.message : 'Could not save settings.');
        }
      }));
      return;
    }
    step.setDesc(`Your Daily Notes come from the ${hint.provider === 'daily-notes' ? 'core Daily notes plugin' : hint.provider} settings. In Settings → Daily notes, set Date format to ${hint.suggestedFormat}. Event Notes reads it from there.`);
    step.addButton(button => button.setButtonText('Copy format').onClick(async () => {
      try { await navigator.clipboard.writeText(hint.suggestedFormat); new Notice(`Copied ${hint.suggestedFormat}`); }
      catch { new Notice('Could not copy. Select the format above instead.'); }
    }));
    if (hint.provider === 'daily-notes') step.addButton(button => button.setButtonText('Open Daily notes settings').onClick(() => {
      if (!this.actions.openSettingsTab('daily-notes')) new Notice('Open Settings → Daily notes to change the date format.');
    }));
  }

  private renderAttachmentStep(el: HTMLElement): void {
    const placement = attachmentPlacement(attachmentFolderSetting(this.app));
    if (placement === 'beside-note') {
      el.createEl('p', { text: 'Already set: new attachments are saved beside the note they are added to, so they land in the day’s folder.' });
      return;
    }
    const step = new Setting(el).setName('Save attachments beside their note')
      .setDesc('In Settings → Files and links, set Default location for new attachments to Same folder as current file, or In subfolder under current folder. Attachments added to a Daily Note or Event Note then go in that day’s folder. This applies to the whole Vault.');
    step.addButton(button => button.setButtonText('Open Files and links settings').onClick(() => {
      if (!this.actions.openSettingsTab('file')) new Notice('Open Settings → Files and links to change where attachments go.');
    }));
  }
}
