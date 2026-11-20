/**
 * The bar above the chat: the ☰ button that hides and shows the
 * conversation list, the title of what is shown, and the conversation's
 * state as text (`working…` while its agent works on a turn, else `ready`).
 * Pages other than a conversation (Previous sessions, nothing selected) put
 * their own controls at its right end instead of a state.
 */

import type { ComponentChildren } from 'preact';

import { conversationListId } from '../list/ConversationList.tsx';

export function ChatBar(props: {
  title: string;
  /** The conversation's state text, or empty for other pages. */
  state: string;
  listShown: boolean;
  onToggleList: () => void;
  children?: ComponentChildren;
}) {
  let toggleLabel = 'Show the conversation list';
  if (props.listShown) {
    toggleLabel = 'Hide the conversation list';
  }

  return (
    <header class="chat-bar">
      <button
        class="bar-button list-toggle"
        aria-label={toggleLabel}
        aria-expanded={props.listShown}
        aria-controls={conversationListId}
        title={toggleLabel}
        onClick={props.onToggleList}
      >
        ☰
      </button>
      <h1 class="chat-bar-title" title={props.title}>
        {props.title}
      </h1>
      {props.state && <span class="chat-bar-state">{props.state}</span>}
      {props.children}
    </header>
  );
}
