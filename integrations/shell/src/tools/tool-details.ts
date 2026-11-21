/**
 * In-place tool details of the shown conversation's tool groups: which
 * groups the reader opened, the one page each shows, and the request for it.
 *
 * This is a TypeScript port of the desktop's classic view
 * (integrations/panel/ToolDetails.qml and the `expandedRows` of
 * SessionView.qml), so the rules are the desktop's:
 *
 * - A tool-group row opens and closes in place. Opening one with stored
 *   calls asks for its first page (`agent-tool-page`, index 0, offset 0).
 *   A page holds at most 8,192 characters of one call: its name, input and
 *   output (the listener's bound, src/agents/tool-transcripts.ts). A page
 *   replaces the one shown; Next page continues in the same call and then
 *   with the next call, From start goes back to the first page.
 * - One request per group at a time. Only the latest request's answer is
 *   applied: closing the group, a newer request, another conversation or a
 *   new lifetime of the same one (another tool epoch) drop older answers.
 *   An answer is also checked against the conversation, lifetime and group
 *   it was asked for, as the desktop does.
 * - A failure (a refusal, a lost answer, the 10 s deadline, a lost
 *   connection) is shown with
 *   Try again, which asks again for the page that failed, as a fresh read
 *   of that position (without the call revision a continuation named: a
 *   call that changed meanwhile would otherwise be refused again and
 *   again); nothing is retried by itself. Losing the connection clears
 *   every open group's page (the desktop's "Disconnected. Reload after
 *   reconnecting.").
 * - The group's revision changes while calls arrive (the turn still runs):
 *   the page shown stays, marked as having newer output; Refresh page loads
 *   the shown page again. The count follows the row.
 * - Closing a group forgets its page. Switching to another conversation (or
 *   a new lifetime of this one) closes every group, as on the desktop; a
 *   group whose row is no longer resident is forgotten.
 * - A tool row without stored calls (a single legacy tool message,
 *   `toolCount` 0) opens to its own input and output, without a request.
 *
 * Inputs: the shown conversation (`show`), whether requests are admitted
 * (`setOnline`), the resident rows (`sync`) and the reader's actions
 * (`act`). Output: `details(row)` for each tool row, which the bridge puts
 * into the row it sends the page (`ChatRow.tools`), and `host.changed()`
 * whenever that output changed without one of these inputs.
 */

import type { AgentSession } from '../../../../src/agents/types.ts';
import type { HistoryRow } from '../../../panel/HistoryRows.mjs';
import type { ChatToolDetails, ToolDetailsAction } from '../../../session-apps/chat/protocol.ts';

/** The `agent-tool-page` parameters (src/remote/protocol.ts). */
export interface ToolPageRequest {
  id: string;
  epoch: string;
  groupId: string;
  revision: string;
  callRevision?: string;
  index: number;
  offset: number;
}

/** The listener's answer (src/agents/tool-transcripts.ts `ToolPage`). */
export interface ToolPageAnswer {
  id?: string;
  epoch?: string;
  groupId?: string;
  revision?: string;
  callRevision?: string;
  index?: number;
  offset?: number;
  text?: string;
  state?: string;
  next?: { index: number; offset: number } | null;
}

/** What the model needs from its surroundings. */
export interface ToolDetailsHost {
  /** Ask the gateway for one page; rejects with an Error on failure. */
  requestPage(request: ToolPageRequest): Promise<ToolPageAnswer>;
  /** The output changed outside an input call (an answer, a deadline). */
  changed(): void;
}

/** How long one page may take before it counts as failed (ToolDetails.qml's deadline). */
export const toolPageDeadlineMilliseconds = 10_000;

/** The desktop's texts (ToolDetails.qml), so both clients say the same. */
export const toolTexts = {
  loading: 'Loading tool details…',
  failed: 'Could not load tool details.',
  disconnected: 'Disconnected. Reload after reconnecting.',
  timedOut: 'Tool details timed out. Try reloading.',
  changed: 'Tool output changed. Refresh this page.',
  newer: 'New tool output is available. Refresh this page to update it.',
};

/** A page position: the call's index in the group and the offset in its text. */
interface PagePosition {
  index: number;
  offset: number;
  /** The call's revision when continuing in the same call, else ''. */
  callRevision: string;
}

/** One open group. Mirrors ToolDetails.qml's properties. */
interface OpenGroup {
  /** The row's key and its message ID (the group ID). */
  key: string;
  groupId: string;
  /** The group's revision and call count as the row last had them. */
  revision: string;
  count: number;
  /** A legacy tool row: its own text, no requests. */
  legacy: boolean;
  legacyText: string;
  /** The request on its way (its number), or 0. */
  pending: number;
  pendingPosition: PagePosition | null;
  /** The request Try again repeats, after a failure. */
  failedPosition: PagePosition | null;
  deadline: ReturnType<typeof setTimeout> | undefined;
  /** The page shown. */
  loaded: boolean;
  body: string;
  next: { index: number; offset: number } | null;
  callIndex: number;
  offset: number;
  callState: string;
  callRevision: string;
  /** Newer output exists than the page shown. */
  outdated: boolean;
  error: string;
}

export class ToolDetails {
  private sessionId = '';
  private epoch = '';
  private online = false;
  private readonly groups = new Map<string, OpenGroup>();
  // Numbers every request; an answer applies only while its number is the
  // group's `pending`.
  private requestNumber = 0;

  constructor(private readonly host: ToolDetailsHost) {}

  // ---- Inputs ----------------------------------------------------------------

  /**
   * The shown conversation. Another conversation, or the same ID in a new
   * lifetime (another tool epoch), closes every group.
   */
  show(session: AgentSession | null): void {
    let id = '';
    let epoch = '';
    if (session) {
      id = session.id;
      epoch = session.toolEpoch ?? '';
    }
    if (id === this.sessionId && epoch === this.epoch) {
      return;
    }
    this.closeAll();
    this.sessionId = id;
    this.epoch = epoch;
  }

  /**
   * Requests are admitted, or no longer. Going offline forgets every open
   * group's page and request, and says so (the group stays open); after
   * reconnecting the reader loads it again.
   */
  setOnline(online: boolean): void {
    if (online === this.online) {
      return;
    }
    this.online = online;
    if (online) {
      return;
    }
    for (const group of this.groups.values()) {
      if (group.legacy) {
        continue;
      }
      // Try again after reconnecting asks for the page that was on its way,
      // failed, or shown: the page itself is cleared, not the reader's place.
      let place: PagePosition | null = group.pendingPosition ?? group.failedPosition;
      if (!place && group.loaded) {
        place = { index: group.callIndex, offset: group.offset, callRevision: '' };
      }
      this.invalidate(group, toolTexts.disconnected);
      if (place) {
        group.failedPosition = retryPosition(place);
      }
    }
  }

  /**
   * The resident rows changed. A group whose row is gone, or whose key now
   * names another message, is forgotten; a group whose revision changed
   * keeps its page, marked as having newer output.
   */
  sync(rows: HistoryRow[]): void {
    if (this.groups.size === 0) {
      return;
    }
    const byKey = new Map<string, HistoryRow>();
    for (const row of rows) {
      byKey.set(row.key, row);
    }
    for (const group of [...this.groups.values()]) {
      const row = byKey.get(group.key);
      if (!row || row.message.id !== group.groupId || row.message.kind !== 'tool') {
        this.close(group);
        continue;
      }
      const toolGroup = row.message.toolGroup;
      if (group.legacy) {
        group.legacyText = legacyText(row);
        continue;
      }
      if (!toolGroup) {
        continue;
      }
      group.count = toolGroup.count;
      if (toolGroup.revision !== group.revision) {
        group.revision = toolGroup.revision;
        if (group.loaded || group.pending !== 0) {
          group.outdated = true;
        }
      }
    }
  }

  /**
   * The reader's action on the tool row `row` of the shown conversation.
   * Returns whether anything changed.
   */
  act(row: HistoryRow, action: ToolDetailsAction): boolean {
    if (row.message.kind !== 'tool') {
      return false;
    }
    const open = this.groups.get(row.key);
    if (action === 'toggle') {
      if (open) {
        this.close(open);
      } else {
        this.open(row);
      }
      return true;
    }
    if (!open || open.legacy || !this.online || open.pending !== 0) {
      return false;
    }
    if (action === 'reload') {
      if (open.failedPosition) {
        this.load(open, open.failedPosition);
      } else {
        this.load(open, { index: open.callIndex, offset: open.offset, callRevision: '' });
      }
      return true;
    }
    if (action === 'start') {
      this.load(open, { index: 0, offset: 0, callRevision: '' });
      return true;
    }
    if (action === 'next' && open.next) {
      let callRevision = '';
      if (open.next.index === open.callIndex) {
        callRevision = open.callRevision;
      }
      this.load(open, { index: open.next.index, offset: open.next.offset, callRevision });
      return true;
    }
    return false;
  }

  // ---- Output -----------------------------------------------------------------

  /**
   * What the page shows for one tool row: closed, or open with its status,
   * page and actions. Undefined for rows that are not tool groups.
   */
  details(row: HistoryRow): ChatToolDetails | undefined {
    if (row.message.kind !== 'tool') {
      return undefined;
    }
    const group = this.groups.get(row.key);
    if (!group || group.groupId !== row.message.id) {
      return closedDetails();
    }
    if (group.legacy) {
      return {
        open: true,
        status: '',
        failed: false,
        text: group.legacyText,
        loaded: group.legacyText !== '',
        reload: '',
        next: false,
        restart: false,
        busy: false,
      };
    }

    const pending = group.pending !== 0;
    let status = '';
    if (pending) {
      status = toolTexts.loading;
    } else if (group.error) {
      status = group.error;
    } else {
      if (group.outdated) {
        status = toolTexts.newer + '\n';
      }
      if (group.loaded) {
        status += pageLine(group);
      }
    }

    let reload = 'Load details';
    if (group.error && !pending) {
      reload = 'Try again';
    } else if (group.loaded) {
      reload = 'Refresh page';
    }

    return {
      open: true,
      status: status,
      failed: group.error !== '' && !pending,
      text: group.body,
      loaded: group.loaded,
      reload: reload,
      next: group.next !== null,
      restart: group.loaded && (group.callIndex > 0 || group.offset > 0),
      busy: pending || !this.online,
    };
  }

  /** Keys of the open groups (for tests and the bridge's checks). */
  openKeys(): string[] {
    return [...this.groups.keys()];
  }

  // ---- Groups -------------------------------------------------------------------

  private open(row: HistoryRow): void {
    const toolGroup = row.message.toolGroup;
    const legacy = !toolGroup || toolGroup.count === 0;
    const group: OpenGroup = {
      key: row.key,
      groupId: row.message.id,
      revision: toolGroup ? toolGroup.revision : '',
      count: toolGroup ? toolGroup.count : 0,
      legacy: legacy,
      legacyText: legacy ? legacyText(row) : '',
      pending: 0,
      pendingPosition: null,
      failedPosition: null,
      deadline: undefined,
      loaded: false,
      body: '',
      next: null,
      callIndex: 0,
      offset: 0,
      callState: '',
      callRevision: '',
      outdated: false,
      error: '',
    };
    this.groups.set(row.key, group);
    if (legacy) {
      return;
    }
    if (!this.online) {
      group.error = toolTexts.disconnected;
      return;
    }
    this.load(group, { index: 0, offset: 0, callRevision: '' });
  }

  private close(group: OpenGroup): void {
    this.stopDeadline(group);
    group.pending = 0;
    this.groups.delete(group.key);
  }

  private closeAll(): void {
    for (const group of [...this.groups.values()]) {
      this.close(group);
    }
  }

  /** ToolDetails.qml's invalidate(): forget the page and any request. */
  private invalidate(group: OpenGroup, reason: string): void {
    this.stopDeadline(group);
    group.pending = 0;
    group.pendingPosition = null;
    group.failedPosition = null;
    group.body = '';
    group.next = null;
    group.loaded = false;
    group.callIndex = 0;
    group.offset = 0;
    group.callRevision = '';
    group.outdated = false;
    group.error = reason;
  }

  private stopDeadline(group: OpenGroup): void {
    if (group.deadline !== undefined) {
      clearTimeout(group.deadline);
      group.deadline = undefined;
    }
  }

  /** Ask for one page of `group` (ToolDetails.qml's load()). */
  private load(group: OpenGroup, position: PagePosition): void {
    this.requestNumber++;
    const number = this.requestNumber;
    group.pending = number;
    group.pendingPosition = position;
    group.error = '';
    this.stopDeadline(group);
    // The deadline is the desktop's; the phone Connection's own (longer)
    // timeout and its disconnect handling also end the request.
    group.deadline = setTimeout(() => {
      group.deadline = undefined;
      if (this.groups.get(group.key) !== group || group.pending !== number) {
        return;
      }
      this.invalidate(group, toolTexts.timedOut);
      // Try again asks for the page that timed out, not the first one.
      group.failedPosition = retryPosition(position);
      this.host.changed();
    }, toolPageDeadlineMilliseconds);

    const request: ToolPageRequest = {
      id: this.sessionId,
      epoch: this.epoch,
      groupId: group.groupId,
      revision: group.revision,
      index: position.index,
      offset: position.offset,
    };
    if (position.callRevision) {
      request.callRevision = position.callRevision;
    }

    const asked = { sessionId: this.sessionId, epoch: this.epoch };
    this.host.requestPage(request).then(
      (answer) => {
        if (!this.current(group, number)) {
          return;
        }
        this.receive(group, request, position, answer, asked);
        this.host.changed();
      },
      (failure: unknown) => {
        if (!this.current(group, number)) {
          return;
        }
        this.stopDeadline(group);
        group.pending = 0;
        group.pendingPosition = null;
        group.failedPosition = retryPosition(position);
        let message = toolTexts.failed;
        if (failure instanceof Error && failure.message) {
          message = failure.message;
        }
        group.error = message;
        this.host.changed();
      },
    );
  }

  /** Whether request `number` of `group` is still the one wanted. */
  private current(group: OpenGroup, number: number): boolean {
    return this.groups.get(group.key) === group && group.pending === number;
  }

  /** ToolDetails.qml's receive(), for the group's current request. */
  private receive(
    group: OpenGroup,
    request: ToolPageRequest,
    position: PagePosition,
    answer: ToolPageAnswer,
    asked: { sessionId: string; epoch: string },
  ): void {
    this.stopDeadline(group);
    group.pending = 0;
    group.pendingPosition = null;

    // An answer for another conversation, lifetime or group is not this
    // page (the desktop drops it the same way).
    if (
      !answer ||
      typeof answer.text !== 'string' ||
      answer.id !== asked.sessionId ||
      answer.epoch !== asked.epoch ||
      answer.groupId !== group.groupId
    ) {
      group.failedPosition = retryPosition(position);
      group.error = toolTexts.failed;
      return;
    }
    // The group changed between the request and the answer, and the page is
    // not a continuation of one call: refresh to see the current output.
    if (answer.revision !== group.revision && !request.callRevision) {
      group.outdated = true;
      group.failedPosition = retryPosition(position);
      group.error = toolTexts.changed;
      return;
    }
    // A continuation of a call that changed meanwhile is another call's text.
    if (request.callRevision && answer.callRevision !== request.callRevision) {
      group.failedPosition = retryPosition(position);
      group.error = toolTexts.changed;
      return;
    }

    group.failedPosition = null;
    group.error = '';
    group.body = answer.text;
    group.next = validNext(answer.next);
    group.callIndex = numberOr(answer.index, position.index);
    group.offset = numberOr(answer.offset, position.offset);
    group.callState = typeof answer.state === 'string' ? answer.state : 'done';
    group.callRevision = typeof answer.callRevision === 'string' ? answer.callRevision : '';
    group.outdated = answer.revision !== group.revision;
    group.loaded = true;
  }
}

/**
 * The request Try again sends after `position` failed: the same call and
 * offset, read afresh with the group's current revision.
 */
function retryPosition(position: PagePosition): PagePosition {
  return { index: position.index, offset: position.offset, callRevision: '' };
}

/** A closed group: present, so the page offers to open it here. */
function closedDetails(): ChatToolDetails {
  return {
    open: false,
    status: '',
    failed: false,
    text: '',
    loaded: false,
    reload: '',
    next: false,
    restart: false,
    busy: false,
  };
}

/** "Tool 2 of 5 · running · characters 1–8192" (ToolDetails.qml's status line). */
function pageLine(group: OpenGroup): string {
  let state = '';
  if (group.callState === 'running') {
    state = ' · running';
  } else if (group.callState === 'error') {
    state = ' · failed or stopped';
  }
  const first = group.offset + 1;
  const last = group.offset + group.body.length;
  return `Tool ${group.callIndex + 1} of ${group.count}${state} · characters ${first}–${last}`;
}

/** A legacy tool row's text, as the classic view shows it: input, then output. */
function legacyText(row: HistoryRow): string {
  const message = row.message;
  if (message.text) {
    return message.input + '\n\n' + message.text;
  }
  return message.input;
}

function validNext(next: unknown): { index: number; offset: number } | null {
  if (!next || typeof next !== 'object') {
    return null;
  }
  const candidate = next as { index?: unknown; offset?: unknown };
  if (!Number.isSafeInteger(candidate.index) || !Number.isSafeInteger(candidate.offset)) {
    return null;
  }
  return { index: candidate.index as number, offset: candidate.offset as number };
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  return fallback;
}
