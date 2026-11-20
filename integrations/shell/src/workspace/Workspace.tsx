/**
 * The paired browser shell's arrangement:
 *
 *   [conversation list] | [bar above the chat               ] | [Activity]
 *    strip or full list | [   chat in a centred column       ] | [column  ]
 *
 * - The conversation list (../list/ConversationList.tsx) and the divider
 *   that changes its width (../layout/Divider.tsx), both hidden by the ☰
 *   button; width and hidden state are remembered in this browser
 *   (../layout/useListLayout.ts).
 * - The main area: the bar (ChatBar.tsx) and, below it, what the Store
 *   selects: a conversation (the unchanged desktop chat page, `Chat`, in a
 *   column at most 860 px wide, centred), Previous sessions, or an empty
 *   view when nothing is selected. Sign out is offered in the bar when no
 *   conversation is shown, as on slice 1's list page.
 * - The Activity column (../activity/ActivityColumn.tsx), hidden at first,
 *   shown and hidden by the ☰ at the bar's right end (the column's own ☰
 *   while shown) and by the list's Activity entry; its width and shown
 *   state are remembered too (../layout/useActivityLayout.ts). In a wide
 *   window it sits beside the chat with its own divider; in a narrow one it
 *   lies over the chat (../layout/activity-width.ts).
 *
 * The workspace also owns the new-activity marker and the Activity
 * requests on their way; both belong to this pairing and go with it.
 */

import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { AgentSession } from '../../../../src/agents/types.ts';
import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import { Chat } from '../../../session-apps/chat/Chat.tsx';
import type { ChatStore } from '../../../session-apps/chat/store.ts';
import { ActivityColumn, activityColumnId } from '../activity/ActivityColumn.tsx';
import { NewActivity } from '../activity/new-activity.ts';
import { ActivityRequests } from '../activity/requests.ts';
import type { GatewayChatBridge } from '../bridge.ts';
import {
  activityMaximum,
  activityMinimum,
  activityReservedWidth,
  activityWidthFromKey,
  activityWidthFromPointer,
  isNarrowWindow,
  sideColumnWidth,
} from '../layout/activity-width.ts';
import { Divider } from '../layout/Divider.tsx';
import { stripWidth, widthFromKey, widthFromPointer } from '../layout/list-width.ts';
import { useActivityLayout } from '../layout/useActivityLayout.ts';
import { useListLayout } from '../layout/useListLayout.ts';
import { ConversationList, conversationListId } from '../list/ConversationList.tsx';
import { isWorking } from '../list/entries.ts';
import { ChatBar } from './ChatBar.tsx';
import { PreviousSessions } from './PreviousSessions.tsx';

/** The Activity parts of the bar: whether the column is shown, the marker, the ☰. */
interface ActivityBar {
  shown: boolean;
  newActivity: number;
  onShow: () => void;
  button: RefObject<HTMLButtonElement>;
  onFocusLost: () => void;
}

export function Workspace(props: { chat: ChatStore; bridge: GatewayChatBridge }) {
  const state = useAppState();
  const activity = useActivityLayout();
  const windowWidth = activity.windowWidth;
  const overlay = isNarrowWindow(windowWidth);
  // In a wide window the column takes its width from the list's window
  // first (activity-width.ts); the list's own rules apply to the rest.
  const layout = useListLayout((listShown) =>
    activityReservedWidth(activity.preference, activity.shown, windowWidth, listShown),
  );
  const columnWidth = sideColumnWidth(activity.preference, windowWidth, layout.shown);

  // One marker and one set of pending requests per pairing: the workspace
  // is replaced on sign-out. The marker follows every render (each Store
  // change and each change of the column's shown state); `observe` is
  // idempotent, so observing during rendering is safe.
  const marker = useRef(new NewActivity());
  marker.current.observe(state, activity.shown);
  const newActivity = marker.current.count;
  const [requests] = useState(() => new ActivityRequests());

  // A request's start or end changes what the entries offer without a Store
  // change: re-render then. Subscribed here, for the whole pairing, rather
  // than in the column, which may mount while a request is on its way and
  // would miss an answer that arrives before its own subscription.
  const [, setRequestsVersion] = useState(0);
  useEffect(() => {
    return requests.subscribe(() => {
      setRequestsVersion((version) => version + 1);
    });
  }, [requests]);

  // Keyboard focus follows the ☰ that was pressed: showing the column from
  // the bar moves focus to the column's ☰, hiding it from there back to the
  // bar's (which reappears). The list's Activity entry keeps its focus.
  const barActivityButton = useRef<HTMLButtonElement>(null);
  const columnActivityButton = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef<'bar' | 'column' | ''>('');
  // A layout effect: focus moves in the same frame the buttons change, so
  // the reader's next key press already reaches the new button.
  useLayoutEffect(() => {
    if (focusAfterToggle.current === 'column' && activity.shown) {
      columnActivityButton.current?.focus();
    }
    if (focusAfterToggle.current === 'bar' && !activity.shown) {
      barActivityButton.current?.focus();
    }
    focusAfterToggle.current = '';
  }, [activity.shown]);
  // A hand-off asked for by a button that went away for another reason
  // than the column being shown or hidden is not kept for a later toggle.
  useLayoutEffect(() => {
    focusAfterToggle.current = '';
  });

  /**
   * The focused ☰ went away without being pressed (another tab showed or
   * hid the column): focus moves to the ☰ that replaces it, as if pressed.
   */
  function barButtonLostFocus() {
    focusAfterToggle.current = 'column';
  }

  function columnButtonLostFocus() {
    focusAfterToggle.current = 'bar';
  }

  // In a narrow window the shown column covers the chat: the chat is inert
  // then (no focus, no input, hidden from assistive technology), so the
  // keyboard cannot reach controls the reader cannot see. If the focus was
  // in the chat when the column came over it (a resize, another tab showing
  // it, the list's Activity entry keeps its own focus), it moves to the
  // column's ☰.
  const chatCovered = activity.shown && overlay;
  const mainArea = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!chatCovered) {
      return;
    }
    const focused = document.activeElement;
    if (focused && mainArea.current?.contains(focused)) {
      columnActivityButton.current?.focus();
    }
  }, [chatCovered]);

  function showFromBar() {
    focusAfterToggle.current = 'column';
    activity.setShown(true);
  }

  function hideFromColumn() {
    focusAfterToggle.current = 'bar';
    activity.setShown(false);
  }

  let selected: AgentSession | undefined;
  if (state.selected) {
    selected = state.sessions.get(state.selected);
  }

  // Over the chat, the column starts right of the list and its divider.
  let overlayLeft = 0;
  if (layout.shown) {
    overlayLeft = layout.width + 1;
  }

  let activityValueText = `${columnWidth} pixels`;
  if (columnWidth === activityMinimum) {
    activityValueText = `${columnWidth} pixels, the narrowest`;
  }

  return (
    <div class="workspace">
      {layout.shown && (
        <>
          <ConversationList
            appearance={layout.appearance}
            width={layout.width}
            bridge={props.bridge}
            activityShown={activity.shown}
            newActivity={newActivity}
            onToggleActivity={activity.toggleShown}
          />
          <Divider
            width={layout.width}
            narrowest={stripWidth}
            widest={layout.widest}
            label="Conversation list width"
            title="Drag to change the width of the conversation list"
            valueText={listValueText(layout.width)}
            controls={conversationListId}
            fromPointer={(clientX, container) => widthFromPointer(clientX - container.left)}
            fromKey={widthFromKey}
            onWidth={layout.setWidth}
            onRemember={layout.remember}
          />
        </>
      )}
      {/* The page's main landmark, as slice 1's: the bar and the chat,
          Previous sessions or the empty view. */}
      <main class="workspace-main" ref={mainArea} inert={chatCovered}>
        <MainArea
          selected={selected}
          showingPrevious={state.showingPrevious}
          chat={props.chat}
          bridge={props.bridge}
          listShown={layout.shown}
          onToggleList={layout.toggleShown}
          activity={{
            shown: activity.shown,
            newActivity,
            onShow: showFromBar,
            button: barActivityButton,
            onFocusLost: barButtonLostFocus,
          }}
        />
      </main>
      {activity.shown && !overlay && (
        <Divider
          width={columnWidth}
          narrowest={activityMinimum}
          widest={sideColumnWidth(activityMaximum, windowWidth, layout.shown)}
          label="Activity width"
          title="Drag to change the width of Activity"
          valueText={activityValueText}
          className="activity-divider"
          controls={activityColumnId}
          fromPointer={(clientX, container) => activityWidthFromPointer(container.right - clientX)}
          fromKey={activityWidthFromKey}
          onWidth={activity.setWidth}
          onRemember={activity.remember}
        />
      )}
      {activity.shown && (
        <ActivityColumn
          overlay={overlay}
          width={columnWidth}
          left={overlayLeft}
          bridge={props.bridge}
          requests={requests}
          onHide={hideFromColumn}
          hideButton={columnActivityButton}
          onFocusLost={columnButtonLostFocus}
        />
      )}
    </div>
  );
}

/** The list divider's value in words. */
function listValueText(width: number): string {
  if (width === stripWidth) {
    return 'Strip';
  }
  return `Full list, ${width} pixels`;
}

/** The bar and what is selected below it. */
function MainArea(props: {
  selected: AgentSession | undefined;
  showingPrevious: boolean;
  chat: ChatStore;
  bridge: GatewayChatBridge;
  listShown: boolean;
  onToggleList: () => void;
  activity: ActivityBar;
}) {
  const { selected } = props;

  if (selected) {
    let stateText = 'ready';
    if (isWorking(selected)) {
      stateText = 'working…';
    }
    return (
      <>
        <ChatBar
          title={selected.title || 'Untitled'}
          state={stateText}
          listShown={props.listShown}
          onToggleList={props.onToggleList}
          activityShown={props.activity.shown}
          newActivity={props.activity.newActivity}
          onShowActivity={props.activity.onShow}
          activityButton={props.activity.button}
          onActivityFocusLost={props.activity.onFocusLost}
        />
        <div class="chat-column">
          {/* A new chat view for each conversation lifetime: the same ID
              reopened elsewhere (a new tool epoch) starts at its live end
              with a fresh editor, like a different conversation. */}
          <Chat key={selected.id + ' ' + (selected.toolEpoch ?? '')} store={props.chat} />
        </div>
      </>
    );
  }

  if (props.showingPrevious) {
    return (
      <>
        <ChatBar
          title="Previous sessions"
          state=""
          listShown={props.listShown}
          onToggleList={props.onToggleList}
          activityShown={props.activity.shown}
          newActivity={props.activity.newActivity}
          onShowActivity={props.activity.onShow}
          activityButton={props.activity.button}
          onActivityFocusLost={props.activity.onFocusLost}
        >
          <SignOut />
        </ChatBar>
        <div class="page-column">
          <HeldInput chat={props.chat} />
          <PreviousSessions bridge={props.bridge} />
        </div>
      </>
    );
  }

  return (
    <>
      <ChatBar
        title="Conversations"
        state=""
        listShown={props.listShown}
        onToggleList={props.onToggleList}
        activityShown={props.activity.shown}
        newActivity={props.activity.newActivity}
        onShowActivity={props.activity.onShow}
        activityButton={props.activity.button}
        onActivityFocusLost={props.activity.onFocusLost}
      >
        <SignOut />
      </ChatBar>
      <div class="page-column">
        <HeldInput chat={props.chat} />
        <NothingSelected />
      </div>
    </>
  );
}

function SignOut() {
  const store = useStore();
  return (
    <button class="bar-button" onClick={() => store.connection.forget()}>
      Sign out
    </button>
  );
}

/** What the main area says while no conversation is selected. */
function NothingSelected() {
  const state = useAppState();
  let message = 'Choose a conversation from the list.';
  if (state.order.length === 0) {
    message = 'No open conversations. Start one on the computer.';
    if (state.connection.status !== 'online' && !state.engine) {
      message = 'Waiting for Companion…';
    }
  }
  return <p class="workspace-empty">{message}</p>;
}

/**
 * Text only the chat editor holds (an input the bridge could not take, see
 * ChatStore.unresolved), shown while no conversation is, so it stays
 * reachable when its conversation is not shown, for example after it was
 * closed elsewhere: its length, Copy and Discard, as the chat page's own "No
 * conversation" view offers. The text itself is never shown or sent
 * anywhere.
 */
function HeldInput(props: { chat: ChatStore }) {
  const { chat } = props;
  const [held, setHeld] = useState(chat.unresolved());
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    const unsubscribe = chat.subscribe(() => setHeld(chat.unresolved()));
    // It can change between the first render and this effect.
    setHeld(chat.unresolved());
    return unsubscribe;
  }, [chat]);

  if (!held) {
    return null;
  }

  function copy() {
    const bridge = chat.native;
    if (!bridge || !held) {
      return;
    }
    setFeedback('Copying…');
    bridge.copyText(held.text, (json) => {
      let accepted = false;
      try {
        accepted = (JSON.parse(json) as { accepted: boolean }).accepted === true;
      } catch {
        accepted = false;
      }
      if (accepted) {
        setFeedback('Copied.');
      } else {
        setFeedback('The browser did not allow copying.');
      }
    });
  }

  return (
    <div class="held-input" role="status">
      <span>
        Text ({held.text.length} characters) typed in a conversation is only in this page. Copy it
        or discard it.
      </span>
      <button class="bar-button" onClick={copy}>
        Copy
      </button>
      <button class="bar-button" onClick={() => chat.setUnresolved(null)}>
        Discard
      </button>
      {feedback && <span class="held-feedback">{feedback}</span>}
    </div>
  );
}
