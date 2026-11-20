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

  // One reopen at a time, across rows and also after this page was left
  // and shown again: the Store's selection mark names the conversation
  // whose restore is still awaited, and two reopens would share it.
  const anotherReopening = store.revealNextRestore !== '' && !busy;

  async function reopen() {
    if (store.revealNextRestore !== '') {
      return;
    }
    setBusy(true);
    // The restored event arrives before the reply; mark it for selection.
    store.revealNextRestore = props.session.id;
    try {
      await store.request('reopen-agent', { id: props.session.id });
    } catch {
      // The toast explains; the entry stays available for another try.
    } finally {
      // The Store clears the mark when the restored conversation arrives;
      // after a failure, or a reply without it, nothing is awaited any more.
      if (store.revealNextRestore === props.session.id) {
        store.revealNextRestore = '';
      }
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
        disabled={!props.available || busy || anotherReopening}
        aria-label={`Reopen ${title}`}
        onClick={reopen}
      >
        {label}
      </button>
    </li>
  );
}
