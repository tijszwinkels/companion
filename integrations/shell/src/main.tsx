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
 * Another tab of this browser signed out, was revoked or paired again: the
 * stored device credential changed. This tab's Store still holds the previous
 * pairing (credential, socket and drafts in memory) and would write those
 * drafts back to the storage both tabs share, where the next pairing would
 * find them. So the tab reloads and starts from what is stored now. The key
 * is the phone Connection's (integrations/mobile/src/connection.ts);
 * test/shell/shell.test.ts checks this with two tabs.
 */
const credentialStorageKey = 'companion.remote.device';
window.addEventListener('storage', (event) => {
  // `key` is null when another tab cleared the whole storage.
  if (event.key === credentialStorageKey || event.key === null) {
    window.location.reload();
  }
});

/**
 * The reader's own scrolling of the transcript, as SessionView's
 * readerScrolled sees it: a scroll while the reader holds a pointer pressed
 * in the transcript (dragging its scroll bar, however slowly), or within one
 * second of their wheel, key, pointer or touch input there. Within one
 * viewport of the end, the bridge loads the next newer page below a detached
 * snapshot before the reader gets there. Layout changes and the page's own
 * scrolling never count. The listeners live as long as the page.
 */
const readerInputWindowMilliseconds = 1000;
let readerInputAt = -Infinity;
let readerDragging = false;

function insideTranscript(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.transcript') !== null;
}

for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) {
  document.addEventListener(
    type,
    (event) => {
      if (insideTranscript(event.target)) {
        readerInputAt = performance.now();
        if (type === 'pointerdown') {
          readerDragging = true;
        }
      }
    },
    { capture: true, passive: true },
  );
}

// A drag ends wherever the pointer is released or the browser cancels it.
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(
    type,
    () => {
      readerDragging = false;
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
    const recentInput = performance.now() - readerInputAt <= readerInputWindowMilliseconds;
    if (!readerDragging && !recentInput) {
      return;
    }
    readerScrolled(element);
  },
  { capture: true, passive: true },
);

/**
 * At the very end the transcript cannot scroll any further, so a downward
 * wheel there produces no scroll event. It still is the reader asking for
 * what comes next, for example after a reconnect forgot a newer page that
 * was pending at that end: it is passed on like a scroll.
 */
document.addEventListener(
  'wheel',
  (event) => {
    if (!(event instanceof WheelEvent) || event.deltaY <= 0) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const transcript = target.closest('.transcript');
    if (transcript) {
      readerScrolled(transcript);
    }
  },
  { capture: true, passive: true },
);

/** The reader moved `transcript`: near its end, the next newer page may load. */
function readerScrolled(transcript: Element): void {
  const reach = Math.max(transcript.clientHeight, 160);
  const fromEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  if (fromEnd <= reach) {
    bridge.readerNearEnd();
  }
}

render(
  <StoreContext.Provider value={store}>
    <App chat={chat} />
  </StoreContext.Provider>,
  document.getElementById('app')!,
);

store.start();
