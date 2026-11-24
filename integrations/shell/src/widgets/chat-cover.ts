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
 * The chat also counts as covered while the switch layout of a session
 * application shows the application in its place (the chat stays drawn,
 * hidden): its inline widgets are then out of sight. The application's own
 * frame reads `coversApplication`, which leaves that out.
 *
 * One object per page (main.tsx). The inline widget panels read it and are
 * told after each change of `covered` or `coversApplication`.
 */

export class ChatCover {
  // Settings screen or narrow Activity column (the workspace's drawing).
  private screens = false;
  // The screenshot viewer is open.
  private viewer = false;
  // The switch layout shows the conversation's application in the chat's place.
  private chatConcealed = false;
  private readonly listeners = new Set<() => void>();

  /** Whether the chat (and so its inline and pinned widgets) is covered. */
  get covered(): boolean {
    return this.screens || this.viewer || this.chatConcealed;
  }

  /** Whether a session application's frame is covered (the chat's concealment aside). */
  get coversApplication(): boolean {
    return this.screens || this.viewer;
  }

  /** The workspace: the settings screen or the narrow Activity column covers the chat. */
  setCovered(covered: boolean): void {
    const before = this.snapshot();
    this.screens = covered;
    this.changed(before);
  }

  /** The screenshot viewer is open (any state but closed). */
  setViewerOpen(open: boolean): void {
    const before = this.snapshot();
    this.viewer = open;
    this.changed(before);
  }

  /** The switch layout shows the application in place of the chat. */
  setChatConcealed(concealed: boolean): void {
    const before = this.snapshot();
    this.chatConcealed = concealed;
    this.changed(before);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Both answers, to tell whether either changed. */
  private snapshot(): string {
    return String(this.covered) + String(this.coversApplication);
  }

  /** Tells the listeners when `covered` or `coversApplication` changed. */
  private changed(before: string): void {
    if (this.snapshot() === before) {
      return;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}
