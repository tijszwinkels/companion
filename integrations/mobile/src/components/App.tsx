/** Top-level layout: pairing, or tabs with a full-screen conversation view. */

import { useEffect, useState } from 'preact/hooks';

import { useAppState, useStore } from '../hooks.ts';
import { Activity } from './Activity.tsx';
import { ChatList } from './ChatList.tsx';
import { Conversation } from './Conversation.tsx';
import { ActivityIcon, ChatIcon, SettingsIcon } from './icons.tsx';
import { Pairing } from './Pairing.tsx';
import { Settings } from './Settings.tsx';

export function App() {
  const state = useAppState();

  if (state.connection.status === 'unpaired') {
    return (
      <div class="app">
        <Pairing />
      </div>
    );
  }

  const selected = state.selected ? state.sessions.get(state.selected) : undefined;

  return (
    <div class="app">
      <ConnectionBanner />
      {selected ? (
        <Conversation session={selected} />
      ) : (
        <>
          {state.tab === 'chats' && <ChatList />}
          {state.tab === 'activity' && <Activity />}
          {state.tab === 'settings' && <Settings />}
          <TabBar />
        </>
      )}
      <Toasts />
    </div>
  );
}

function TabBar() {
  const state = useAppState();
  const store = useStore();
  const working = [...state.sessions.values()].filter(
    (session) => session.status === 'running' || session.status === 'starting',
  ).length;

  const tabs = [
    { id: 'chats', label: 'Chats', icon: <ChatIcon />, badge: working },
    { id: 'activity', label: 'Activity', icon: <ActivityIcon />, badge: 0 },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon />, badge: 0 },
  ] as const;

  return (
    <nav class="tabbar" aria-label="Sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          aria-current={state.tab === tab.id ? 'page' : undefined}
          onClick={() => store.setTab(tab.id)}
        >
          {tab.icon}
          {tab.label}
          {tab.badge > 0 && (
            <span class="badge" aria-label={`${tab.badge} working`}>
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </nav>
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
