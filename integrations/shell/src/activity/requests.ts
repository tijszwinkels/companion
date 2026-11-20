/**
 * Which Activity requests await their answer, per entry (and one for Pause
 * and Resume), so an entry never has two requests on their way and its
 * buttons stay disabled meanwhile.
 *
 * Lives in the workspace, not in the entry's component: hiding the column
 * while a request is on its way and showing it again must not offer the
 * same action a second time (a second `start-history-agent` would start a
 * second conversation). The workspace, and with it this object, is replaced
 * on sign-out, so a late answer for the previous pairing changes nothing
 * that is shown.
 *
 * Failures are shown by the phone Store's error toast (`Store.request`
 * without `quiet`); this object only records what is pending.
 */

export class ActivityRequests {
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();

  /** Whether a request for `key` (an entry ID, or `pause`) awaits its answer. */
  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Run `work` for `key` unless another request for it is pending. Resolves
   * to its result, or to `undefined` when it was not started or failed (the
   * Store's toast explains the failure).
   */
  async run<Result>(key: string, work: () => Promise<Result>): Promise<Result | undefined> {
    if (this.pending.has(key)) {
      return undefined;
    }
    this.pending.add(key);
    this.changed();
    try {
      return await work();
    } catch {
      return undefined;
    } finally {
      this.pending.delete(key);
      this.changed();
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
