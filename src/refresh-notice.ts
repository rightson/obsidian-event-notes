import { Notice } from 'obsidian';
import { RefreshTracker, type ProgressTitles, type ProgressView, type RefreshEvent } from './refresh-progress';

const DONE_MS = 2500;

/**
 * A notice that follows a calendar refresh step by step. It closes by itself
 * after a success and stays, naming the failed step, until it is clicked.
 */
export class RefreshNotice {
  private readonly notice = new Notice('', 0);
  private readonly tracker: RefreshTracker;
  private readonly titleEl: HTMLElement;
  private readonly barEl: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly failuresEl: HTMLElement;
  private readonly hintEl: HTMLElement;

  constructor(titles: ProgressTitles, only?: string) {
    this.tracker = new RefreshTracker(titles, only);
    const root = this.notice.messageEl;
    root.empty();
    root.addClass('cn-refresh-notice');
    root.setAttr('role', 'status');
    root.setAttr('aria-live', 'polite');
    this.titleEl = root.createDiv({ cls: 'cn-refresh-title' });
    this.barEl = root.createDiv({ cls: 'cn-refresh-bar', attr: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } });
    this.fillEl = this.barEl.createDiv({ cls: 'cn-refresh-bar-fill' });
    this.detailEl = root.createDiv({ cls: 'cn-refresh-detail' });
    this.failuresEl = root.createEl('ul', { cls: 'cn-refresh-failures' });
    this.hintEl = root.createDiv({ cls: 'cn-refresh-detail', text: 'Click to dismiss.' });
    this.show(this.tracker.current());
  }

  private show(view: ProgressView | undefined): void {
    if (!view) return;
    const root = this.notice.messageEl;
    root.toggleClass('is-failed', view.state === 'failed');
    root.toggleClass('is-done', view.state === 'done');
    this.titleEl.setText(view.state === 'running' ? `${view.title}…` : view.title);
    const percent = Math.round(Math.min(1, Math.max(0, view.fraction)) * 100);
    this.barEl.setAttr('aria-valuenow', String(percent));
    this.barEl.hidden = view.state === 'failed';
    this.fillEl.setCssProps({ '--cn-refresh-progress': `${percent}%` });
    this.detailEl.setText(view.detail);
    this.detailEl.hidden = !view.detail;
    this.failuresEl.empty();
    for (const failure of view.failures) this.failuresEl.createEl('li', { text: failure });
    this.failuresEl.hidden = !view.failures.length;
    this.hintEl.hidden = view.state !== 'failed';
  }

  start(step: 'settings' | 'scan'): void { this.show(this.tracker.start(step)); }

  readonly onProgress = (event: RefreshEvent): void => { this.show(this.tracker.handle(event)); };

  /** `failedDetail` is shown instead of `summary` when a subscription failed. */
  finish(summary: string, failedDetail = ''): void {
    const view = this.tracker.finish(summary, failedDetail);
    this.show(view);
    if (view.state === 'done') window.setTimeout(() => { this.notice.hide(); }, DONE_MS);
  }

  fail(error: unknown): void { this.show(this.tracker.fail(error)); }
}
