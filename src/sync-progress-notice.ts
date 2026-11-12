import { Notice } from "obsidian";
import { SyncProgress, type SyncSourceRef } from "./sync-progress";

const DONE_MS = 1800;

/** One Notice for a user-initiated sync: updated in place, dismissed after success, sticky after a failure. */
export function syncProgressNotice(sources: SyncSourceRef[]): SyncProgress {
  const notice = new Notice("Event Notes: syncing…", 0);
  return new SyncProgress(sources, view => {
    notice.setMessage(view.text);
    if (view.state === "success") window.setTimeout(() => notice.hide(), DONE_MS);
  });
}
