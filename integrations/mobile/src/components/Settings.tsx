/**
 * Engine controls that the desktop panel also offers (sounds, per-intent
 * inference and shortcut switches) plus phone-only settings: this device's
 * pairing and connection details.
 */

import { useState } from 'preact/hooks';

import type { IntentState } from '../../../../src/remote/protocol.ts';
import { useAppState, useStore } from '../hooks.ts';

export function Settings() {
  const state = useAppState();
  const store = useStore();
  const engine = state.engine;
  const online = state.connection.status === 'online';
  const [confirmForget, setConfirmForget] = useState(false);

  // Older listeners without independent switches cannot be controlled safely.
  const intents = engine?.intents ?? [];
  const independent = intents.every((intent) => intent.inferenceEnabled !== undefined);

  return (
    <div class="screen">
      <header class="topbar">
        <h1>Settings</h1>
      </header>
      <div class="scroll">
        <section class="section">
          <h2 class="section-title">Companion on the computer</h2>
          <div class="card settings-group">
            <div class="setting-row">
              <div class="label">
                Sound feedback
                <small>Cues on the computer when speech is handled.</small>
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
                Listening
                <small>
                  {engine?.paused
                    ? engine.pauseReason === 'media'
                      ? 'Paused while media plays'
                      : 'Microphone paused'
                    : 'Microphone on'}
                </small>
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
          </div>

          <h2 class="section-title">Intents and shortcuts</h2>
          {!independent && (
            <p class="hint">Restart Companion on the computer to load independent switches.</p>
          )}
          <div class="card settings-group">
            {intents.map((intent) => (
              <IntentRow key={intent.name} intent={intent} disabled={!online || !independent} />
            ))}
            {intents.length === 0 && <div class="empty">No intents reported yet.</div>}
          </div>
          <p class="hint">
            Intent lets the local classifier choose this action; Shortcut enables its spoken prefix.
            Greyed items are not available in the current context.
          </p>

          <h2 class="section-title">This phone</h2>
          <div class="card settings-group">
            <div class="setting-row">
              <div class="label">
                {state.connection.deviceName || 'Paired phone'}
                <small>
                  {online ? 'Connected' : state.connection.message || state.connection.status}
                  {store.connection.server ? ` · ${store.connection.server}` : ''}
                </small>
              </div>
            </div>
            <div class="setting-row">
              <div class="label">
                Sign out on this phone
                <small>Also run companion-remote revoke on the computer to remove it.</small>
              </div>
              {confirmForget ? (
                <button class="button small danger" onClick={() => store.connection.forget()}>
                  Sign out
                </button>
              ) : (
                <button class="button small" onClick={() => setConfirmForget(true)}>
                  Sign out…
                </button>
              )}
            </div>
          </div>
          <p class="hint">
            Speech, screen context and agents run on the computer. This app talks only to your
            Companion gateway; it loads nothing from other sites.
          </p>
        </section>
        <div style={{ height: '24px' }} />
      </div>
    </div>
  );
}

function IntentRow(props: { intent: IntentState; disabled: boolean }) {
  const store = useStore();
  const { intent } = props;
  const [busy, setBusy] = useState(false);

  async function toggle(mode: 'inference' | 'shortcut', enabled: boolean) {
    setBusy(true);
    try {
      await store.request('set-intent-enabled', { name: intent.name, mode, enabled });
    } catch {
      // Toast shown by the store; the switch keeps the engine's state.
    } finally {
      setBusy(false);
    }
  }

  const hasShortcut = (intent.prefixes?.length ?? 0) > 0;
  const locked = !intent.toggleable || props.disabled || busy;

  return (
    <div class="intent-row">
      <div class="name">{intent.label}</div>
      {hasShortcut && <div class="prefixes">“{intent.prefixes!.join('”, “')}”</div>}
      <div class="toggles">
        {intent.supportsInference && (
          <label class={`toggle ${intent.inferenceAvailable === false ? 'disabled' : ''}`}>
            <button
              class="switch"
              role="switch"
              aria-checked={intent.inferenceEnabled === true}
              aria-label={`${intent.label} intent`}
              disabled={locked}
              onClick={() => void toggle('inference', !intent.inferenceEnabled)}
            />
            Intent{intent.inferenceAvailable === false ? ' (unavailable now)' : ''}
          </label>
        )}
        {hasShortcut && (
          <label class="toggle">
            <button
              class="switch shortcut"
              role="switch"
              aria-checked={intent.shortcutEnabled === true}
              aria-label={`${intent.label} shortcut`}
              disabled={locked}
              onClick={() => void toggle('shortcut', !intent.shortcutEnabled)}
            />
            Shortcut{intent.prefixAvailable === false ? ' (unavailable now)' : ''}
          </label>
        )}
        {!intent.toggleable && <span class="hint">Always on</span>}
      </div>
    </div>
  );
}
