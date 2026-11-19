/**
 * Resident transcript rows of the conversation the browser shell shows: the
 * live recent window plus older (or, in a detached snapshot, newer) pages the
 * reader loaded.
 *
 * This is a TypeScript port of the history-paging part of
 * integrations/panel/SessionView.qml (loadHistory, loadOlder, loadNewer,
 * refreshHistory, latestHistory, applyHistory, joinLiveWindow,
 * keepEvictedRows, keepWithinBound, the page reply handler and its deadline),
 * built on the same pure functions in integrations/panel/HistoryRows.mjs. The
 * rules are therefore the desktop's:
 *
 * - Pages join only where one ends exactly where the next starts, so no row
 *   is skipped or shown twice. A reply for a superseded view is dropped.
 * - Everything resident stays within three pages (HistoryRows' bound).
 *   Trimming spares the rows the reader can see; if it cannot, the page is
 *   dropped rather than the reader's view.
 * - One request at a time, bounded by a 10 s deadline. Failures never retry
 *   by themselves; only the reader's Retry repeats the failed request. An
 *   empty page marks its boundary as stalled so it is not requested again.
 * - Page requests are read-only (`agent-history-page`), so a request lost
 *   with the connection is simply forgotten, never replayed.
 *
 * Inputs: the shown conversation (`show`), the connection state and the
 * reader's requests (`loadOlder` …). Output: `rows()` and `status()`, read by
 * the bridge after `changed` is called. Not ported: tool-group anchors
 * (jumping to an origin's tool group), which need tool details.
 */

import type { AgentSession } from '../../../src/agents/types.ts';
import type { HistoryPage, HistoryPosition } from '../../../src/agents/history-pages.ts';
import * as HistoryRows from '../../panel/HistoryRows.mjs';
import type { HistoryRow, PositionedRow, RowsSize } from '../../panel/HistoryRows.mjs';

/** The history part of the page's status (`ChatStatus.history`). */
export interface HistoryStatus {
  hasOlder: boolean;
  pending: boolean;
  error: string;
  canRetry: boolean;
  changed: boolean;
  detached: boolean;
  atLatest: boolean;
}

/** The `agent-history-page` parameters (src/remote/protocol.ts). */
export interface PageRequest {
  id: string;
  epoch: string;
  direction: 'before' | 'after';
  index: number;
  offset: number;
}

/** What the model needs from its surroundings. */
export interface HistoryHost {
  /** Ask the gateway for one page; rejects with an Error on failure. */
  requestPage(request: PageRequest): Promise<HistoryPage>;
  /** Keys of rows the reader can currently see (trimming spares them). */
  visibleKeys(): Record<string, boolean>;
  /** Key of the row at the transcript's top edge, or ''. */
  topKey(): string;
  /** Rows or status changed outside `show` (a page arrived, a deadline passed). */
  changed(): void;
}

/** One outstanding (or failed) page request. */
interface HistoryRequest {
  id: string;
  epoch: string;
  direction: 'before' | 'after';
  position: HistoryPosition;
  /** Replace the resident older rows from `position` (Refresh). */
  refresh: boolean;
  /** Whether the reader followed the live end when asking. */
  following: boolean;
}

/** How long one page may take before it counts as failed (SessionView's deadline). */
export const historyDeadlineMilliseconds = 10_000;

const noReservation: RowsSize = { rows: 0, units: 0 };

export class ResidentHistory {
  private session: AgentSession | null = null;
  private displayedId = '';
  private online = false;
  // Older (or detached) rows. When `attached`, they end exactly where the
  // live window starts and the transcript continues into live rows.
  private historyRows: PositionedRow[] = [];
  private attached = false;
  // The previous live session object, to notice the window sliding forward.
  private previousLive: AgentSession | null = null;
  private pending: HistoryRequest | null = null;
  private error = '';
  private failed: HistoryRequest | null = null;
  // Boundaries ("before:index:offset") where a page brought nothing new.
  private stalled = new Set<string>();
  private deadline: ReturnType<typeof setTimeout> | undefined;
  // Whether the reader is at the live end (reported by the page).
  private followEnd = true;

  constructor(private readonly host: HistoryHost) {}

  // ---- Inputs ----------------------------------------------------------------

  /**
   * The shown conversation changed or was updated (SessionView.synchronize).
   * Another conversation, or the same ID in a new lifetime (another tool
   * epoch), starts again at its live end.
   */
  show(session: AgentSession | null): void {
    const id = session ? session.id : '';
    if (id !== this.displayedId) {
      this.reset();
      this.displayedId = id;
    }
    this.session = session;
    if (this.previousLive && session && this.previousLive.toolEpoch !== session.toolEpoch) {
      // A reconnect can reveal the same ID reopened by another client. Never
      // keep rows from the old lifetime under its successor's page token.
      this.reset();
    }
    this.keepEvictedRows();
    this.keepWithinBound();
    this.previousLive = session;
  }

  /** The connection went up or down. Going down forgets the pending request. */
  setOnline(online: boolean): void {
    this.online = online;
    if (!online && this.pending) {
      this.pending = null;
      this.stopDeadline();
    }
  }

  /**
   * The page reports whether the reader is at the transcript's end. Arriving
   * at the end of a detached snapshot continues it with the next newer page
   * (the desktop does this from its own scroll handler; the chat page reports
   * only this transition).
   */
  setFollowing(atEnd: boolean): void {
    if (atEnd && this.detached()) {
      this.loadNewer();
    }
    this.followEnd = atEnd && !this.detached();
  }

  /** The previous page, above the resident rows. */
  loadOlder(): void {
    const shown = this.shownHistory();
    if (!this.hasOlder() || !shown || this.stalledAt('before', shown.start)) {
      return;
    }
    this.loadHistory('before', shown.start, false);
  }

  /**
   * Below a detached snapshot: continue into the live window once the rows
   * reach it, otherwise load the next page. Rows loaded before a message grew
   * can stop short of the live start inside it; the rest then loads as an
   * ordinary page from where the loaded text really ends.
   */
  loadNewer(): void {
    const live = this.liveWindow();
    if (!this.detached() || !live) {
      return;
    }
    const shownBefore = this.shownHistory();
    if (shownBefore && HistoryRows.comparePositions(shownBefore.end, live.start) >= 0) {
      this.joinLiveWindow(this.historyRows);
      this.host.changed();
      if (!this.detached()) {
        return;
      }
    }
    const shown = this.shownHistory();
    if (!shown) {
      return;
    }
    const end = shown.end;
    if (HistoryRows.comparePositions(end, live.start) >= 0 || this.stalledAt('after', end)) {
      return;
    }
    this.loadHistory('after', end, false);
  }

  /** Reload the resident older rows from the row at the top of the view. */
  refresh(): void {
    if (this.historyRows.length === 0) {
      return;
    }
    const topKey = this.host.topKey();
    let position: HistoryPosition = this.historyRows[0].start;
    for (const row of this.rows()) {
      if (row.key === topKey && row.start) {
        position = row.start;
        break;
      }
    }
    this.loadHistory('after', position, true);
  }

  /** Back to the live end: drop resident pages and any pending request. */
  latest(): void {
    this.pending = null;
    this.stopDeadline();
    this.historyRows = [];
    this.attached = false;
    this.error = '';
    this.failed = null;
    this.stalled = new Set();
    this.followEnd = true;
  }

  /** Repeat the failed request; the reader's explicit action only. */
  retry(): void {
    const failed = this.failed;
    if (failed) {
      this.loadHistory(failed.direction, failed.position, failed.refresh);
    }
  }

  // ---- Outputs ---------------------------------------------------------------

  /** The resident rows in display order. */
  rows(): HistoryRow[] {
    const live = this.liveRows();
    if (this.historyRows.length === 0) {
      return live;
    }
    if (this.attached) {
      return [...this.historyRows, ...live];
    }
    return this.historyRows;
  }

  status(): HistoryStatus {
    const live = this.liveWindow();
    let changed = false;
    if (this.detached() && live) {
      for (const row of this.historyRows) {
        if (row.revision !== live.revision) {
          changed = true;
          break;
        }
      }
    }
    return {
      hasOlder: this.hasOlder(),
      pending: this.pending !== null,
      error: this.error,
      canRetry: this.error !== '' && this.failed !== null,
      changed: changed,
      detached: this.detached(),
      atLatest: this.followEnd && !this.detached(),
    };
  }

  /** Stop the deadline timer; the model is no longer used. */
  dispose(): void {
    this.stopDeadline();
    this.pending = null;
  }

  // ---- Requests --------------------------------------------------------------

  /** One request at a time; positions come from resident rows or the window. */
  private loadHistory(
    direction: 'before' | 'after',
    position: HistoryPosition,
    refresh: boolean,
  ): boolean {
    const session = this.session;
    if (!this.online || !session || !this.liveWindow() || this.pending) {
      return false;
    }
    this.error = '';
    this.failed = null;
    const request: HistoryRequest = {
      id: this.displayedId,
      epoch: session.toolEpoch ?? '',
      direction: direction,
      position: { index: position.index, offset: position.offset },
      refresh: refresh,
      following: this.followEnd,
    };
    this.pending = request;
    this.stopDeadline();
    this.deadline = setTimeout(() => this.expired(request), historyDeadlineMilliseconds);

    const reply = this.host.requestPage({
      id: request.id,
      epoch: request.epoch,
      direction: direction,
      index: position.index,
      offset: position.offset,
    });
    reply.then(
      (page) => this.received(request, page),
      (failure: unknown) => this.refused(request, failure),
    );
    return true;
  }

  private expired(request: HistoryRequest): void {
    if (this.pending !== request) {
      return;
    }
    this.pending = null;
    this.failed = request;
    this.error = 'History request timed out.';
    this.host.changed();
  }

  private refused(request: HistoryRequest, failure: unknown): void {
    if (this.pending !== request) {
      return;
    }
    this.pending = null;
    this.stopDeadline();
    let message = 'History unavailable';
    if (failure instanceof Error && failure.message) {
      message = failure.message;
    }
    this.error = message;
    this.failed = request;
    this.host.changed();
  }

  /** A page arrived for `request` (SessionView's onToolPageReceived). */
  private received(request: HistoryRequest, page: HistoryPage): void {
    if (this.pending !== request) {
      // Superseded: another conversation, Latest, a timeout or a disconnect.
      return;
    }
    this.pending = null;
    this.stopDeadline();
    const session = this.session;
    const live = this.liveWindow();
    if (
      !session ||
      request.id !== this.displayedId ||
      request.epoch !== session.toolEpoch ||
      !live
    ) {
      this.host.changed();
      return;
    }
    if (!page || page.id !== request.id || page.epoch !== request.epoch || !page.history) {
      this.host.changed();
      return;
    }
    const rows = HistoryRows.rowsFrom(
      page.messages || [],
      page.history.start,
      page.history.revision,
    );
    const boundary = request.position;
    const stall = request.direction + ':' + HistoryRows.positionKey(boundary);

    if (request.refresh) {
      this.stalled = new Set();
      this.followEnd = false;
      this.replaceHistory(rows);
      this.host.changed();
      return;
    }

    // Only join a page that ends (or starts) exactly where the transcript now
    // starts (or ends). Anything else answers a superseded view: drop it.
    const shown = this.shownHistory();
    if (request.direction === 'before') {
      if (
        !HistoryRows.samePosition(page.history.end, boundary) ||
        !shown ||
        !HistoryRows.samePosition(shown.start, boundary)
      ) {
        this.host.changed();
        return;
      }
      if (rows.length === 0) {
        this.stalled.add(stall);
        this.host.changed();
        return;
      }
      // A reader who scrolled up for it and has since returned to the live
      // end no longer wants it.
      if (!request.following && this.followEnd && !this.detached()) {
        this.host.changed();
        return;
      }
      const reading = this.historyRows.length > 0;
      this.applyHistory([...rows, ...this.historyRows], reading ? this.attached : true, 'end');
    } else {
      if (
        !this.detached() ||
        !shown ||
        !HistoryRows.samePosition(page.history.start, boundary) ||
        !HistoryRows.samePosition(shown.end, boundary)
      ) {
        this.host.changed();
        return;
      }
      if (rows.length === 0) {
        this.stalled.add(stall);
      } else if (!this.applyHistory([...this.historyRows, ...rows], false, 'start')) {
        this.host.changed();
        return;
      }
      const after = this.shownHistory();
      if (this.detached() && after && HistoryRows.comparePositions(after.end, live.start) >= 0) {
        this.joinLiveWindow(this.historyRows);
      }
    }
    this.host.changed();
  }

  private stopDeadline(): void {
    if (this.deadline !== undefined) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
    }
  }

  // ---- Resident rows ---------------------------------------------------------

  /** The live window's position metadata, or null for listeners without paging. */
  private liveWindow() {
    if (this.session && this.session.history) {
      return this.session.history;
    }
    return null;
  }

  private detached(): boolean {
    return this.historyRows.length > 0 && !this.attached;
  }

  /** The range the resident rows cover in authoritative history. */
  private shownHistory(): { start: HistoryPosition; end: HistoryPosition } | null {
    const live = this.liveWindow();
    if (!live) {
      return null;
    }
    if (this.historyRows.length === 0) {
      return { start: live.start, end: live.end };
    }
    const first = this.historyRows[0];
    const last = this.historyRows[this.historyRows.length - 1];
    if (this.detached()) {
      return { start: first.start, end: last.end };
    }
    return { start: first.start, end: live.end };
  }

  private hasOlder(): boolean {
    const shown = this.shownHistory();
    if (!shown) {
      return false;
    }
    return shown.start.index > 0 || shown.start.offset > 0;
  }

  private stalledAt(direction: 'before' | 'after', position: HistoryPosition): boolean {
    return this.stalled.has(direction + ':' + HistoryRows.positionKey(position));
  }

  /**
   * Live window rows with their positions. Listeners without paging omit
   * `history`; their rows carry no positions and never load other pages.
   */
  private liveRows(): HistoryRow[] {
    const session = this.session;
    if (!session) {
      return [];
    }
    const live = this.liveWindow();
    if (!live) {
      const rows: HistoryRow[] = [];
      for (const message of session.messages) {
        rows.push({
          key: HistoryRows.rowKey(message),
          message: message,
          start: null,
          end: null,
          revision: 0,
          live: true,
        });
      }
      return rows;
    }
    const rows = HistoryRows.rowsFrom(session.messages, live.start, live.revision);
    for (const row of rows) {
      row.live = true;
    }
    return rows;
  }

  /** Positioned live rows only (empty for listeners without paging). */
  private positionedLiveRows(): PositionedRow[] {
    const session = this.session;
    const live = this.liveWindow();
    if (!session || !live) {
      return [];
    }
    return HistoryRows.rowsFrom(session.messages, live.start, live.revision);
  }

  /** A copy of the live rows that no longer follows updates. */
  private frozenLiveRows(): PositionedRow[] {
    const rows = this.positionedLiveRows();
    for (const row of rows) {
      row.live = false;
    }
    return rows;
  }

  /** The current length of the row the live window starts inside, if any. */
  private liveStartTotal(): number {
    const live = this.liveWindow();
    const session = this.session;
    if (!live || !session || live.start.offset === 0) {
      return 0;
    }
    const first = session.messages[0];
    if (first && first.historyFragment) {
      return first.historyFragment.total;
    }
    return 0;
  }

  /**
   * Keep older rows within the resident bound, trimming from `side`: the end
   * away from where rows were just added. When the far end is the live window
   * itself, it becomes a detached copy so the oldest loaded rows stay. If the
   * bound would remove rows the reader can see, nothing changes and this
   * returns false: the page is dropped rather than the reader's view.
   */
  private applyHistory(rows: PositionedRow[], attached: boolean, side: 'start' | 'end'): boolean {
    const visible = this.host.visibleKeys();
    let joined = attached;
    let reserved = noReservation;
    if (joined) {
      reserved = HistoryRows.sizeOf(this.liveRows());
    }
    let candidate = rows;
    if (!HistoryRows.withinBudget(candidate, reserved)) {
      if (joined && side === 'end') {
        candidate = [...candidate, ...this.frozenLiveRows()];
        joined = false;
        reserved = noReservation;
      }
      const kept = HistoryRows.trimmed(candidate, side, visible, reserved);
      let dropped: PositionedRow[];
      if (side === 'start') {
        dropped = candidate.slice(0, candidate.length - kept.length);
      } else {
        dropped = candidate.slice(kept.length);
      }
      for (const row of dropped) {
        if (visible[row.key] === true) {
          return false;
        }
      }
      candidate = kept;
    }
    this.historyRows = candidate;
    this.attached = joined && candidate.length > 0;
    return true;
  }

  /**
   * Older rows that reach the live window's start continue into it: keep only
   * the part before that start (shortening a spanning fragment). Rows that
   * stop short of it stay a detached snapshot ending at their loaded text.
   */
  private joinLiveWindow(rows: PositionedRow[]): boolean {
    const live = this.liveWindow();
    if (!live) {
      return false;
    }
    const cut = HistoryRows.rowsBefore(rows, live.start, this.liveStartTotal());
    return this.applyHistory(cut.rows, cut.complete, 'start') && cut.complete;
  }

  /** Refresh: the new rows replace the resident ones, joined when they reach live. */
  private replaceHistory(rows: PositionedRow[]): void {
    const live = this.liveWindow();
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    if (live && last && HistoryRows.comparePositions(last.end, live.start) >= 0) {
      this.joinLiveWindow(rows);
    } else {
      this.applyHistory(rows, false, 'start');
    }
  }

  /**
   * The recent window slides forward as rows arrive. While the reader is away
   * from the live end, the rows it drops stay resident and joined, so nothing
   * the reader sees moves. If that cannot stay contiguous and bounded without
   * removing visible rows, the view becomes a detached snapshot instead.
   */
  private keepEvictedRows(): void {
    const previous = this.previousLive;
    const session = this.session;
    const current = this.liveWindow();
    if (!previous || !previous.history || !current || !session) {
      return;
    }
    if (previous.id !== session.id || previous.toolEpoch !== session.toolEpoch) {
      return;
    }
    if (HistoryRows.samePosition(previous.history.start, current.start) || this.detached()) {
      return;
    }
    if (this.followEnd) {
      this.historyRows = [];
      this.attached = false;
      return;
    }
    const previousRows = HistoryRows.rowsFrom(
      previous.messages,
      previous.history.start,
      previous.history.revision,
    );
    // Joined older rows end where the previous window started.
    const joined = [...this.historyRows, ...previousRows];
    const cut = HistoryRows.rowsBefore(joined, current.start, this.liveStartTotal());
    const kept = cut.rows;
    let contiguous = false;
    if (cut.complete) {
      if (kept.length === 0) {
        const first = joined.length > 0 ? joined[0].start : current.start;
        contiguous = HistoryRows.comparePositions(current.start, first) <= 0;
      } else {
        contiguous = HistoryRows.samePosition(kept[kept.length - 1].end, current.start);
      }
    }
    const visible = this.host.visibleKeys();
    if (contiguous) {
      const rows = HistoryRows.trimmed(kept, 'start', visible, HistoryRows.sizeOf(this.liveRows()));
      const dropped = kept.slice(0, kept.length - rows.length);
      let visibleDropped = false;
      for (const row of dropped) {
        if (visible[row.key] === true) {
          visibleDropped = true;
          break;
        }
      }
      if (!visibleDropped) {
        this.historyRows = rows;
        this.attached = rows.length > 0;
        return;
      }
    }
    this.historyRows = HistoryRows.trimmed(joined, 'end', visible, noReservation);
    this.attached = false;
  }

  /**
   * Live rows can also grow without the window moving (a long answer still
   * streaming). Joined older rows then give way from the oldest end; if the
   * reader is looking at those, the view becomes a detached snapshot instead.
   */
  private keepWithinBound(): void {
    if (!this.attached || this.historyRows.length === 0) {
      return;
    }
    const live = HistoryRows.sizeOf(this.liveRows());
    if (HistoryRows.withinBudget(this.historyRows, live)) {
      return;
    }
    if (this.followEnd) {
      this.historyRows = [];
      this.attached = false;
      return;
    }
    const visible = this.host.visibleKeys();
    const kept = HistoryRows.trimmed(this.historyRows, 'start', visible, live);
    const dropped = this.historyRows.slice(0, this.historyRows.length - kept.length);
    let visibleDropped = false;
    for (const row of dropped) {
      if (visible[row.key] === true) {
        visibleDropped = true;
        break;
      }
    }
    if (!visibleDropped) {
      this.historyRows = kept;
      this.attached = kept.length > 0;
      return;
    }
    this.historyRows = HistoryRows.trimmed(
      [...this.historyRows, ...this.frozenLiveRows()],
      'end',
      visible,
      noReservation,
    );
    this.attached = false;
  }

  /** Forget everything of the previous conversation (SessionView.resetHistory). */
  private reset(): void {
    this.historyRows = [];
    this.attached = false;
    this.previousLive = null;
    this.pending = null;
    this.error = '';
    this.failed = null;
    this.stalled = new Set();
    this.followEnd = true;
    this.stopDeadline();
  }
}
