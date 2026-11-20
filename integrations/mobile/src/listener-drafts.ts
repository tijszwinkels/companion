/**
 * Listener-owned drafts for a page that asked for them (the Store's
 * `listenerDrafts` option; the browser shell turns it on, the phone panel
 * does not yet).
 *
 * The listener keeps each conversation's unsent text, the draft, in memory;
 * the last edit it receives wins, from any editor (src/desktop/README.md,
 * "Text-box drafts"; src/remote/README.md, "Drafts"). A connection that
 * authenticated with `drafts: true` receives every draft once
 * (`draft-snapshot`, after its first `panel-state`) and then every accepted
 * change (`draft`), and writes with `draft-set`. This class applies those
 * rules for one page. It decides what the conversation's text box shows
 * and when it writes; the Store keeps the shown text in its draft map, sends
 * the requests and tells the page.
 *
 * Inputs: the person's edits, Save, Discard and completed sends (from the
 * Store); the listener's snapshot, changes and answers; the connection
 * coming and going.
 * Outputs: the text each box shows (`DraftHost.show`), at most one
 * `draft-set` in flight per conversation (`DraftHost.write`), and for the
 * page each conversation's "not saved" reason and agent source.
 *
 * The rules (integrations/shell/README.md, "Listener drafts"):
 *
 * - **Shown text.** The box shows the listener's draft. A change from
 *   elsewhere is shown at once while this page has no edit of that
 *   conversation on its way and no unsaved text there; otherwise it is only
 *   remembered, and shown once this page's edits are settled (they were sent
 *   after it, so they win at the listener) or on Discard.
 * - **Writing.** Every edit is one `draft-set` with a fresh `editId`. At
 *   most one is in flight per conversation, from sending until its answer
 *   arrives; text typed meanwhile waits, and newer text replaces waiting
 *   text, so fast typing never queues stale edits. A change that carries an
 *   `editId` is this page's own (the listener names it only to the
 *   connection that wrote it): it is never shown a second time.
 * - **Unsaved text.** Text the listener has not confirmed (typed while not
 *   connected, refused, unanswered when the connection dropped, or kept in
 *   this browser before drafts were shared) stays in the box with its
 *   reason. The Store also keeps it in this browser until it is confirmed,
 *   saved or discarded, so a reload offers it again. It is never written again by itself; the person's next edit or
 *   Save writes it, Discard shows the listener's draft. A new connection's
 *   snapshot clears the mark where the listener already holds exactly that
 *   text.
 * - **Mode.** Whether the current connection shares drafts is learnt from
 *   the listener: it sends `draft-snapshot` while handling the connection's
 *   first `panel-state`, before answering it. So a snapshot means `listener`;
 *   an accepted `panel-state` answer without one means `local` (an older
 *   gateway or listener): the Store then keeps drafts in this browser
 *   exactly as before. Until a connection has decided, the previous mode
 *   holds (`unknown` on a fresh page).
 *
 * Timing: everything runs on the page's one thread, in the order the
 * connection delivers messages. Answers to edits of an earlier pairing or
 * connection are recognised by their edit ID and ignored.
 */

import type { DraftChange, DraftSnapshot } from '../../../src/remote/protocol.ts';
import { newRequestId, UncertainOutcome } from './connection.ts';

/** Where this page's conversation drafts live now (see the class comment). */
export type DraftMode = 'unknown' | 'listener' | 'local';

/** What the drafts need from the Store that shows them. */
export interface DraftHost {
  /** The text the conversation's box shows now ('' for none). */
  shown(id: string): string;
  /** Every conversation the box holds text for, except the new-conversation box. */
  shownIds(): string[];
  /** Show the listener's text in the box. Not an edit: nothing is written. */
  show(id: string, text: string): void;
  /**
   * Send one `draft-set`. Resolves with the listener's result; rejects with
   * the refusal, or with `UncertainOutcome` when the answer was lost.
   */
  write(id: string, text: string, editId: string): Promise<unknown>;
  /** A reason or source the page shows changed. */
  changed(): void;
}

/** Shown with text typed while this page cannot write (desktop wording). */
export const notConnectedReason = 'Companion is not connected; your text is not saved yet.';

/** Shown with text whose edit was unanswered when the connection dropped (desktop wording). */
export const reconnectedReason =
  'Companion reconnected before this text was confirmed; it may not be saved.';

/**
 * Shown with text this browser kept itself: drafts kept before the listener
 * shared them, and unsaved text kept across a reload of the page.
 */
export const keptLocallyReason =
  'This text was kept in this browser; it is not saved in Companion yet.';

/** The prefix of a refusal's reason (desktop wording). */
const refusedPrefix = 'Your text is not saved: ';

/** One conversation's state, kept while it matters. */
interface DraftEntry {
  /** The listener's latest known draft, including changes not shown yet. */
  listenerText: string;
  /** Its provenance: an agent's label while it is that agent's unedited proposal, else ''. */
  listenerSource: string;
  /** The listener's sequence of that change (orders what is shown). */
  listenerSequence: number;
  /** The one edit sent and not yet answered. */
  inFlight: { editId: string; text: string } | null;
  /** The newest text typed while an edit was in flight, still to be sent. */
  waiting: string | null;
  /** Why the shown text is not saved in the listener, or '' (it is, or it is the listener's). */
  unsaved: string;
  /** Edits sent so far, and how many of them are settled (answered or lost). */
  issued: number;
  settled: number;
  /** Sends waiting for edits to be written (see `written`). */
  waiters: { target: number; resolve: () => void }[];
}

export class ListenerDrafts {
  private currentMode: DraftMode = 'unknown';
  /** The current connection received its snapshot: edits may be written. */
  private writable = false;
  /** The current connection has decided the mode (snapshot or answered report). */
  private decided = false;
  private readonly entries = new Map<string, DraftEntry>();

  constructor(private readonly host: DraftHost) {}

  /** Where conversation drafts live now (see the class comment). */
  get mode(): DraftMode {
    return this.currentMode;
  }

  /**
   * The current connection is a draft host whose snapshot arrived: edits are
   * written, and `panel-state` may carry `pendingSend` (a connection without
   * drafts would refuse that field).
   */
  get ready(): boolean {
    return this.writable;
  }

  // ---- Connection ---------------------------------------------------------------

  /** A new connection authenticated; it has not decided the mode yet. */
  connected(): void {
    this.writable = false;
    this.decided = false;
  }

  /**
   * The connection is gone. The edit in flight has an unknown outcome and the
   * waiting text was never sent: both stay shown, marked as not saved (the
   * next snapshot clears that where the listener holds exactly that text).
   * The Connection rejects the lost requests after this; those answers no
   * longer match an edit in flight and change nothing.
   */
  disconnected(): void {
    this.writable = false;
    this.decided = false;
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.inFlight === null && entry.waiting === null) {
        continue;
      }
      entry.inFlight = null;
      entry.waiting = null;
      if (entry.unsaved === '') {
        entry.unsaved = reconnectedReason;
      }
      this.releaseWaiters(entry);
      changed = true;
    }
    if (changed) {
      this.host.changed();
    }
  }

  /**
   * The connection's snapshot: it shares drafts. Each conversation's box then
   * shows the listener's draft, except text this page has not had confirmed
   * and that differs from it, which stays as not saved. Coming from local
   * drafts (a fresh page, or a connection without drafts before), every
   * local draft that differs from the listener's is offered that way, once:
   * the Store deletes its local copy right after.
   */
  snapshot(snapshot: DraftSnapshot): void {
    const comingFromLocal = this.currentMode !== 'listener';
    this.currentMode = 'listener';
    this.writable = true;
    this.decided = true;

    // The listener's whole map: a conversation it does not list has no draft.
    const listed = new Map<string, { text: string; source: string; sequence: number }>();
    for (const draft of snapshot.drafts) {
      if (typeof draft.id === 'string' && typeof draft.text === 'string') {
        listed.set(draft.id, {
          text: draft.text,
          source: typeof draft.source === 'string' ? draft.source : '',
          sequence: typeof draft.sequence === 'number' ? draft.sequence : 0,
        });
      }
    }

    const ids = new Set<string>([
      ...this.entries.keys(),
      ...listed.keys(),
      ...this.host.shownIds(),
    ]);
    for (const id of ids) {
      const entry = this.entry(id);
      const draft = listed.get(id);
      entry.listenerText = draft ? draft.text : '';
      entry.listenerSource = draft ? draft.source : '';
      entry.listenerSequence = draft ? draft.sequence : snapshot.sequence;
      // Edits of the previous connection were settled by disconnected().
      entry.inFlight = null;
      entry.waiting = null;
      this.releaseWaiters(entry);

      const shown = this.host.shown(id);
      let keptReason = '';
      if (shown !== entry.listenerText) {
        if (entry.unsaved !== '') {
          // Also empty text: an offline Clear stays a Clear until decided.
          keptReason = entry.unsaved;
        } else if (comingFromLocal && shown !== '') {
          keptReason = keptLocallyReason;
        }
      }

      if (keptReason !== '') {
        entry.unsaved = keptReason;
        continue;
      }
      entry.unsaved = '';
      if (shown !== entry.listenerText) {
        this.host.show(id, entry.listenerText);
      }
      this.forgetIfIdle(id, entry);
    }
    this.host.changed();
  }

  /**
   * The connection's first accepted `panel-state` answer. Without a snapshot
   * before it, this connection does not share drafts: the page keeps them
   * locally, as before. Returns true when the mode becomes local now (from
   * a fresh page or from listener drafts): the Store then keeps the shown
   * texts as its local drafts, with its usual pruning.
   */
  reportAccepted(): boolean {
    if (this.decided) {
      return false;
    }
    this.decided = true;
    const becameLocal = this.currentMode !== 'local';
    this.currentMode = 'local';
    // Shown texts stay where they are and become local drafts; nothing is
    // "not saved" any more, and the listener's copies no longer matter.
    this.releaseAll();
    this.entries.clear();
    this.host.changed();
    return becameLocal;
  }

  // ---- The listener's changes and answers ------------------------------------------

  /** One accepted change, from any editor, an agent, or a send that cleared it. */
  change(change: DraftChange): void {
    if (this.currentMode !== 'listener' || typeof change.id !== 'string') {
      return;
    }
    if (typeof change.text !== 'string') {
      return;
    }
    const entry = this.entry(change.id);
    const sequence = typeof change.sequence === 'number' ? change.sequence : 0;
    if (sequence < entry.listenerSequence) {
      return;
    }
    entry.listenerText = change.text;
    entry.listenerSource = typeof change.source === 'string' ? change.source : '';
    entry.listenerSequence = sequence;

    // This page's own edit: the listener applied it. It is never shown
    // again (the box already shows it, or newer text); its answer, which
    // follows, settles it.
    if (typeof change.editId === 'string' && change.editId !== '') {
      return;
    }

    // Another editor's change waits while this page's own edits are on their
    // way (those win) or its text is not saved (the person decides).
    if (entry.inFlight === null && entry.waiting === null && entry.unsaved === '') {
      if (this.host.shown(change.id) !== change.text) {
        this.host.show(change.id, change.text);
      }
    }
    this.host.changed();
  }

  /** The answer to edit `editId` of conversation `id`: it settles that edit. */
  private answered(id: string, editId: string, result: unknown): void {
    const entry = this.entries.get(id);
    if (!entry || entry.inFlight === null || entry.inFlight.editId !== editId) {
      // Settled already (by a disconnect or sign-out).
      return;
    }
    entry.settled++;
    const answer = result as { accepted?: unknown; reason?: unknown; sequence?: unknown } | null;
    if (answer && answer.accepted === false) {
      const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
      this.refused(entry, reason);
      return;
    }
    // Accepted. Its change normally came first; if not, the listener's
    // draft is this text as of the answer's sequence.
    const sequence = answer && typeof answer.sequence === 'number' ? answer.sequence : 0;
    if (sequence >= entry.listenerSequence) {
      entry.listenerText = entry.inFlight.text;
      entry.listenerSource = '';
      entry.listenerSequence = sequence;
    }
    this.confirmed(id, entry);
  }

  /** Edit `editId` failed: refused, or its answer was lost. */
  private failed(id: string, editId: string, failure: unknown): void {
    const entry = this.entries.get(id);
    if (!entry || entry.inFlight === null || entry.inFlight.editId !== editId) {
      return;
    }
    entry.settled++;
    if (failure instanceof UncertainOutcome) {
      entry.inFlight = null;
      entry.waiting = null;
      if (entry.unsaved === '') {
        entry.unsaved = reconnectedReason;
      }
      this.releaseWaiters(entry);
      this.host.changed();
      return;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    this.refused(entry, message);
  }

  /**
   * The in-flight edit was applied. Waiting text goes next; with none, the
   * shown text is saved, and the box follows the listener's latest draft
   * (which is this edit unless another editor wrote after it).
   */
  private confirmed(id: string, entry: DraftEntry): void {
    entry.inFlight = null;
    if (entry.waiting !== null) {
      const text = entry.waiting;
      entry.waiting = null;
      this.send(id, entry, text);
      this.releaseWaiters(entry);
      return;
    }
    entry.unsaved = '';
    if (this.host.shown(id) !== entry.listenerText) {
      this.host.show(id, entry.listenerText);
    }
    this.releaseWaiters(entry);
    this.forgetIfIdle(id, entry);
    this.host.changed();
  }

  /**
   * The edit was refused (too long, too many edits, unknown conversation):
   * the shown text, the newest the person typed, stays and is not saved.
   * Waiting text is not sent: it is part of what is shown and unsaved.
   */
  private refused(entry: DraftEntry, reason: string): void {
    entry.inFlight = null;
    entry.waiting = null;
    entry.unsaved = refusedPrefix + reason;
    this.releaseWaiters(entry);
    this.host.changed();
  }

  // ---- The person ---------------------------------------------------------------

  /**
   * The person changed the box's text to `text` (typing, Clear, a send's own
   * text); the Store already shows it. Written at once when nothing is in
   * flight, else it waits, replacing older waiting text. Without a writable
   * connection it is marked not saved. Only in listener mode; local drafts
   * are the Store's own.
   */
  edited(id: string, text: string): void {
    if (this.currentMode !== 'listener') {
      return;
    }
    const entry = this.entry(id);
    if (!this.writable) {
      entry.unsaved = notConnectedReason;
      this.host.changed();
      return;
    }
    // The person's new edit replaces whatever was not saved: it is written
    // now, so Save and Discard of the older state no longer apply (a
    // Discard now would be undone when this edit is applied). If this edit
    // fails, its own reason marks the text again.
    entry.unsaved = '';
    if (entry.inFlight !== null) {
      entry.waiting = text;
    } else {
      this.send(id, entry, text);
    }
    this.host.changed();
  }

  /** Save: the shown, unsaved text is written as a new edit. */
  save(id: string): boolean {
    const entry = this.entries.get(id);
    if (this.currentMode !== 'listener' || !entry || entry.unsaved === '') {
      return false;
    }
    entry.unsaved = '';
    this.edited(id, this.host.shown(id));
    return true;
  }

  /** Discard: the unsaved text goes, the listener's draft is shown. */
  discard(id: string): boolean {
    const entry = this.entries.get(id);
    if (this.currentMode !== 'listener' || !entry || entry.unsaved === '') {
      return false;
    }
    entry.unsaved = '';
    entry.waiting = null;
    if (this.host.shown(id) !== entry.listenerText) {
      this.host.show(id, entry.listenerText);
    }
    this.releaseWaiters(entry);
    this.forgetIfIdle(id, entry);
    this.host.changed();
    return true;
  }

  /**
   * A send of `text` from this page was accepted. The listener clears its
   * draft only if it still equals the sent text, and tells every editor.
   * If the box still shows the sent text with nothing of this page on its
   * way, that text no longer needs saving: the listener's draft is shown.
   * Newer typing stays as it is.
   */
  sent(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (this.currentMode !== 'listener' || !entry) {
      return;
    }
    if (this.host.shown(id) !== text || entry.inFlight !== null || entry.waiting !== null) {
      return;
    }
    entry.unsaved = '';
    if (text !== entry.listenerText) {
      this.host.show(id, entry.listenerText);
    }
    this.forgetIfIdle(id, entry);
    this.host.changed();
  }

  /** Signed out: nothing of the previous pairing stays; a new one decides afresh. */
  forget(): void {
    this.releaseAll();
    this.entries.clear();
    this.currentMode = 'unknown';
    this.writable = false;
    this.decided = false;
  }

  /**
   * Resolves once the edits of a conversation that were on their way or
   * waiting when called have been answered, or can no longer be (refused,
   * the connection dropped, signed out). A send waits for this, so the
   * listener has the sent text as its draft before the send arrives (it
   * clears only a draft that equals the sent text), and a send never
   * overtakes the edit carrying its own text. Text typed after the call
   * does not delay it.
   */
  written(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || (entry.inFlight === null && entry.waiting === null)) {
      return Promise.resolve();
    }
    // The waiting text, if any, leaves as the next edit.
    let target = entry.issued;
    if (entry.waiting !== null) {
      target += 1;
    }
    return new Promise((resolve) => {
      entry.waiters.push({ target, resolve });
    });
  }

  // ---- What the page shows --------------------------------------------------------

  /** Why the conversation's shown text is not saved in the listener, or ''. */
  unsaved(id: string): string {
    if (this.currentMode !== 'listener') {
      return '';
    }
    return this.entries.get(id)?.unsaved ?? '';
  }

  /**
   * The agent that proposed the shown text, or '' : only while the box shows
   * exactly the listener's draft and it is still that agent's unedited
   * proposal (the person's first edit removes it at once).
   */
  source(id: string): string {
    const entry = this.entries.get(id);
    if (this.currentMode !== 'listener' || !entry) {
      return '';
    }
    if (entry.inFlight !== null || entry.waiting !== null || entry.unsaved !== '') {
      return '';
    }
    if (entry.listenerText === '' || this.host.shown(id) !== entry.listenerText) {
      return '';
    }
    return entry.listenerSource;
  }

  /**
   * The conversations whose shown text the listener has not confirmed yet:
   * unsaved, or with an edit on its way or waiting. The Store keeps their
   * text in this browser, so a reload of the page offers it again (as local
   * drafts, see snapshot()) instead of losing it.
   */
  unconfirmedIds(): string[] {
    if (this.currentMode !== 'listener') {
      return [];
    }
    const ids: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.unsaved !== '' || entry.inFlight !== null || entry.waiting !== null) {
        ids.push(id);
      }
    }
    return ids;
  }

  // ---- Internals -------------------------------------------------------------------

  /**
   * The conversation's entry, made when needed. In listener mode a
   * conversation without one has no listener draft: entries holding a
   * nonempty listener draft are never dropped (see forgetIfIdle).
   */
  private entry(id: string): DraftEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        listenerText: '',
        listenerSource: '',
        listenerSequence: 0,
        inFlight: null,
        waiting: null,
        unsaved: '',
        issued: 0,
        settled: 0,
        waiters: [],
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /**
   * Entries are kept while they hold more than the shown text says: an edit
   * on its way, waiting text, a "not saved" mark or an agent's source. An
   * idle entry for an empty draft is dropped.
   */
  private forgetIfIdle(id: string, entry: DraftEntry): void {
    const idle = entry.inFlight === null && entry.waiting === null && entry.unsaved === '';
    if (idle && entry.listenerText === '' && entry.listenerSource === '') {
      this.entries.delete(id);
    }
  }

  /**
   * Resolve the sends waiting for this conversation's edits: those whose
   * edits are settled, and all of them once nothing is on its way or
   * waiting any more (nothing further will be written for them).
   */
  private releaseWaiters(entry: DraftEntry): void {
    const idle = entry.inFlight === null && entry.waiting === null;
    const remaining: DraftEntry['waiters'] = [];
    for (const waiter of entry.waiters) {
      if (idle || entry.settled >= waiter.target) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    entry.waiters = remaining;
  }

  /** Resolve every waiting send (sign-out, or drafts no longer shared). */
  private releaseAll(): void {
    for (const entry of this.entries.values()) {
      for (const waiter of entry.waiters) {
        waiter.resolve();
      }
      entry.waiters = [];
    }
  }

  /** Write `text` as the conversation's one edit in flight. */
  private send(id: string, entry: DraftEntry, text: string): void {
    const editId = newRequestId();
    entry.inFlight = { editId, text };
    entry.issued++;
    this.host.write(id, text, editId).then(
      (result) => this.answered(id, editId, result),
      (failure: unknown) => this.failed(id, editId, failure),
    );
  }
}
