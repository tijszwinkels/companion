/**
 * Whether this page's own screens cover the chat for its inline widget
 * frames: the settings screen or the Activity column lying over the chat
 * in a narrow window (set by the workspace), or the screenshot viewer while
 * it is open (set from main.tsx). Frames count as not visible then
 * (frame-visibility.ts), so they stop polling and a loading frame's
 * deadline does not run.
 *
 * This is for the frames only. Whether the conversation counts as shown
 * for its unread mark (the Store's `selectionShown`, main.tsx) is decided
 * there and does not read this object.
 *
 * One object per page (main.tsx). The inline widget panels read it and are
 * told after each change of `covered`.
 */

export class ChatCover {
  // Settings screen or narrow Activity column (the workspace's drawing).
  private screens = false;
  // The screenshot viewer is open.
  private viewer = false;
  private readonly listeners = new Set<() => void>();

  get covered(): boolean {
    return this.screens || this.viewer;
  }

  /** The workspace: the settings screen or the narrow Activity column covers the chat. */
  setCovered(covered: boolean): void {
    const before = this.covered;
    this.screens = covered;
    this.changed(before);
  }

  /** The screenshot viewer is open (any state but closed). */
  setViewerOpen(open: boolean): void {
    const before = this.covered;
    this.viewer = open;
    this.changed(before);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tells the listeners when `covered` changed. */
  private changed(before: boolean): void {
    if (this.covered === before) {
      return;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}
