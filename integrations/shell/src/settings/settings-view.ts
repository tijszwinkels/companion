/**
 * Whether this page shows the settings screen in place of the chat.
 *
 * One object per page (created in main.tsx), because two parts read it:
 * the workspace, which draws the screen, and the phone Store, which must
 * know that the selected conversation is covered (`selectionShown`): a turn
 * that completes behind the settings screen is then marked unread, as for a
 * conversation that is not shown. The workspace changes it; listeners are
 * told after each change. Sign-out hides it (main.tsx).
 */

export class SettingsView {
  private visible = false;
  private readonly listeners = new Set<() => void>();

  get shown(): boolean {
    return this.visible;
  }

  setShown(shown: boolean): void {
    if (shown === this.visible) {
      return;
    }
    this.visible = shown;
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
