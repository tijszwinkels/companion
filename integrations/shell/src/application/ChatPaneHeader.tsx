/**
 * The header of the chat at the right of a session application (the split
 * layout, ./ConversationArea.tsx): the word "Chat" and ⇥ Hide chat, which
 * does what App only does: the application alone, with the Chat |
 * application switch, remembered in this browser
 * (./useApplicationLayout.ts). It sits on the chat itself, where a reader
 * who wants the chat out of the way looks for it; the bar's ⇤ Show chat
 * (./ApplicationBar.tsx) brings it back.
 *
 * Drawn only in the split layout; the switch layout has no header, so the
 * chat page keeps its whole height there.
 */

import { applicationChatId } from './ApplicationBar.tsx';

/** The ⇥ Hide chat button, which ⇤ Show chat gives focus back to. */
export const hideChatButtonId = 'hide-chat';

export function ChatPaneHeader(props: { onHide: () => void }) {
  return (
    <div class="chat-pane-header">
      <span class="chat-pane-title">Chat</span>
      <button
        id={hideChatButtonId}
        class="panel-action small chat-pane-hide"
        aria-controls={applicationChatId}
        title="Hide the chat and show the app alone (App only)"
        onClick={props.onHide}
      >
        ⇥ Hide chat
      </button>
    </div>
  );
}
