/**
 * The paired browser shell's arrangement, the same at every window width:
 *
 *   [conversation list] | [bar above the chat               ]
 *    strip or full list | [   chat in a centred column       ]
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
 */

import { useEffect, useState } from 'preact/hooks';

import type { AgentSession } from '../../../../src/agents/types.ts';
import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import { Chat } from '../../../session-apps/chat/Chat.tsx';
import type { ChatStore } from '../../../session-apps/chat/store.ts';
import type { GatewayChatBridge } from '../bridge.ts';
import { Divider } from '../layout/Divider.tsx';
import { useListLayout } from '../layout/useListLayout.ts';
import { ConversationList, conversationListId } from '../list/ConversationList.tsx';
import { isWorking } from '../list/entries.ts';
import { ChatBar } from './ChatBar.tsx';
import { PreviousSessions } from './PreviousSessions.tsx';

export function Workspace(props: { chat: ChatStore; bridge: GatewayChatBridge }) {
  const state = useAppState();
  const layout = useListLayout();

  let selected: AgentSession | undefined;
  if (state.selected) {
    selected = state.sessions.get(state.selected);
  }

  return (
    <div class="workspace">
      {layout.shown && (
        <>
          <ConversationList
            appearance={layout.appearance}
            width={layout.width}
            bridge={props.bridge}
          />
          <Divider
            width={layout.width}
            widest={layout.widest}
            controls={conversationListId}
            onWidth={layout.setWidth}
            onRemember={layout.remember}
          />
        </>
      )}
      <section class="workspace-main">
        <MainArea
          selected={selected}
          showingPrevious={state.showingPrevious}
          chat={props.chat}
          bridge={props.bridge}
          listShown={layout.shown}
          onToggleList={layout.toggleShown}
        />
      </section>
    </div>
  );
}

/** The bar and what is selected below it. */
function MainArea(props: {
  selected: AgentSession | undefined;
  showingPrevious: boolean;
  chat: ChatStore;
  bridge: GatewayChatBridge;
  listShown: boolean;
  onToggleList: () => void;
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
