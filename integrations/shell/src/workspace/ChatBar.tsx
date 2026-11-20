/**
 * The bar above the chat: the ☰ button that hides and shows the
 * conversation list, the title of what is shown, the conversation's state
 * as text (`working…` while its agent works on a turn, else `ready`) and,
 * beside it, the conversation's model with its picker
 * (../models/ModelPicker.tsx).
 * Pages other than a conversation (Previous sessions, nothing selected) put
 * their own controls at its right end instead of a state.
 *
 * At its right end, while the Activity column is hidden, a second ☰ shows
 * the column; it carries the green dot while new Activity entries are
 * marked (../activity/new-activity.ts). While the column is shown, its own
 * header has the ☰ that hides it, in the same place.
 *
 * Left of that ☰ (at the right end while the column is shown), the gear
 * shows the settings screen in place of the chat and, pressed again, goes
 * back (../settings/SettingsScreen.tsx).
 */

import type { ComponentChildren, RefObject } from 'preact';

import { activityColumnId } from '../activity/ActivityColumn.tsx';
import { conversationListId } from '../list/ConversationList.tsx';
import { settingsScreenId } from '../settings/SettingsScreen.tsx';
import { useFocusHandOff } from './focus-hand-off.ts';

export function ChatBar(props: {
  title: string;
  /**
   * The conversation's state (`ready`, `working · 2:16`, …), or null for
   * other pages (./BarState.tsx).
   */
  state: ComponentChildren;
  /** The conversation's model picker, beside its state; absent for other pages. */
  model?: ComponentChildren;
  listShown: boolean;
  onToggleList: () => void;
  /** Whether the Activity column is shown (then this bar has no Activity ☰). */
  activityShown: boolean;
  /** How many Activity entries are new (the green dot while not zero). */
  newActivity: number;
  onShowActivity: () => void;
  /** The ☰ that shows the Activity column, for moving keyboard focus to it. */
  activityButton: RefObject<HTMLButtonElement>;
  /** That ☰ had keyboard focus when it went away (another tab showed the column). */
  onActivityFocusLost: () => void;
  /** Whether the settings screen is shown (the gear is then pressed). */
  settingsShown: boolean;
  onToggleSettings: () => void;
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
      {/* Title and state share the room between the buttons; where the
          state does not fit beside the title (a narrow window), it goes on
          a second line instead of pushing the buttons out. */}
      <div class="chat-bar-heading">
        <h1 class="chat-bar-title" title={props.title}>
          {props.title}
        </h1>
        {props.state ? <span class="chat-bar-state">{props.state}</span> : null}
        {props.model ?? null}
      </div>
      {props.children}
      <button
        class="bar-button settings-toggle"
        aria-label="Settings"
        aria-pressed={props.settingsShown}
        aria-controls={props.settingsShown ? settingsScreenId : undefined}
        title={props.settingsShown ? 'Back from Settings' : 'Settings'}
        onClick={props.onToggleSettings}
      >
        ⚙
      </button>
      {!props.activityShown && (
        <ActivityButton
          newActivity={props.newActivity}
          onShow={props.onShowActivity}
          button={props.activityButton}
          onFocusLost={props.onActivityFocusLost}
        />
      )}
    </header>
  );
}

/** The ☰ at the bar's right end that shows the Activity column. */
function ActivityButton(props: {
  newActivity: number;
  onShow: () => void;
  button: RefObject<HTMLButtonElement>;
  onFocusLost: () => void;
}) {
  useFocusHandOff(props.button, props.onFocusLost);

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
