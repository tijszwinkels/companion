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
 * The reader's own movement of the transcript toward its end, as
 * SessionView's readerScrolled sees it: a scroll toward the end while the
 * reader drags in the transcript (its scroll bar or a finger, however
 * slowly), or within one second of wheel or key input there that itself
 * pointed toward the end (and of the end of such a drag, for momentum).
 * Within one viewport of the end, the bridge then loads the next newer page
 * below a detached snapshot before the reader gets there.
 *
 * Scrolls the page makes itself never count, also right after the reader's
 * own input: keeping the reader's row in place after a resize, for example,
 * can move the transcript toward the end just after the reader wheeled up.
 * Only the direction of the reader's own input decides. The listeners live
 * as long as the page.
 */
const readerInputWindowMilliseconds = 1000;
// When the reader last gave input in the transcript, and which way it
// pointed: 1 toward the end, -1 toward the start, 0 no direction.
let readerInputAt = -Infinity;
let readerDirection = 0;
let readerDragging = false;

function insideTranscript(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.transcript') !== null;
}

/** Which way a key moves a scrolled element: 1 toward the end, -1 back, 0 neither. */
function keyDirection(event: KeyboardEvent): number {
  if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') {
    return 1;
  }
  if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
    return -1;
  }
  if (event.key === ' ') {
    if (event.shiftKey) {
      return -1;
    }
    return 1;
  }
  return 0;
}

document.addEventListener(
  'wheel',
  (event) => {
    if (insideTranscript(event.target)) {
      readerInputAt = performance.now();
      readerDirection = Math.sign(event.deltaY);
    }
  },
  { capture: true, passive: true },
);

document.addEventListener(
  'keydown',
  (event) => {
    if (insideTranscript(event.target)) {
      readerInputAt = performance.now();
      readerDirection = keyDirection(event);
    }
  },
  { capture: true, passive: true },
);

// Pointer events cover the mouse on the scroll bar and touch alike.
document.addEventListener(
  'pointerdown',
  (event) => {
    if (insideTranscript(event.target)) {
      readerInputAt = performance.now();
      readerDirection = 0;
      readerDragging = true;
    }
  },
  { capture: true, passive: true },
);

// A drag ends wherever the pointer is released or the browser cancels it;
// momentum after it keeps the direction the drag last moved in.
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(
    type,
    () => {
      if (readerDragging) {
        readerInputAt = performance.now();
      }
      readerDragging = false;
    },
    { capture: true, passive: true },
  );
}

// The last scroll position seen per transcript element, to tell the
// direction of the next scroll. Weak, so a replaced element is forgotten.
const lastScrollTops = new WeakMap<Element, number>();

document.addEventListener(
  'scroll',
  (event) => {
    const element = event.target;
    if (!(element instanceof Element) || !element.classList.contains('transcript')) {
      return;
    }
    const previousTop = lastScrollTops.get(element) ?? element.scrollTop;
    lastScrollTops.set(element, element.scrollTop);
    const towardEnd = element.scrollTop > previousTop;
    if (readerDragging) {
      // The drag itself moves the transcript: its direction is the reader's.
      if (element.scrollTop !== previousTop) {
        readerDirection = towardEnd ? 1 : -1;
      }
      if (towardEnd) {
        readerScrolled(element);
      }
      return;
    }
    const recentInput = performance.now() - readerInputAt <= readerInputWindowMilliseconds;
    if (towardEnd && recentInput && readerDirection === 1) {
      readerScrolled(element);
    }
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
