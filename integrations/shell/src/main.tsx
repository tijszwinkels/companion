/**
 * Entry point of the browser shell (dist/index.html, app.js, app.css).
 *
 * Creates, once per page:
 * - the phone panel's Store, which owns pairing, the gateway connection,
 *   reconnection and the conversations (integrations/mobile/src/store.ts);
 * - the gateway bridge, which plays the Qt host's part for the chat page;
 * - the chat page's own ChatStore, attached to that bridge exactly as the Qt
 *   host attaches it to QWebChannel (integrations/session-apps/chat/main.tsx);
 * - the screenshot viewer, which the bridge opens for the page's View
 *   screenshot (screenshots/);
 * - Listen here, the browser's microphone as one of Companion's (listen/).
 *
 * The page is static and self-contained: it loads nothing but its own files
 * and talks only to its own origin (the gateway's CSP enforces both).
 */

import { render } from 'preact';

import { fetchScreenshot } from '../../mobile/src/screenshots.ts';
import { StoreContext } from '../../mobile/src/hooks.ts';
import { Store } from '../../mobile/src/store.ts';
import { ChatStore } from '../../session-apps/chat/store.ts';
import '../../session-apps/chat/styles.css';
import type { AudioEndedMessage } from '../../../src/remote/protocol.ts';
import { App } from './App.tsx';
import { GatewayChatBridge, type TranscriptView } from './bridge.ts';
import { ActivityOverlay } from './layout/activity-overlay.ts';
import type { LayoutStorage } from './layout/stored-layout.ts';
import { BrowserCapture } from './listen/capture.ts';
import { ListenHere } from './listen/listen-here.ts';
import { DisplaySettings, displayStoragePrefix } from './settings/display-settings.ts';
import { SettingsView } from './settings/settings-view.ts';
import './styles.css';
import { ListenerClock } from './times/listener-clock.ts';
import type { PageTimes } from './times/page-times.ts';
import { TurnTicker } from './times/turn-ticker.ts';
import { ScreenshotViewerState } from './screenshots/screenshot-viewer.ts';
import { ChatCover } from './widgets/chat-cover.ts';
import { createInlineWidget, type InlineWidgetEnvironment } from './widgets/InlineWidget.tsx';
import { pinnedWidget, pinningShown } from './widgets/pinned-widget.ts';

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

// Whether the settings screen covers the chat (settings/settings-view.ts).
// Browser Back and Forward leave it. Listening before the Store exists puts
// this ahead of the Store's own navigation handling, so the page the Store
// then selects counts as shown (and its unread mark is cleared).
const settingsView = new SettingsView();
window.addEventListener('popstate', () => {
  settingsView.setShown(false);
});

// Whether the Activity column lies over the chat (a narrow window); the
// workspace sets it after each drawing (layout/activity-overlay.ts).
const activityOverlay = new ActivityOverlay();

// The Store reads this listener run's Activity history for the Activity
// column (the phone panel's default), and after each reconnect from the
// start, so changes made elsewhere while offline (deletions, labels) are not
// missed. The selected conversation is not shown while the settings screen
// or the narrow Activity column covers it: the page then reports it to the
// listener as not visible, so its unread mark stays (README "Markers").
const store = new Store({
  rereadActivityAfterReconnect: true,
  selectionShown: () => !settingsView.shown && !activityOverlay.coversChat,
});
// Either cover coming or going changes what the reader sees: the Store
// reports again when that changes what it last reported.
settingsView.subscribe(() => store.selectionShownChanged());
activityOverlay.subscribe(() => store.selectionShownChanged());

// The listener's clock offset is taken from each state message as the
// Store applies it. Subscribed first, so the bridge and the page already
// see the new offset when the same Store change reaches them.
const clock = new ListenerClock();
store.subscribe(() => clock.observe(store.state.engine));

/** This browser's localStorage, or null where the page may not use it. */
function pageStorage(): LayoutStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const times: PageTimes = {
  settings: new DisplaySettings(pageStorage),
  clock,
  ticker: new TurnTicker(clock),
};

const bridge = new GatewayChatBridge(store, transcriptView, {
  settings: times.settings,
  clock,
});
// Inline widgets (widgets/InlineWidget.tsx): the chat page draws widget
// messages with this component. Frames are greyed and paused while requests
// are not admitted, and paused while this page's own screens cover the chat
// (the workspace keeps `chatCover` up to date).
// The same environment serves the selected conversation's pinned widget
// (workspace/PinnedWidget.tsx), whose message the chat then draws as
// "Pinned" (widgets/pinned-widget.ts).
const chatCover = new ChatCover();
const widgets: InlineWidgetEnvironment = {
  connected: () => bridge.admitted,
  subscribe: (listener) => store.subscribe(listener),
  cover: chatCover,
  pinnedMessageId: (sessionId) => {
    return pinnedWidget(store.state.sessions.get(sessionId))?.messageId ?? '';
  },
  pinningShown: (sessionId) => pinningShown(store.state.sessions.get(sessionId)),
};
bridge.inlineWidget = createInlineWidget(widgets);

const chat = new ChatStore();
chat.attach(bridge);

// Listen here (listen/listen-here.ts): this browser's microphone as one more
// microphone of Companion, on the page's existing connection. Created after
// the bridge, so its Store subscription runs after the bridge's and
// `bridge.admitted` is already current when it reads it.
const listenHere = new ListenHere(
  {
    admitted: () => bridge.admitted,
    paired: () => store.state.connection.status !== 'unpaired',
    engine: () => store.state.engine,
    subscribe: (listener) => store.subscribe(listener),
    request: (action) => store.request(action, {}, { quiet: true }),
    sendAudio: (piece) => store.connection.sendBinary(piece),
    bufferedAmount: () => store.connection.bufferedAmount,
    warn: (text) => store.toast(text, 'error'),
    onAudioEnded: (listener) => {
      store.connection.onUnrequestedMessage = (message) => {
        if (message.type === 'audio-ended') {
          listener(message as unknown as AudioEndedMessage);
        }
      };
    },
  },
  new BrowserCapture(),
);

// The page's View screenshot opens the viewer. The image is fetched with
// this pairing's token in a header, never in an address (screenshots/).
const viewer = new ScreenshotViewerState((path, signal) =>
  fetchScreenshot(path, store.connection, signal),
);
bridge.onScreenshot((request) => viewer.open(request));

// Inline widget frames behind the open viewer count as covered: they stop
// polling and a loading frame's deadline waits (widgets/chat-cover.ts).
// Only the frames: the visible report for the unread mark (selectionShown
// above) does not read this.
viewer.subscribe(() => {
  chatCover.setViewerOpen(viewer.state.kind !== 'closed');
});

// The viewer shows a screenshot of the shown conversation only: it closes
// when another conversation (or another lifetime of the same one) is shown,
// and on sign-out or revocation.
let viewedLifetime = '';
store.subscribe(() => {
  const state = store.state;
  let lifetime = '';
  const shown = state.sessions.get(state.selected);
  if (shown && state.connection.status !== 'unpaired') {
    lifetime = shown.id + ' ' + (shown.toolEpoch ?? '');
  }
  if (lifetime !== viewedLifetime) {
    viewedLifetime = lifetime;
    viewer.close();
  }
});

// Signed out or revoked: text only the chat editor held (input the bridge
// refused) belongs to the previous pairing and must not be offered to the
// next one. The Store and the bridge clear their own state.
store.subscribe(() => {
  if (store.state.connection.status === 'unpaired' && chat.unresolved() !== null) {
    chat.setUnresolved(null);
  }
});

// Signed out: the next pairing starts with its conversation, not Settings.
store.subscribe(() => {
  if (store.state.connection.status === 'unpaired') {
    settingsView.setShown(false);
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
    // The microphone and its stream go at once, not when the reload has
    // unloaded the page: this tab must not send sound after the sign-out.
    listenHere.setWanted(false);
    window.location.reload();
    return;
  }
  // Another tab switched a Display setting: this tab follows that entry.
  if (event.key.startsWith(displayStoragePrefix)) {
    times.settings.followStorage(event.key);
  }
});

render(
  <StoreContext.Provider value={store}>
    <App
      chat={chat}
      bridge={bridge}
      times={times}
      settingsView={settingsView}
      activityOverlay={activityOverlay}
      viewer={viewer}
      chatCover={chatCover}
      widgets={widgets}
      listenHere={listenHere}
    />
  </StoreContext.Provider>,
  document.getElementById('app')!,
);

store.start();
