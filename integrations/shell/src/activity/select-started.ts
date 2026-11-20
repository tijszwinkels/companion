/**
 * Selecting a conversation started from the Activity column, without ever
 * taking the reader away from something they chose meanwhile.
 *
 * Rule (the README's "Start a conversation"): the started conversation is
 * selected once it is in the list, unless what is shown (the selected
 * conversation or Previous sessions) changed at any moment since Start was
 * pressed: by the reader (also a selection and a return to the first one,
 * or Back and Forward) or by the listener (the shown conversation closed).
 * The Store's own selection of the started conversation counts as done.
 * Waiting for the conversation to appear ends after `waitMilliseconds`, on
 * sign-out, or when the start fails.
 *
 * Input: the phone Store. Output: at most one `Store.open` of the started
 * conversation. Owns one Store subscription and one timer from `begin` to
 * the end of the wait; both are released in every outcome.
 * test/shell/activity-start.test.ts checks it against the real Store.
 */

import type { AppState, Store } from '../../../mobile/src/store.ts';

/** How long a started conversation may take to appear in the list. */
export const waitMilliseconds = 10_000;

/** What is shown, as one comparable value. */
function shownKey(state: AppState): string {
  if (state.showingPrevious) {
    return 'previous';
  }
  return `conversation:${state.selected}`;
}

export class StartedSelection {
  private readonly store: Store;
  /** What was shown when last seen; any change means the reader (or listener) navigated. */
  private lastShown: string;
  private navigated = false;
  /** The started conversation, once the start was answered. */
  private startedId = '';
  private finished = false;
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Start watching what is shown: call before the start request is sent. */
  constructor(store: Store) {
    this.store = store;
    this.lastShown = shownKey(store.state);
    this.unsubscribe = store.subscribe(() => this.changed());
  }

  /** The start was answered with the conversation `id`: select it when it is listed. */
  started(id: string): void {
    if (this.finished) {
      return;
    }
    this.startedId = id;
    this.timer = setTimeout(() => this.finish(), waitMilliseconds);
    this.attempt();
  }

  /** The start failed or named no conversation: stop watching. */
  cancel(): void {
    this.finish();
  }

  private changed(): void {
    if (this.finished) {
      return;
    }
    const shown = shownKey(this.store.state);
    if (shown !== this.lastShown) {
      this.lastShown = shown;
      this.navigated = true;
    }
    if (this.startedId) {
      this.attempt();
    }
  }

  /** Select the started conversation if the rule allows it now; finish when decided. */
  private attempt(): void {
    const state = this.store.state;
    if (state.connection.status === 'unpaired') {
      this.finish();
      return;
    }
    // Already shown (the Store selects a start made while nothing was shown).
    if (!state.showingPrevious && state.selected === this.startedId) {
      this.finish();
      return;
    }
    if (this.navigated) {
      this.finish();
      return;
    }
    if (!state.sessions.has(this.startedId)) {
      return;
    }
    // Finished first: the selection below changes what is shown.
    this.finish();
    this.store.open(this.startedId);
  }

  private finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.unsubscribe();
    clearTimeout(this.timer);
  }
}
