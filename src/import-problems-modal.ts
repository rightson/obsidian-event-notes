import { Modal, Notice, type App } from 'obsidian';
import { importReportText, skipReason, skippedCount, skippedLine, skippedOutcome, type CalendarImportReport } from './import-problems';

export interface ImportProblemActions {
  reports(): CalendarImportReport[];
  refresh(): Promise<void>;
  closed(): void;
}

/** Shows, per subscription, why a refresh failed and which events were skipped and why. */
export class ImportProblemsModal extends Modal {
  private shown = '';

  constructor(app: App, private readonly actions: ImportProblemActions) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('cn-import-modal');
    this.titleEl.setText('Calendar import problems');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.actions.closed();
  }

  /** Called after every refresh; redraws only when the report changed. */
  update(): void {
    if (JSON.stringify(this.actions.reports()) !== this.shown) this.render();
  }

  private render(): void {
    const reports = this.actions.reports();
    this.shown = JSON.stringify(reports);
    const root = this.contentEl;
    const scroll = root.scrollTop;
    root.empty();
    const failed = reports.filter(report => report.error).length;
    const skipped = skippedCount(reports);
    const header = root.createDiv({ cls: 'cn-import-header' });
    header.createDiv({ text: !reports.length ? 'No calendar subscriptions are turned on.'
      : !failed && !skipped ? 'No problems. Every event of every subscription was imported.'
      : [failed ? `${failed} ${failed === 1 ? 'calendar' : 'calendars'} could not be refreshed.` : '', skipped ? skippedLine(skipped) : '',
        skipped ? 'Every other event was imported.' : ''].filter(Boolean).join(' ') });
    const buttons = header.createDiv({ cls: 'cn-import-buttons' });
    const copy = buttons.createEl('button', { text: 'Copy as text' });
    copy.disabled = !failed && !skipped;
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(importReportText(reports)).then(
        () => { new Notice('Copied the calendar import problems.'); },
        () => { new Notice('Could not copy to the clipboard.'); });
    });
    const refresh = buttons.createEl('button', { text: 'Refresh calendars', cls: 'mod-cta' });
    refresh.addEventListener('click', () => {
      refresh.disabled = true;
      void this.actions.refresh().finally(() => { refresh.disabled = false; this.update(); });
    });
    for (const report of reports) this.renderCalendar(root, report);
    root.scrollTop = scroll;
  }

  private renderCalendar(root: HTMLElement, report: CalendarImportReport): void {
    const section = root.createDiv({ cls: 'cn-import-calendar' });
    section.createEl('h3', { text: report.name });
    if (report.error) section.createDiv({ cls: 'cn-import-error', text: `Refresh failed: ${report.error}` });
    section.createDiv({ cls: 'cn-import-status', text: [
      report.lastSuccess ? `Last refreshed: ${report.lastSuccess}.` : 'Not refreshed yet.',
      report.skipped.length ? skippedLine(report.skipped.length) : report.error ? '' : 'No events skipped.',
    ].filter(Boolean).join(' ') });
    for (const item of report.skipped) {
      const card = section.createDiv({ cls: 'cn-import-event' });
      card.createDiv({ cls: 'cn-import-event-title', text: item.title ?? '(no title)' });
      card.createDiv({ cls: 'cn-import-event-reason', text: skipReason(item.code) });
      const facts = card.createEl('dl');
      const fact = (label: string, value: string | undefined) => {
        if (!value) return;
        facts.createEl('dt', { text: label });
        facts.createEl('dd', { text: value });
      };
      fact('Start', item.start);
      fact('End', item.end);
      fact('Occurrence', item.recurrenceId);
      fact('UID', item.uid);
      fact('Result', skippedOutcome(item));
    }
  }
}
