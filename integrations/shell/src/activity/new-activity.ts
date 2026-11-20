/**
 * The new-activity marker: which history entries this page learned of
 * while the Activity column was hidden (the README's "The new-activity
 * marker" lists the rule with its cases).
 *
 * Input: the phone Store's state, read after each change, and whether the
 * column is shown. Output: the entries still new (`count`); the bar's ☰ and
 * the list's Activity entry carry the green dot while it is not zero.
 *
 * The Store keeps no record of what this browser saw before loading, so
 * everything this page reads until it first **caught up** with the run's
 * history (the Store's first reading finished without an error) counts as
 * already seen. After that, any entry ID it learns of while the column is
 * hidden is new: from a live event, from the pages read after a reconnect
 * (entries heard while offline), or from a new listener run. A change of an
 * entry already seen is not new. Showing the column clears the marker; an
 * entry that is removed no longer counts.
 *
 * Framework-free and without timers, so test/shell/activity-marker.test.ts
 * can play the README's table against the real Store. `observe` is
 * idempotent: observing the same state twice changes nothing, so the
 * workspace may call it on every render.
 */

import type { AppState } from '../../../mobile/src/store.ts';

export class NewActivity {
  /** The listener run the known entries belong to. */
  private runId = '';
  /** Entry IDs of that run this page has learned of. */
  private readonly known = new Set<string>();
  /** Whether this page's first reading of a run's history has finished. */
  private caughtUp = false;
  /** Entries learned while the column was hidden, after catching up. */
  private readonly unseen = new Set<string>();

  /** How many entries are new now. */
  get count(): number {
    return this.unseen.size;
  }

  /**
   * Bring the marker up to date with the Store's state and whether the
   * column is shown now.
   */
  observe(state: AppState, columnShown: boolean): void {
    // Signed out (or revoked): nothing of the previous pairing counts, and
    // pairing again starts with a new first reading.
    if (state.connection.status === 'unpaired') {
      this.reset();
      return;
    }

    const activity = state.activity;

    // A new listener run: its entries are other entries. Whether this page
    // caught up before stays as it was: a run started later is new to it.
    if (activity.sessionId !== this.runId) {
      this.runId = activity.sessionId;
      this.known.clear();
    }

    for (const id of activity.entries.keys()) {
      if (this.known.has(id)) {
        continue;
      }
      this.known.add(id);
      if (this.caughtUp && !columnShown) {
        this.unseen.add(id);
      }
    }

    // Removed entries (deleted, or gone with their run) no longer count.
    for (const id of [...this.unseen]) {
      if (!activity.entries.has(id)) {
        this.unseen.delete(id);
      }
    }

    if (columnShown) {
      this.unseen.clear();
    }

    // Caught up once the Store has read every page up to the count the
    // listener reported, without an error. Checked after the entries above,
    // so the entries of that first reading are already known.
    if (!this.caughtUp && this.finishedReading(state)) {
      this.caughtUp = true;
    }
  }

  /** Whether the Store has read all of the current run's history it knows of. */
  private finishedReading(state: AppState): boolean {
    const engine = state.engine;
    if (!engine || state.connection.status !== 'online') {
      return false;
    }
    const activity = state.activity;
    if (activity.sessionId !== engine.activitySessionId) {
      return false;
    }
    if (activity.syncing || activity.error) {
      return false;
    }
    return activity.read >= engine.activityHistoryCount;
  }

  private reset(): void {
    this.runId = '';
    this.known.clear();
    this.caughtUp = false;
    this.unseen.clear();
  }
}
