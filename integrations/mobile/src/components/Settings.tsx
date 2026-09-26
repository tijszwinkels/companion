/**
 * Phone settings sheet, opened from the header where the desktop panel has
 * its close button: listening and sound feedback (on the desktop these live
 * in the Omarchy bar and shortcuts), and this phone's pairing.
 */

import { useState } from 'preact/hooks';

import { useAppState, useStore } from '../hooks.ts';
import { listeningStatus } from './Activity.tsx';
import { Sheet } from './Sheet.tsx';

export function SettingsSheet(props: { onClose(): void }) {
  const state = useAppState();
  const store = useStore();
  const engine = state.engine;
  const online = state.connection.status === 'online';
  const [confirmForget, setConfirmForget] = useState(false);

  return (
    <Sheet title="Settings" onClose={props.onClose}>
      <div class="setting-row">
        <div class="label">
          Listening
          <small>{listeningStatus(state).title}</small>
        </div>
        <button
          class="switch"
          role="switch"
          aria-checked={engine ? !engine.paused : false}
          aria-label="Listening"
          disabled={!online || !engine?.ready}
          onClick={() => void store.request('toggle-pause', {}).catch(() => {})}
        />
      </div>
      <div class="setting-row">
        <div class="label">
          Sound feedback
          <small>Cues play on the computer.</small>
        </div>
        <button
          class="switch"
          role="switch"
          aria-checked={engine?.soundsEnabled ?? false}
          aria-label="Sound feedback"
          disabled={!online || !engine || engine.preview}
          onClick={() => void store.request('toggle-sounds', {}).catch(() => {})}
        />
      </div>
      <div class="setting-row">
        <div class="label">
          {state.connection.deviceName || 'This phone'}
          <small>
            {online ? 'Connected' : state.connection.message || state.connection.status}
            {store.connection.server ? ` · ${store.connection.server}` : ''}
          </small>
        </div>
        {confirmForget ? (
          <button class="action small danger" onClick={() => store.connection.forget()}>
            Sign out
          </button>
        ) : (
          <button class="action small" onClick={() => setConfirmForget(true)}>
            Sign out…
          </button>
        )}
      </div>
      <p class="hint">
        Also run <code>companion-remote revoke</code> on the computer to remove this phone. Speech,
        screen context and agents run on the computer; this app talks only to your Companion
        gateway.
      </p>
    </Sheet>
  );
}
