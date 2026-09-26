/**
 * Top-level layout, following the desktop panel: a session rail on the left
 * and the selected page on the right (Activity, Previous sessions or a
 * conversation). The page header has a menu button that shows or hides the
 * rail, the page title, and phone settings where the desktop has its close
 * button.
 */

import { useEffect, useState } from 'preact/hooks';

import { useAppState, useStore } from '../hooks.ts';
import { ActivityPage } from './Activity.tsx';
import { ConversationPage } from './Conversation.tsx';
import { MenuIcon, SettingsIcon } from './icons.tsx';
import { Pairing } from './Pairing.tsx';
import { PreviousPage } from './Previous.tsx';
import { Rail } from './Rail.tsx';
import { SettingsSheet } from './Settings.tsx';

const railKey = 'companion.remote.rail';

/** Remembered per phone; defaults to open unless the screen is very narrow. */
function initialRailOpen(): boolean {
  try {
    const saved = localStorage.getItem(railKey);
    if (saved === 'open' || saved === 'closed') {
      return saved === 'open';
    }
  } catch {
    // Storage unavailable: fall through to the width default.
  }
  return window.innerWidth >= 360;
}

export function App() {
  const state = useAppState();
  const [railOpen, setRailOpen] = useState(initialRailOpen);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(railKey, railOpen ? 'open' : 'closed');
    } catch {
      // A convenience only.
    }
  }, [railOpen]);

  if (state.connection.status === 'unpaired') {
    return (
      <div class="app">
        <Pairing />
      </div>
    );
  }

  const selected = state.selected ? state.sessions.get(state.selected) : undefined;
  const title = state.showingPrevious
    ? 'Previous sessions'
    : selected
      ? selected.title || 'Untitled'
      : 'Companion';
  const unreadCount = state.unread.size;

  return (
    <div class="app">
      <ConnectionBanner />
      <div class="shell">
        {railOpen && <Rail />}
        <main class="body">
          <header class="page-header">
            <button
              class="icon-button"
              aria-label={railOpen ? 'Hide sessions' : 'Show sessions'}
              aria-expanded={railOpen}
              onClick={() => setRailOpen(!railOpen)}
            >
              <MenuIcon />
              {!railOpen && unreadCount > 0 && <span class="menu-dot" aria-hidden="true" />}
            </button>
            <h1>{title}</h1>
            <button
              class="icon-button"
              aria-label="Phone settings"
              aria-haspopup="dialog"
              onClick={() => setSettings(true)}
            >
              <SettingsIcon size={20} />
            </button>
          </header>

          {state.showingPrevious ? (
            <PreviousPage />
          ) : selected ? (
            <ConversationPage session={selected} />
          ) : (
            <ActivityPage />
          )}
        </main>
      </div>
      {settings && <SettingsSheet onClose={() => setSettings(false)} />}
      <Toasts />
    </div>
  );
}

/** Always-visible explanation whenever the phone is not fully connected. */
function ConnectionBanner() {
  const state = useAppState();
  const store = useStore();
  const { status, message, retryAt } = state.connection;
  const [, tick] = useState(0);

  useEffect(() => {
    if (!retryAt) {
      return;
    }
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  if (status === 'online' && state.engine?.ready !== false) {
    return null;
  }

  if (status === 'online') {
    return (
      <div class="banner" role="status">
        Companion is starting on the computer…
      </div>
    );
  }

  const seconds = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
  const error = status === 'engine-unavailable' || status === 'offline';

  return (
    <div class={`banner ${error ? 'error' : ''}`} role="status" aria-live="polite">
      <span>
        {message || 'Connecting…'}
        {seconds > 0 ? ` Retrying in ${seconds}s.` : ''}
      </span>
      <span class="spacer" />
      {status !== 'connecting' && status !== 'offline' && (
        <button onClick={() => store.connection.connectNow()}>Retry now</button>
      )}
    </div>
  );
}

function Toasts() {
  const state = useAppState();
  const store = useStore();

  return (
    <div class="toasts" aria-live="assertive">
      {state.toasts.map((toast) => (
        <div
          key={toast.id}
          class={`toast ${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          onClick={() => store.dismissToast(toast.id)}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
