/**
 * Whether this page's own screens cover the chat: the settings screen, or
 * the Activity column lying over the chat in a narrow window. The chat is
 * inert then and its inline widget frames count as not visible
 * (frame-visibility.ts), so they stop polling.
 *
 * One object per page (main.tsx). The workspace sets it after each drawing;
 * the inline widget panels read it and are told after each change.
 */

export class ChatCover {
  private value = false;
  private readonly listeners = new Set<() => void>();

  get covered(): boolean {
    return this.value;
  }

  setCovered(covered: boolean): void {
    if (covered === this.value) {
      return;
    }
    this.value = covered;
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
