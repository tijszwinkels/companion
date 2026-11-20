/**
 * Previous sessions: the saved conversations the listener reports
 * (`state.previous`, in the listener's order), each with Reopen, as on the
 * phone (integrations/mobile/src/components/Previous.tsx).
 *
 * Reopen asks for `reopen-agent`. The restored conversation arrives as an
 * `agent-restored` event before the reply, and the Store selects it because
 * it was marked for selection here (`revealNextRestore`). A refused or
 * failed reopen is explained by the Store's toast and the entry stays
 * available. Reopening is offered only while requests are admitted
 * (`bridge.admitted`), and one at a time, since the Store has one selection
 * mark. Times are not shown in this slice.
 */

import { useSyncExternalStore } from 'preact/compat';

import type { PreviousSession } from '../../../../src/agents/types.ts';
import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import type { Store } from '../../../mobile/src/store.ts';
import type { GatewayChatBridge } from '../bridge.ts';

/**
 * The reopen in flight for one Store, if any: the conversation ID whose
 * `reopen-agent` has not been answered yet. Every row follows it, also a
 * Previous sessions page shown again while the request is still open, so
 * all Reopen buttons are disabled while one is pending and enabled again
 * when it settles.
 */
class ReopenInFlight {
  id = '';
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(id: string): void {
    this.id = id;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** One tracker per Store (the page has one Store). */
const inFlightByStore = new WeakMap<Store, ReopenInFlight>();

function reopenInFlight(store: Store): ReopenInFlight {
  let tracker = inFlightByStore.get(store);
  if (!tracker) {
    tracker = new ReopenInFlight();
    inFlightByStore.set(store, tracker);
  }
  return tracker;
}

export function PreviousSessions(props: { bridge: GatewayChatBridge }) {
  const state = useAppState();
  const store = useStore();
  const tracker = reopenInFlight(store);
  const pending = useSyncExternalStore(
    (listener) => tracker.subscribe(listener),
    () => tracker.id,
  );
  const available = props.bridge.admitted;

  if (state.previous.length === 0) {
    return <p class="workspace-empty">Your conversations stay here when you close them.</p>;
  }

  return (
    <ul class="previous-sessions" aria-label="Previous sessions">
      {state.previous.map((session) => (
        <PreviousRow
          key={session.id}
          session={session}
          available={available}
          pending={pending}
          tracker={tracker}
        />
      ))}
    </ul>
  );
}

function PreviousRow(props: {
  session: PreviousSession;
  available: boolean;
  /** The conversation whose reopen is in flight, or "". */
  pending: string;
  tracker: ReopenInFlight;
}) {
  const store = useStore();
  const title = props.session.title || 'Untitled';
  const id = props.session.id;

  async function reopen() {
    // One reopen at a time: the Store has one selection mark.
    if (props.tracker.id !== '') {
      return;
    }
    props.tracker.set(id);
    // The restored event arrives before the reply; mark it for selection.
    store.revealNextRestore = id;
    try {
      await store.request('reopen-agent', { id: id });
    } catch {
      // The toast explains; the entry stays available for another try.
    } finally {
      // The Store clears the mark when the restored conversation arrives;
      // after a failure, or a reply without it, nothing is awaited any more.
      if (store.revealNextRestore === id) {
        store.revealNextRestore = '';
      }
      props.tracker.set('');
    }
  }

  let label = 'Reopen';
  if (props.pending === id) {
    label = 'Opening…';
  }

  return (
    <li class="previous-session">
      <span class="previous-title" title={title}>
        {title}
      </span>
      <button
        class="bar-button"
        disabled={!props.available || props.pending !== ''}
        aria-label={`Reopen ${title}`}
        onClick={reopen}
      >
        {label}
      </button>
    </li>
  );
}
