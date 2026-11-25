/**
 * Spoken navigation in this browser tab: speech follows the device that
 * recorded it.
 *
 * While Listen here is on, speech this tab's microphone heard goes to the
 * conversation this tab shows, and a spoken "go to session N" selects
 * conversation N here (and nowhere else). A conversation that this tab's
 * speech started (a quick question, a new session) is shown here too; the
 * desktop keeps what it shows. The listener decides that; the gateway sends
 * this tab an `agent-select` message for it (src/remote/README.md, "Speech
 * follows the device that recorded it").
 *
 * Rule (README "Listen here", "Rule: spoken navigation"): the message acts
 * exactly like the reader's own click on that conversation in the list. It
 * leaves the settings screen and selects the conversation; a focused text box
 * does not stop it, and unsent text stays with its conversation as on a
 * click. As on the desktop, it is refused (nothing happens) when what the tab
 * shows is no longer what it showed at speech end (`from`), when the order
 * of conversations changed (`orderRevision`), or when the conversation is not
 * in the list. A send or a choice awaiting its answer does not stop it, as it
 * does not stop the desktop's go-to. A started conversation is selected once
 * it is listed, unless what is shown changed meanwhile (the rule of Start in
 * Activity, ../activity/select-started.ts).
 *
 * Input: `agent-select` gateway messages. Output: at most one selection per
 * message. Owns nothing beyond a started conversation's short wait, which
 * StartedSelection releases itself.
 */

import type { Store } from '../../../mobile/src/store.ts';
import type { AgentSelectMessage } from '../../../../src/remote/protocol.ts';
import { StartedSelection } from '../activity/select-started.ts';

export interface SpokenSelectionEnvironment {
  store: Store;
  /** The list's click on a conversation: leave the settings screen, then select it. */
  open(id: string): void;
}

/**
 * The conversation this tab reported as shown, as the Store reports it to
 * the listener (`panel-state`): the selected conversation while it is listed,
 * else none.
 */
export function reportedSelection(store: Store): string {
  const state = store.state;
  if (state.showingPrevious || !state.sessions.has(state.selected)) {
    return '';
  }
  return state.selected;
}

/** Whether a message is a well-formed `agent-select` from the gateway. */
export function isAgentSelect(message: Record<string, unknown>): message is AgentSelectMessage {
  if (message.type !== 'agent-select') {
    return false;
  }
  if (typeof message.id !== 'string' || message.id === '' || typeof message.from !== 'string') {
    return false;
  }
  if (message.started === true) {
    return message.orderRevision === undefined;
  }
  return message.started === undefined && typeof message.orderRevision === 'string';
}

export class SpokenSelection {
  constructor(private readonly environment: SpokenSelectionEnvironment) {}

  /** Act on one `agent-select` (see the rule above). */
  received(message: AgentSelectMessage): void {
    const store = this.environment.store;
    if (store.state.connection.status === 'unpaired') {
      return;
    }

    // Refused when the tab moved on since speech end: the speech was meant
    // for what it showed then.
    if (reportedSelection(store) !== message.from) {
      return;
    }

    if (message.started) {
      // Listed now or a moment later; the wait ends by itself when the
      // reader moves on, after its time limit, or at sign-out.
      const selection = new StartedSelection(store, (id) => this.environment.open(id));
      selection.started(message.id);
      return;
    }

    if (store.state.orderRevision !== message.orderRevision) {
      return;
    }
    if (!store.state.sessions.has(message.id)) {
      return;
    }
    this.environment.open(message.id);
  }
}
