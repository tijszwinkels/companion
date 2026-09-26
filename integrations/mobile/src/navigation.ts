/**
 * Browser Back follows phone pages and dismisses the top modal before leaving.
 * Only navigation identifiers enter history; transcripts and drafts never do.
 * Modal contents belong to mounted components, so Forward restores their page,
 * not a stale dialog. A fresh page load starts a new navigation lifetime.
 */

export interface PhonePage {
  selected: string;
  showingPrevious: boolean;
}

interface Entry extends PhonePage {
  lifetime: string;
  modals: number[];
}

const activityPage: PhonePage = { selected: '', showingPrevious: false };

export class Navigation {
  private lifetime = crypto.randomUUID();
  private nextModal = 0;
  private readonly modals = new Map<number, () => void>();
  private entry: Entry = { ...activityPage, lifetime: this.lifetime, modals: [] };
  private dismissing = false;
  private deferredPage?: PhonePage;
  private readonly deferredModals = new Set<number>();

  constructor(private readonly onPage: (page: PhonePage) => void) {
    this.write(true);
    window.addEventListener('popstate', (event) => this.pop(event.state));
  }

  private write(replace: boolean): void {
    const state = { ...window.history.state, companionPanel: this.entry };
    if (replace) {
      window.history.replaceState(state, '');
    } else {
      window.history.pushState(state, '');
    }
  }

  navigate(page: PhonePage, replace = false): void {
    // A close button starts asynchronous history traversal. Queue navigation
    // caused by its action until that traversal completes, so Back cannot
    // accidentally undo the new page instead of dismissing the dialog.
    if (this.dismissing) {
      this.deferredPage = page;
      return;
    }
    if (
      page.selected === this.entry.selected &&
      page.showingPrevious === this.entry.showingPrevious
    ) {
      this.onPage(page);
      return;
    }
    const hadModal = this.entry.modals.length > 0;
    this.closeExcept([]);
    this.entry = { ...page, lifetime: this.lifetime, modals: [] };
    this.write(replace || hadModal);
    this.onPage(page);
  }

  /** Clear route and dialog state on sign-out; old entries cannot restore data. */
  reset(): void {
    this.closeExcept([]);
    this.lifetime = crypto.randomUUID();
    this.dismissing = false;
    this.deferredPage = undefined;
    this.deferredModals.clear();
    this.entry = { ...activityPage, lifetime: this.lifetime, modals: [] };
    this.write(true);
  }

  openModal(close: () => void): { dismiss(): void; release(): void } {
    const id = ++this.nextModal;
    this.modals.set(id, close);
    if (this.dismissing) {
      // An immediate next menu must not push ahead of an in-flight Back and
      // become the entry that traversal removes. Register it after the pop.
      this.deferredModals.add(id);
    } else {
      this.entry = { ...this.entry, modals: [...this.entry.modals, id] };
      this.write(false);
    }
    return {
      dismiss: () => {
        if (this.deferredModals.delete(id)) {
          this.modals.delete(id);
          close();
        } else if (this.entry.modals.at(-1) === id && !this.dismissing) {
          this.dismissing = true;
          window.history.back();
        }
      },
      release: () => {
        this.deferredModals.delete(id);
        this.modals.delete(id);
        if (this.entry.modals.at(-1) === id && !this.dismissing) {
          // The owner's action may unmount the modal itself (for example,
          // Close session). Consume its Back entry just as the close button
          // would; any resulting page navigation waits for this traversal.
          this.dismissing = true;
          window.history.back();
        } else if (this.entry.modals.includes(id) && !this.dismissing) {
          this.entry = {
            ...this.entry,
            modals: this.entry.modals.filter((candidate) => candidate !== id),
          };
          this.write(true);
        }
      },
    };
  }

  private closeExcept(retained: number[]): void {
    for (const [id, close] of this.modals) {
      if (!retained.includes(id)) {
        this.modals.delete(id);
        close();
      }
    }
  }

  private pop(state: unknown): void {
    const candidate = (state as { companionPanel?: Entry } | null)?.companionPanel;
    const page = candidate?.lifetime === this.lifetime ? candidate : activityPage;
    const retained =
      candidate?.lifetime === this.lifetime
        ? candidate.modals.filter((id) => this.modals.has(id))
        : [];
    this.closeExcept([...retained, ...this.deferredModals]);
    this.entry = { ...page, lifetime: this.lifetime, modals: retained };
    this.write(true);
    this.dismissing = false;
    this.onPage(page);
    const deferred = this.deferredPage;
    this.deferredPage = undefined;
    if (deferred) {
      this.navigate(deferred);
    }
    const waiting = [...this.deferredModals].filter((id) => this.modals.has(id));
    this.deferredModals.clear();
    if (waiting.length > 0) {
      this.entry = { ...this.entry, modals: [...this.entry.modals, ...waiting] };
      this.write(false);
    }
  }
}
