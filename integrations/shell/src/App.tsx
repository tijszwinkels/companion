/**
 * The browser shell around the trusted chat page: pairing, the connection
 * banner and toasts, and once paired the workspace (workspace/Workspace.tsx:
 * the conversation list, the bar above the chat and the chat). The
 * conversation itself is the desktop chat page (`Chat` from
 * integrations/session-apps/chat/Chat.tsx), rendered unchanged with the
 * gateway bridge (bridge.ts).
 *
 * State comes from the phone panel's Store: pairing and reconnection,
 * conversations and their order, the selected conversation (with browser
 * Back/Forward through its Navigation), unread marks and toasts.
 */

import { useState } from 'preact/hooks';

import type { ChatStore } from '../../session-apps/chat/store.ts';
import { useAppState, useStore } from '../../mobile/src/hooks.ts';
import type { AppState } from '../../mobile/src/store.ts';
import type { GatewayChatBridge } from './bridge.ts';
import type { SettingsView } from './settings/settings-view.ts';
import type { PageTimes } from './times/page-times.ts';
import { Workspace } from './workspace/Workspace.tsx';

export function App(props: {
  chat: ChatStore;
  bridge: GatewayChatBridge;
  times: PageTimes;
  settingsView: SettingsView;
}) {
  const state = useAppState();

  if (state.connection.status === 'unpaired') {
    return (
      <div class="shell" data-connection="unpaired">
        <Pairing />
      </div>
    );
  }

  // `data-connection` lets tests and styles see the connection state; the
  // banner tells the reader when it is not online.
  return (
    <div class="shell" data-connection={state.connection.status}>
      <ConnectionBanner />
      <Workspace
        chat={props.chat}
        bridge={props.bridge}
        times={props.times}
        settingsView={props.settingsView}
      />
      <Toasts />
    </div>
  );
}

function connectionLabel(state: AppState): string {
  const status = state.connection.status;
  if (status === 'online') {
    return 'Connected';
  }
  if (status === 'connecting') {
    return 'Connecting…';
  }
  if (status === 'offline') {
    return 'Offline';
  }
  if (status === 'engine-unavailable') {
    return 'Companion not running';
  }
  return 'Reconnecting…';
}

/**
 * Shown while the connection is not online. It says what happened and when
 * the next attempt is; "Retry now" connects at once. Nothing that was sent is
 * resent: the Store reports requests without an answer as uncertain.
 */
function ConnectionBanner() {
  const store = useStore();
  const state = useAppState();
  const connection = state.connection;
  if (connection.status === 'online' || connection.status === 'unpaired') {
    return null;
  }
  let message = connection.message;
  if (!message) {
    message = connectionLabel(state);
  }
  return (
    <div class="connection-banner" role="status">
      <span>{message}</span>
      <button class="shell-button" onClick={() => store.connection.connectNow()}>
        Retry now
      </button>
    </div>
  );
}

function Toasts() {
  const store = useStore();
  const state = useAppState();
  if (state.toasts.length === 0) {
    return null;
  }
  return (
    <div class="toasts" role="status">
      {state.toasts.map((toast) => (
        <div key={toast.id} class={`toast ${toast.tone}`}>
          <span>{toast.text}</span>
          <button
            class="shell-button"
            aria-label="Dismiss"
            onClick={() => store.dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Exchange a one-time code from `companion-remote pair` for this browser's
 * device credential (the phone panel's pairing, with browser wording).
 */
function Pairing() {
  const store = useStore();
  const state = useAppState();
  const [code, setCode] = useState('');
  const [name, setName] = useState('Browser');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await store.connection.pair(code, name, '');
      setCode('');
    } catch (failure) {
      if (failure instanceof Error) {
        setError(failure.message);
      } else {
        setError(String(failure));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="pairing">
      <h1>Pair this browser</h1>
      <p>
        Companion runs on your computer. This browser connects to it only after you approve it with
        a one-time code.
      </p>
      {state.connection.message && <p class="error">{state.connection.message}</p>}
      <ol>
        <li>
          On the computer, run <code>companion-remote pair</code>.
        </li>
        <li>Enter the code it shows. It works once, for 10 minutes.</li>
      </ol>
      <form onSubmit={submit}>
        <label for="code">Pairing code</label>
        <input
          id="code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellcheck={false}
          placeholder="XXXXX-XXXXX"
          maxLength={16}
          value={code}
          onInput={(event) => setCode(event.currentTarget.value)}
          required
        />
        <label for="device-name">Name for this browser</label>
        <input
          id="device-name"
          maxLength={60}
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button class="shell-button primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? 'Pairing…' : 'Pair browser'}
        </button>
      </form>
    </main>
  );
}
