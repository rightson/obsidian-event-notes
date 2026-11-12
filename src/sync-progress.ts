/** The stages of one subscription sync, in the order `SubscriptionService.refreshSource` runs them. `hide` is the turn-off path. */
export type SyncStep = "validate" | "fetch" | "parse" | "update" | "save" | "hide";

export interface SyncSourceRef { id: string; name: string }

/** What the sync pipeline reports to. Absent for background refreshes, which stay silent. */
export interface SyncReporter {
  step(source: SyncSourceRef, step: SyncStep): void;
  fail(source: SyncSourceRef, reason: string): void;
}

export type SyncProgressState = "running" | "success" | "failed";
export interface SyncProgressView { state: SyncProgressState; text: string }

const RUNNING: Record<SyncStep, string> = {
  validate: "checking the feed URL", fetch: "fetching the feed", parse: "reading the events",
  update: "updating events and notes", save: "saving the result", hide: "hiding its events",
};

interface Entry { source: SyncSourceRef; step?: SyncStep; done: boolean; reason?: string; failedAt?: SyncStep }

/** Tracks one user-initiated sync across its sources and renders the text; no UI, so it is testable. */
export class SyncProgress implements SyncReporter {
  private readonly entries: Entry[];
  private stopped?: string;

  constructor(sources: SyncSourceRef[], private readonly onUpdate: (view: SyncProgressView) => void) {
    this.entries = sources.map(source => ({ source, done: false }));
  }

  private entry(source: SyncSourceRef): Entry | undefined {
    return this.entries.find(item => item.source.id === source.id);
  }

  step(source: SyncSourceRef, step: SyncStep): void {
    const item = this.entry(source);
    if (!item || item.reason !== undefined) return;
    // Sources sync one after another, so starting this one finishes the earlier ones.
    for (const other of this.entries) if (other !== item && other.step && other.reason === undefined) other.done = true;
    item.step = step;
    this.onUpdate(this.view(false));
  }

  fail(source: SyncSourceRef, reason: string): void {
    const item = this.entry(source);
    if (!item || item.reason !== undefined) return;
    item.reason = reason;
    item.failedAt = item.step ?? "validate";
    this.onUpdate(this.view(false));
  }

  /** The run threw outside any one source: fail the sources in flight, or the run itself if none started. */
  abort(reason: string): void {
    const running = this.entries.filter(item => item.step && !item.done && item.reason === undefined);
    for (const item of running) this.fail(item.source, reason);
    if (!running.length) this.stopped = reason;
  }

  finish(): SyncProgressView {
    const view = this.view(true);
    this.onUpdate(view);
    return view;
  }

  private line(item: Entry, final: boolean): string {
    const name = `“${item.source.name}”`;
    if (item.reason !== undefined) return `${name} failed while ${RUNNING[item.failedAt!]}: ${item.reason}`;
    if (final || item.done) {
      if (!item.step) return `${name} is up to date`;
      return item.step === "hide" ? `${name} is turned off` : `${name} is synced`;
    }
    return item.step ? `${name}: ${RUNNING[item.step]}` : `${name}: waiting`;
  }

  private view(final: boolean): SyncProgressView {
    const failed = this.entries.filter(item => item.reason !== undefined);
    if (final && (failed.length || this.stopped !== undefined)) {
      const lines = failed.map(item => this.line(item, true));
      if (this.stopped !== undefined) lines.unshift(this.stopped);
      const ok = this.entries.length - failed.length;
      return { state: "failed", text: `Event Notes: sync failed.\n${lines.join("\n")}${ok > 0 && failed.length ? `\n${ok} other ${ok === 1 ? "calendar" : "calendars"} finished.` : ""}` };
    }
    if (final) {
      return { state: "success", text: this.entries.length === 1
        ? `Event Notes: ${this.line(this.entries[0], true)}.`
        : `Event Notes: ${this.entries.length} calendars finished.` };
    }
    if (this.entries.length === 1) return { state: "running", text: `Event Notes: ${this.line(this.entries[0], false)}…` };
    return { state: "running", text: `Event Notes: syncing ${this.entries.length} calendars…\n${this.entries.map(item => this.line(item, false)).join("\n")}` };
  }
}
