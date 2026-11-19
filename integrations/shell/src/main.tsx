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

// No Activity view yet, so Activity history is never requested.
const store = new Store({ activity: false });
const bridge = new GatewayChatBridge(store, transcriptView);
const chat = new ChatStore();
chat.attach(bridge);

// Signed out or revoked: text only the chat editor held (input the bridge
// refused) belongs to the previous pairing and must not be offered to the
// next one. The Store and the bridge clear their own state.
store.subscribe(() => {
  if (store.state.connection.status === 'unpaired' && chat.unresolved() !== null) {
    chat.setUnresolved(null);
  }
});

/**
 * The reader's own scrolling of the transcript, as SessionView's
 * readerScrolled sees it: a scroll within one second of their wheel, key,
 * pointer or touch input. Within one viewport of the end, the bridge loads
 * the next newer page below a detached snapshot before the reader gets
 * there. Layout changes and the page's own scrolling never count. The
 * listeners live as long as the page.
 */
const readerInputWindowMilliseconds = 1000;
let readerInputAt = -Infinity;

function insideTranscript(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.transcript') !== null;
}

for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) {
  document.addEventListener(
    type,
    (event) => {
      if (insideTranscript(event.target)) {
        readerInputAt = performance.now();
      }
    },
    { capture: true, passive: true },
  );
}

document.addEventListener(
  'scroll',
  (event) => {
    const element = event.target;
    if (!(element instanceof Element) || !element.classList.contains('transcript')) {
      return;
    }
    if (performance.now() - readerInputAt > readerInputWindowMilliseconds) {
      return;
    }
    const reach = Math.max(element.clientHeight, 160);
    const fromEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (fromEnd <= reach) {
      bridge.readerNearEnd();
    }
  },
  { capture: true, passive: true },
);

render(
  <StoreContext.Provider value={store}>
    <App chat={chat} />
  </StoreContext.Provider>,
  document.getElementById('app')!,
);

store.start();
