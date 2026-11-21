/**
 * Whether this page's Activity column lies over the chat now: shown in a
 * narrow window (layout/activity-width.ts, `isNarrowWindow`).
 *
 * One object per page (created in main.tsx), because two parts read it, as
 * with the settings screen (settings/settings-view.ts): the workspace, which
 * lays the column out and sets this after each drawing, and the phone Store,
 * which must know that the selected conversation is covered
 * (`selectionShown`): the page then reports it to the listener as not
 * visible, so the listener's unread mark is not cleared by a conversation
 * the reader cannot see.
 *
 * Listeners are told only when the value changes, so a window resized or a
 * divider dragged without crossing the narrow limit tells nobody.
 */

export class ActivityOverlay {
  private covering = false;
  private readonly listeners = new Set<() => void>();

  /** Whether the column covers the chat now. */
  get coversChat(): boolean {
    return this.covering;
  }

  setCoversChat(covers: boolean): void {
    if (covers === this.covering) {
      return;
    }
    this.covering = covers;
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
