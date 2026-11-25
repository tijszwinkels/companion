/**
 * The bar's ⧉ button: the shown conversation in a new browser window, which
 * stays on it while this window switches (./new-window.ts). In the bar of a
 * conversation only, left of the gear.
 */

import { openConversationWindow } from './new-window.ts';

export function NewWindowButton(props: { sessionId: string }) {
  const label = 'Open this conversation in a new window';
  return (
    <button
      class="bar-button new-window"
      aria-label={label}
      title={label}
      onClick={() => openConversationWindow(props.sessionId)}
    >
      ⧉
    </button>
  );
}
