/**
 * The permission rows of a session application: whether it may read the
 * conversation's chat and send messages into it (integrations/shell/README.md,
 * "Session applications", permission rule). Without DOM access; drawn by
 * PermissionRows.tsx, in the shell's own page, never by the application.
 *
 * A port of the desktop's native controls (`../../../panel/SessionView.qml`,
 * the `appChat…` properties and functions), with the same identity, the
 * same review → allow steps and the same texts:
 *
 * - The **identity** of what the rows show is the conversation, the
 *   application's ID and code version and the permission `revision`
 *   (`chatAccess.revision`). Any change of it (another conversation, new
 *   code, a reopen, a permission change made here or elsewhere) closes an
 *   open review, forgets a change waiting for its answer (its answer is
 *   then ignored) and clears an error, so a decision is never taken on
 *   stale controls and never applied to another identity.
 * - **Allowing** needs a review first (the disclosure text), each
 *   permission its own; **revoking** needs none. A change names the
 *   identity it was taken on; the listener refuses it when that is no
 *   longer current.
 * - **Nothing is shown as changed before the listener says so**: the rows
 *   always draw the `chatAccess` the listener last sent. A change waiting
 *   for its answer only says "Waiting for permission confirmation…".
 * - An answer that was lost (the connection dropped or timed out while it
 *   waited: the phone Connection's `UncertainOutcome`, which never resends
 *   a request) says the desktop's "No confirmation received. Permission may
 *   have changed; check its current status before trying again." The rows
 *   then show the state the reconnect's snapshot brings.
 *
 * One object per pairing (the workspace's). Subscribers are told after
 * every change the reader or an answer makes; `observe` (a new identity)
 * is applied by the drawing itself.
 */

import type { ApplicationChatAccess, ShownApplication } from './shown-application.ts';

/** Messages one grant may send (the listener's `applicationSendLimits`, 5 today). */
export const messagesPerGrant = 5;

export type PermissionKind = 'read' | 'send';

/** What a permission change sends: the gateway's request and its fields. */
export interface PermissionRequest {
  action: 'set-application-chat-read' | 'set-application-chat-send';
  parameters: {
    id: string;
    applicationId: string;
    version: number;
    revision: string;
    allowed: boolean;
  };
}

/**
 * How a change leaves the page: resolves with the listener's result,
 * rejects with its refusal, or with an error whose `uncertain` is true
 * when the answer was lost.
 */
export type PermissionSender = (request: PermissionRequest) => Promise<unknown>;

/** The desktop's texts (SessionView.qml). */
export const readDisclosure =
  'Allow this app to read recent text from this conversation, including earlier messages and live replies? Drafts, tools and attachments are excluded.\n\n' +
  'The app can copy text into its saved state or agent-visible actions. Revoking stops future reads but cannot erase copies. In-flight reads may finish. Access ends when app code changes, the conversation is reopened, or Companion restarts. Sending requires separate permission.';

export const sendDisclosure =
  "Allow this exact app code to send up to 5 messages to this conversation's agent, without asking you for each message? These are labelled app messages, not authenticated human input or new authorization. Reading and drafts are not granted.\n\n" +
  "One app message can be active at a time, with at least two seconds between admissions. Failed or uncertain attempts can consume quota; they are never retried automatically. Revoking or replacing code withdraws unstarted app messages, but already-running work may have effects and continues until finished or stopped. Use the conversation's Stop control to halt it; Stop also revokes sending.\n\n" +
  'A new grant replaces the old quota and withdraws unstarted app messages. Existing application-edit notifications remain separate; this quota covers app chat sends only. Consent ends on code replacement, close/reopen or Companion restart. Merely hiding this view does not revoke backend consent.';

export const waitingText = 'Waiting for permission confirmation…';

export const noConfirmationText =
  'No confirmation received. Permission may have changed; check its current status before trying again.';

/** The line under the rows (the agreed design's). */
export const scopeText =
  "Applies to this open conversation until it is closed or the app's code changes, on every screen that shows it. Changed here or on the desktop; both show the same state.";

/** The permission identity of what the rows show (see above), or ''. */
export function permissionIdentity(
  sessionId: string,
  application: ShownApplication | null,
): string {
  if (!application || application.kind !== 'frame' || !application.chatAccess) {
    return '';
  }
  return (
    sessionId +
    ':' +
    application.id +
    ':' +
    application.version +
    ':' +
    application.chatAccess.revision
  );
}

export function readRequested(access: ApplicationChatAccess | null): boolean {
  return access !== null && access.requested.includes('chat.read');
}

export function sendRequested(access: ApplicationChatAccess | null): boolean {
  return access !== null && access.requested.includes('chat.send');
}

/**
 * The short status in the application's bar (the desktop's collapsed
 * `appChatPermissionSummary`): reading on or off; sending on with the
 * messages left, used up, off or unavailable; an app message active;
 * Disconnected. '' when the application asks for neither.
 */
export function permissionSummary(access: ApplicationChatAccess | null, online: boolean): string {
  const parts: string[] = [];
  if (readRequested(access)) {
    let reading = 'off';
    if (access?.read) {
      reading = 'on';
    }
    parts.push('Chat reading ' + reading);
  }
  if (sendRequested(access)) {
    const send = access?.send ?? null;
    if (!send) {
      parts.push('sending unavailable');
    } else if (!send.allowed) {
      parts.push('sending off');
    } else if (send.remaining > 0) {
      parts.push(`sending on, ${send.remaining}/${messagesPerGrant} left`);
    } else {
      parts.push('sending used up');
    }
    if (send && send.busy) {
      parts.push('app message active');
    }
  }
  if (parts.length > 0 && !online) {
    parts.push('Disconnected');
  }
  return parts.join(' · ');
}

/** The reading row's status (the desktop's `appChatPermissionStatus`, without the name). */
export function readStatus(access: ApplicationChatAccess | null, online: boolean): string {
  let text = 'Chat reading off';
  if (access?.read) {
    text = 'Chat reading allowed';
  }
  if (!online) {
    text += ' · Disconnected';
  }
  return text;
}

/** The sending row's status (the desktop's `appChatSendStatus`). */
export function sendStatus(access: ApplicationChatAccess | null): string {
  const send = access?.send ?? null;
  let text = 'App sending ';
  if (!send) {
    text += 'unavailable on this host';
  } else if (send.allowed) {
    let state = 'exhausted';
    if (send.remaining > 0) {
      state = 'allowed';
    }
    text += `${state} · ${send.remaining} of ${messagesPerGrant} attempts remaining`;
  } else {
    text += 'off';
  }
  if (send && send.busy) {
    text += ' · app message active';
  }
  return text;
}

/** A change waiting for its answer. */
interface Pending {
  requestId: number;
  kind: PermissionKind;
  identity: string;
}

/** What the rows draw, besides the listener's `chatAccess`. */
export interface PermissionRowsState {
  /** The rows are shown (Permissions…, or something keeps them open). */
  open: boolean;
  /** The reading review (its disclosure and Allow) is open. */
  reviewingRead: boolean;
  /** The sending review is open. */
  reviewingSend: boolean;
  /** A change waits for its answer. */
  waiting: boolean;
  /** The line under the rows: waiting, a refusal, or ''. */
  feedback: string;
  /** Hide permissions is offered (shown by Permissions…, nothing keeps them open). */
  canHide: boolean;
}

export class ChatPermissions {
  // What the rows show now: the conversation and the identity.
  private conversation = '';
  private identity = '';
  // The reader pressed Permissions… for this conversation.
  private expanded = false;
  // The identity each review was opened for ('' when closed).
  private readReview = '';
  private sendReview = '';
  private pending: Pending | null = null;
  private error = '';
  private nextRequestId = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The rows now show `sessionId` with the permission `identity`
   * (permissionIdentity). Another conversation collapses them; another
   * identity closes the reviews and forgets a waiting change and an error.
   * Idempotent. Called while drawing, right before `state()`, so it tells
   * no subscriber: the drawing that called it already shows the result.
   */
  observe(sessionId: string, identity: string): void {
    if (sessionId !== this.conversation) {
      this.conversation = sessionId;
      this.expanded = false;
    }
    if (identity !== this.identity) {
      this.identity = identity;
      this.readReview = '';
      this.sendReview = '';
      this.pending = null;
      this.error = '';
    }
  }

  /** What the rows draw now (see PermissionRowsState). */
  state(): PermissionRowsState {
    const reviewingRead = this.identity !== '' && this.readReview === this.identity;
    const reviewingSend = this.identity !== '' && this.sendReview === this.identity;
    const waiting = this.pending !== null;
    let feedback = this.error;
    if (waiting) {
      feedback = waitingText;
    }
    return {
      open: this.expanded || reviewingRead || reviewingSend || waiting || this.error !== '',
      reviewingRead,
      reviewingSend,
      waiting,
      feedback,
      canHide: this.expanded && !reviewingRead && !reviewingSend && !waiting,
    };
  }

  /** Whether a change may start now: requests admitted, nothing waiting. */
  canChange(admitted: boolean, access: ApplicationChatAccess | null): boolean {
    if (!admitted || this.identity === '' || this.pending !== null) {
      return false;
    }
    return readRequested(access) || sendRequested(access);
  }

  /** Permissions… */
  expand(): void {
    this.expanded = true;
    this.notify();
  }

  /** Hide permissions (also clears an error, as on the desktop). */
  collapse(): void {
    this.expanded = false;
    this.error = '';
    this.notify();
  }

  /** Review reading, or sending: opens that review and closes the other. */
  review(kind: PermissionKind, admitted: boolean, access: ApplicationChatAccess | null): boolean {
    if (!this.canChange(admitted, access)) {
      return false;
    }
    if (kind === 'read') {
      if (!readRequested(access)) {
        return false;
      }
      this.readReview = this.identity;
      this.sendReview = '';
    } else {
      if (!sendRequested(access) || !access?.send) {
        return false;
      }
      this.sendReview = this.identity;
      this.readReview = '';
    }
    this.error = '';
    this.notify();
    return true;
  }

  /** Not now: closes the review of `kind` (while no change waits). */
  decline(kind: PermissionKind): void {
    if (this.pending) {
      return;
    }
    if (kind === 'read') {
      this.readReview = '';
    } else {
      this.sendReview = '';
    }
    this.notify();
  }

  /**
   * Allow (after its review) or revoke `kind` for the application shown,
   * through `send`. Returns whether the change was sent. Its answer
   * applies only while the identity is still the one it was taken on.
   */
  change(
    kind: PermissionKind,
    allowed: boolean,
    context: {
      sessionId: string;
      application: ShownApplication | null;
      admitted: boolean;
      send: PermissionSender;
    },
  ): boolean {
    const application = context.application;
    if (!application || application.kind !== 'frame') {
      return false;
    }
    const access = application.chatAccess;
    if (!this.canChange(context.admitted, access) || !access) {
      return false;
    }
    if (permissionIdentity(context.sessionId, application) !== this.identity) {
      return false;
    }
    if (kind === 'read') {
      if (!readRequested(access)) {
        return false;
      }
      if (allowed && this.readReview !== this.identity) {
        return false;
      }
    } else {
      if (!sendRequested(access) || !access.send) {
        return false;
      }
      if (allowed && this.sendReview !== this.identity) {
        return false;
      }
    }

    this.nextRequestId += 1;
    const pending: Pending = { requestId: this.nextRequestId, kind, identity: this.identity };
    this.pending = pending;
    this.error = '';
    this.notify();

    let action: PermissionRequest['action'] = 'set-application-chat-read';
    if (kind === 'send') {
      action = 'set-application-chat-send';
    }
    const request: PermissionRequest = {
      action,
      parameters: {
        id: context.sessionId,
        applicationId: application.id,
        version: application.version,
        revision: access.revision,
        allowed,
      },
    };

    context.send(request).then(
      () => this.settle(pending, ''),
      (failure: unknown) => this.settle(pending, failureText(failure)),
    );
    return true;
  }

  /**
   * The answer of `pending` arrived (or was lost). Ignored when another
   * change replaced it or the identity changed meanwhile. Never changes
   * what the rows say is allowed: the listener's next `chatAccess` does.
   */
  private settle(pending: Pending, error: string): void {
    if (this.pending !== pending || pending.identity !== this.identity) {
      return;
    }
    this.pending = null;
    this.readReview = '';
    this.sendReview = '';
    this.error = error.slice(0, 500);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** The text for a refused or lost change. */
function failureText(failure: unknown): string {
  if (failure && typeof failure === 'object' && (failure as { uncertain?: unknown }).uncertain) {
    return noConfirmationText;
  }
  if (failure instanceof Error && failure.message) {
    return failure.message;
  }
  return 'Permission was not changed.';
}
