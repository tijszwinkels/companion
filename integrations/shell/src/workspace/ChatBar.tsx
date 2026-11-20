/**
 * The bar above the chat: the ☰ button that hides and shows the
 * conversation list, the title of what is shown, and the conversation's
 * state as text (`working…` while its agent works on a turn, else `ready`).
 * Pages other than a conversation (Previous sessions, nothing selected) put
 * their own controls at its right end instead of a state.
 *
 * At its right end, while the Activity column is hidden, a second ☰ shows
 * the column; it carries the green dot while new Activity entries are
 * marked (../activity/new-activity.ts). While the column is shown, its own
 * header has the ☰ that hides it, in the same place.
 */

import type { ComponentChildren, Ref } from 'preact';

import { activityColumnId } from '../activity/ActivityColumn.tsx';
import { conversationListId } from '../list/ConversationList.tsx';

export function ChatBar(props: {
  title: string;
  /** The conversation's state text, or empty for other pages. */
  state: string;
  listShown: boolean;
  onToggleList: () => void;
  /** Whether the Activity column is shown (then this bar has no Activity ☰). */
  activityShown: boolean;
  /** How many Activity entries are new (the green dot while not zero). */
  newActivity: number;
  onShowActivity: () => void;
  /** The ☰ that shows the Activity column, for moving keyboard focus to it. */
  activityButton: Ref<HTMLButtonElement>;
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
      {!props.activityShown && (
        <ActivityButton
          newActivity={props.newActivity}
          onShow={props.onShowActivity}
          button={props.activityButton}
        />
      )}
    </header>
  );
}

/** The ☰ at the bar's right end that shows the Activity column. */
function ActivityButton(props: {
  newActivity: number;
  onShow: () => void;
  button: Ref<HTMLButtonElement>;
}) {
  let label = 'Show Activity';
  if (props.newActivity === 1) {
    label = 'Show Activity, 1 new entry';
  } else if (props.newActivity > 1) {
    label = `Show Activity, ${props.newActivity} new entries`;
  }

  return (
    <button
      ref={props.button}
      class="bar-button activity-toggle"
      aria-label={label}
      aria-expanded={false}
      aria-controls={activityColumnId}
      title={label}
      onClick={props.onShow}
    >
      ☰{props.newActivity > 0 && <span class="activity-new" aria-hidden="true" />}
    </button>
  );
}
