/**
 * Speech follows the device that recorded it: the voice target and the
 * navigation context of an utterance heard by a listening browser.
 *
 * Speech heard by the computer's microphone (and typed text) follows the
 * desktop exactly as before (native-views.ts). Speech heard by a browser's
 * microphone follows the browser tab that owns the stream instead: the
 * conversation that tab reports as selected (`panel-state` of its remote
 * connection, also while the tab is in the background or covered by its
 * settings screen), and that tab alone for "go to session N". The desktop's
 * selection plays no part. See src/desktop/README.md, "Speech follows the
 * device that recorded it".
 *
 * Inputs are the runtime's per-connection records; nothing here keeps state
 * or performs I/O. `DesktopRuntime` owns the records and sends the events.
 */

import type { InteractionContext } from '../core/frame.ts';

/** What one remote connection shows, as far as speech is concerned. */
export interface BrowserView {
  /** The conversation the connection reports as selected, or empty. */
  selection: string;
  /**
   * Advances whenever `selection` changes (also away and back), when the
   * connection's report is refused and when its conversation closes. An
   * utterance captured before such a change is not delivered: the same
   * rule as the desktop's interaction revision. Also advances when the
   * connection's page has gone while its requests drain
   * (`withdraw-visibility`): speech from a closed page is not delivered.
   */
  viewRevision: number;
  /** When `viewRevision` last advanced (`performance.now()`). */
  viewChangedAt: number;
}

/** The order of open conversations, as `AgentSessions.order()` returns it. */
export interface ConversationOrder {
  ids: readonly string[];
  revision: string;
}

/** The navigation token of a browser view: its connection's view revision. */
function navigationToken(view: BrowserView): string {
  return `browser:${view.viewRevision}`;
}

/**
 * The interaction context, captured at speech end, of speech that the stream
 * `streamId` heard. `clientId` is the stream's owning connection (0 when the
 * stream has already ended: no connection has that ID) and `view` what that
 * connection shows (undefined when it has gone).
 *
 * Without a view, or when the view shows nothing, the utterance has no
 * conversation, as speech at a desktop showing none. It never falls back to
 * the desktop's selection. The composer is never counted as focused: a
 * remote connection does not report focus, so a follow-up is judged with the
 * ordinary "not focused" instruction.
 */
export function browserInteraction(input: {
  clientId: number;
  streamId: string;
  view: BrowserView | undefined;
  order: ConversationOrder | undefined;
  isOpen: (id: string) => boolean;
  /**
   * When the sound at this speech end arrived (`performance.now()`). Browser
   * sound can wait for the voice detector (up to five seconds, for example
   * while it loads): if the view changed after the sound arrived, the
   * speaker saw the earlier view, so the utterance is captured as already
   * stale, exactly as if the view had changed after speech end.
   */
  heardAt: number | undefined;
  /**
   * When the order of open conversations (or its membership) last changed
   * (`performance.now()`). Numbers are counted in the order the speaker saw:
   * a change after the sound arrived refuses "go to session N".
   */
  orderChangedAt: number;
}): Omit<InteractionContext, 'agentChoices' | 'agentRunId' | 'agentConversation'> {
  const agentView = {
    kind: 'browser',
    clientId: input.clientId,
    streamId: input.streamId,
  } as const;
  const view = input.view;

  if (!view) {
    return {
      agentSessionId: '',
      agentComposerFocused: false,
      agentView,
      revision: -1,
    };
  }

  // Stale from the start: no delivery, no navigation and no started
  // conversation shown can match this revision or token. The conversation
  // the tab shows now is not the one the speaker saw, so it is not named
  // at all: none of its text reaches the intent request.
  const stale = input.heardAt !== undefined && view.viewChangedAt > input.heardAt;
  const revision = stale ? -1 : view.viewRevision;
  const orderStale = input.heardAt !== undefined && input.orderChangedAt > input.heardAt;
  const token = stale || orderStale ? 'browser:stale' : navigationToken(view);

  let id = '';
  if (!stale && view.selection && input.isOpen(view.selection)) {
    id = view.selection;
  }

  let agentNavigation: InteractionContext['agentNavigation'];
  if (input.order) {
    agentNavigation = {
      clientId: input.clientId,
      token,
      ids: input.order.ids,
      orderRevision: input.order.revision,
      // A browser has no pop-out windows: "pop out session N" is refused.
      popoutHost: false,
    };
  }

  return {
    agentNavigation,
    agentSessionId: id,
    agentComposerFocused: false,
    agentTargetSource: id ? 'browser' : undefined,
    agentView,
    revision,
  };
}

/**
 * Whether a browser utterance's captured target still holds at delivery: the
 * owning connection is still there, its view has not changed since speech
 * end (not even away and back), and the conversation is still open. The
 * stream that heard it may have ended meanwhile: accepted speech continues
 * (src/sensors/audio/README.md, rule 5), and the tab still shows what the
 * speaker saw.
 */
export function browserInteractionCurrent(
  context: InteractionContext,
  view: BrowserView | undefined,
  isOpen: (id: string) => boolean,
): boolean {
  if (!view || !context.agentView) {
    return false;
  }
  return (
    context.revision === view.viewRevision &&
    context.agentSessionId === view.selection &&
    context.agentSessionId !== '' &&
    isOpen(context.agentSessionId)
  );
}

/**
 * The conversation a browser's "go to session N" (`index` = N − 1) selects,
 * or undefined when it is refused. Checked immediately before dispatch, as
 * the desktop's navigation is: the owning connection, its view (the token),
 * the order revision and the conversation at that position must all be
 * unchanged since speech end, and the stream that heard it must still be
 * that connection's open stream (the gateway passes `agent-select` only for
 * its own open stream). "Pop out session N" is always refused.
 */
export function browserNavigationTarget(input: {
  context: InteractionContext;
  index: number;
  presentation: 'sidebar' | 'window';
  view: BrowserView | undefined;
  order: ConversationOrder | undefined;
  streamOwner: number | undefined;
  maximumIndex: number;
}): string | undefined {
  const { context, index, view, order } = input;
  const captured = context.agentNavigation;
  const agentView = context.agentView;

  if (input.presentation === 'window') {
    return undefined;
  }
  if (!captured || !agentView || !view || !order) {
    return undefined;
  }
  if (!Number.isInteger(index) || index < 0 || index >= input.maximumIndex) {
    return undefined;
  }
  if (input.streamOwner !== agentView.clientId || captured.clientId !== agentView.clientId) {
    return undefined;
  }
  if (captured.token !== navigationToken(view) || captured.orderRevision !== order.revision) {
    return undefined;
  }

  const id = captured.ids[index];
  if (!id || id !== order.ids[index]) {
    return undefined;
  }
  return id;
}
