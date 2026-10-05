/**
 * Previous sessions: saved conversations, newest turn first, like the desktop
 * PreviousSessionsView. Reopening selects it on this phone.
 */

import { useState } from 'preact/hooks';

import type { PreviousSession } from '../../../../src/agents/types.ts';
import { relativeTime } from '../format.ts';
import { useAppState, useStore } from '../hooks.ts';

export function PreviousPage() {
  const state = useAppState();
  const online = state.connection.status === 'online';

  return (
    <div class="page">
      <div class="scroll">
        {state.previous.length === 0 && (
          <div class="empty">{'Your conversations stay here\nwhen you close their tabs.'}</div>
        )}
        {state.previous.map((session) => (
          <PreviousRow key={session.id} session={session} disabled={!online} />
        ))}
      </div>
    </div>
  );
}

function PreviousRow(props: { session: PreviousSession; disabled: boolean }) {
  const store = useStore();
  const [busy, setBusy] = useState(false);

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

  return (
    <div class="previous-row">
      <div class="body">
        <div class="title">{props.session.title || 'Untitled'}</div>
        <div class="time">
          {relativeTime(props.session.updatedAt)}
          {props.session.model ? ` · ${props.session.model}` : ''}
        </div>
      </div>
      <button
        class="action small"
        onClick={reopen}
        disabled={props.disabled || busy}
        aria-label={`Reopen ${props.session.title}`}
      >
        {busy ? 'Opening…' : 'Reopen'}
      </button>
    </div>
  );
}
