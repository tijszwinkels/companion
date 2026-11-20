/**
 * Which Activity requests await their answer, per entry (and one for Pause
 * and Resume), so an entry never has two requests on their way and its
 * buttons stay unavailable meanwhile; and which entries have their delete
 * confirmation open.
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
  /** Pending keys and what each request is (for example `delete`), or ''. */
  private readonly pending = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  /**
   * Entries whose delete confirmation is open. Kept here, for the pairing,
   * so it survives the column being hidden and shown (and a refusal that
   * arrives meanwhile); closed by Cancel or a completed deletion. An entry
   * that goes away is no longer drawn, so its key is simply never shown.
   */
  private readonly confirmations = new Set<string>();

  /** Whether a request for `key` (an entry ID, or `pause`) awaits its answer. */
  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  /** Whether the delete confirmation of entry `key` is open. */
  isConfirming(key: string): boolean {
    return this.confirmations.has(key);
  }

  setConfirming(key: string, open: boolean): void {
    if (open === this.confirmations.has(key)) {
      return;
    }
    if (open) {
      this.confirmations.add(key);
    } else {
      this.confirmations.delete(key);
    }
    this.changed();
  }

  /** What the request for `key` awaiting its answer is (its `kind`), or ''. */
  pendingKind(key: string): string {
    return this.pending.get(key) ?? '';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Run `work` for `key` unless another request for it is pending. `kind`
   * names the request while it is pending (a deletion shows "Deleting…").
   * Resolves to its result, or to `undefined` when it was not started or
   * failed (the Store's toast explains the failure).
   */
  async run<Result>(
    key: string,
    work: () => Promise<Result>,
    kind = '',
  ): Promise<Result | undefined> {
    if (this.pending.has(key)) {
      return undefined;
    }
    this.pending.set(key, kind);
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
