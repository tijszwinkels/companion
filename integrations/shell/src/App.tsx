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
 *
 * When the gateway refuses this tab over a connection limit, the limit page
 * (`LimitPage`) lies over everything until the reader's Retry connects; the
 * workspace stays underneath, inert, so nothing the reader had open is lost.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { ChatStore } from '../../session-apps/chat/store.ts';
import { useAppState, useStore } from '../../mobile/src/hooks.ts';
import type { AppState } from '../../mobile/src/store.ts';
import type { GatewayChatBridge } from './bridge.ts';
import type { ActivityOverlay } from './layout/activity-overlay.ts';
import type { SettingsView } from './settings/settings-view.ts';
import type { PageTimes } from './times/page-times.ts';
import { Workspace } from './workspace/Workspace.tsx';

export function App(props: {
  chat: ChatStore;
  bridge: GatewayChatBridge;
  times: PageTimes;
  settingsView: SettingsView;
  activityOverlay: ActivityOverlay;
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
  // banner tells the reader when it is not online. The page's content is
  // laid out as if the wrapper were not there (`display: contents`); it is
  // only there to make everything inert under the limit page.
  const limited = state.connection.status === 'limited';
  return (
    <div class="shell" data-connection={state.connection.status}>
      <div class="shell-content" inert={limited}>
        <ConnectionBanner />
        <Workspace
          chat={props.chat}
          bridge={props.bridge}
          times={props.times}
          settingsView={props.settingsView}
          activityOverlay={props.activityOverlay}
        />
        <Toasts />
      </div>
      {limited && <LimitPage />}
    </div>
  );
}

/**
 * Shown when the gateway refused this tab over a connection limit (close
 * code 4429 with the reason `device` or `total`): which limit, what to do,
 * and Retry. Nothing reconnects by itself while it is shown, and no tab is
 * ever closed for this one. The text names no other device
 * (`limitMessages` in the phone Connection, shared with the phone panel).
 */
function LimitPage() {
  const store = useStore();
  const state = useAppState();
  const retry = useRef<HTMLButtonElement>(null);

  // The page takes the keyboard focus: everything under it is inert.
  useEffect(() => {
    retry.current?.focus();
  }, []);

  return (
    <div
      class="limit-page"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="limit-title"
      aria-describedby="limit-text"
    >
      <div class="limit-card">
        <h1 id="limit-title">Too many connections</h1>
        <p id="limit-text">{state.connection.message}</p>
        <button
          ref={retry}
          class="shell-button primary"
          onClick={() => store.connection.retryAfterLimit()}
        >
          Retry
        </button>
      </div>
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
  if (status === 'limited') {
    return 'Too many connections';
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
  // The limit page has its own Retry; "Retry now" would be under it.
  if (
    connection.status === 'online' ||
    connection.status === 'unpaired' ||
    connection.status === 'limited'
  ) {
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
