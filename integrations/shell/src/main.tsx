/**
 * Entry point of the browser shell (dist/index.html, app.js, app.css).
 *
 * Creates, once per page:
 * - the phone panel's Store, which owns pairing, the gateway connection,
 *   reconnection and the conversations (integrations/mobile/src/store.ts);
 * - the gateway bridge, which plays the Qt host's part for the chat page;
 * - the chat page's own ChatStore, attached to that bridge exactly as the Qt
 *   host attaches it to QWebChannel (integrations/session-apps/chat/main.tsx).
 *
 * The page is static and self-contained: it loads nothing but its own files
 * and talks only to its own origin (the gateway's CSP enforces both).
 */

import { render } from 'preact';

import { StoreContext } from '../../mobile/src/hooks.ts';
import { Store } from '../../mobile/src/store.ts';
import { ChatStore } from '../../session-apps/chat/store.ts';
import '../../session-apps/chat/styles.css';
import { App } from './App.tsx';
import { GatewayChatBridge, type TranscriptView } from './bridge.ts';
import './styles.css';

/**
 * Where the chat page's rows are on screen. Chat.tsx draws one `.message`
 * element per row inside `.transcript .rows`, in row order; history
 * trimming uses this to spare the rows the reader is looking at.
 */
const transcriptView: TranscriptView = {
  visibleIndexes() {
    const indexes: number[] = [];
    const transcript = document.querySelector('.transcript');
    if (!transcript) {
      return indexes;
    }
    const viewport = transcript.getBoundingClientRect();
    const rows = transcript.querySelectorAll('.rows > .message');
    for (let index = 0; index < rows.length; index++) {
      const box = rows[index].getBoundingClientRect();
      if (box.bottom > viewport.top && box.top < viewport.bottom) {
        indexes.push(index);
      }
    }
    return indexes;
  },
  topIndex() {
    const transcript = document.querySelector('.transcript');
    if (!transcript) {
      return -1;
    }
    const edge = transcript.getBoundingClientRect().top;
    const rows = transcript.querySelectorAll('.rows > .message');
    for (let index = 0; index < rows.length; index++) {
      if (rows[index].getBoundingClientRect().bottom > edge + 1) {
        return index;
      }
    }
    return -1;
  },
};

const store = new Store();
const bridge = new GatewayChatBridge(store, transcriptView);
const chat = new ChatStore();
chat.attach(bridge);

render(
  <StoreContext.Provider value={store}>
    <App chat={chat} />
  </StoreContext.Provider>,
  document.getElementById('app')!,
);

store.start();
