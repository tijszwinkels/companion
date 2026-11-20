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
 * (`bridge.admitted`). Times are not shown in this slice.
 */

import { useState } from 'preact/hooks';

import type { PreviousSession } from '../../../../src/agents/types.ts';
import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import type { GatewayChatBridge } from '../bridge.ts';

export function PreviousSessions(props: { bridge: GatewayChatBridge }) {
  const state = useAppState();
  const available = props.bridge.admitted;

  if (state.previous.length === 0) {
    return <p class="workspace-empty">Your conversations stay here when you close them.</p>;
  }

  return (
    <ul class="previous-sessions" aria-label="Previous sessions">
      {state.previous.map((session) => (
        <PreviousRow key={session.id} session={session} available={available} />
      ))}
    </ul>
  );
}

function PreviousRow(props: { session: PreviousSession; available: boolean }) {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const title = props.session.title || 'Untitled';

  async function reopen() {
    setBusy(true);
    // The restored event arrives before the reply; mark it for selection.
    store.revealNextRestore = props.session.id;
    try {
      await store.request('reopen-agent', { id: props.session.id });
    } catch {
      if (store.revealNextRestore === props.session.id) {
        store.revealNextRestore = '';
      }
      // The toast explains; the entry stays available for another try.
    } finally {
      setBusy(false);
    }
  }

  let label = 'Reopen';
  if (busy) {
    label = 'Opening…';
  }

  return (
    <li class="previous-session">
      <span class="previous-title" title={title}>
        {title}
      </span>
      <button
        class="bar-button"
        disabled={!props.available || busy}
        aria-label={`Reopen ${title}`}
        onClick={reopen}
      >
        {label}
      </button>
    </li>
  );
}
