/**
 * First run (or after revocation): exchange the code shown by
 * `companion-remote pair` on the computer for a device credential.
 */

import { useState } from 'preact/hooks';

import { useAppState, useStore } from '../hooks.ts';

/** Pages loaded from a wrapper (e.g. capacitor://) must name the gateway. */
const needsServer = !/^https?:$/.test(window.location.protocol);

export function Pairing() {
  const store = useStore();
  const state = useAppState();
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName());
  const [server, setServer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError('');

    try {
      await store.connection.pair(code, name, needsServer ? server : '');
      setCode('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="pairing">
      <div class="logo" aria-hidden="true">
        <span style={{ height: '12px' }} />
        <span style={{ height: '30px' }} />
        <span style={{ height: '20px' }} />
      </div>
      <h1>Pair this phone</h1>
      <p>
        Companion runs on your computer. This phone connects to it over your private network, only
        after you approve it with a one-time code.
      </p>
      {state.connection.message && <p class="error">{state.connection.message}</p>}
      <ol>
        <li>
          On the computer, run <code>companion-remote pair</code>.
        </li>
        <li>Enter the code it shows. It works once, for 10 minutes.</li>
      </ol>

      <form onSubmit={submit}>
        {needsServer && (
          <>
            <label class="field-label" for="server">
              Companion address
            </label>
            <input
              id="server"
              class="field"
              type="url"
              inputMode="url"
              placeholder="https://desk.your-tailnet.ts.net:8443"
              value={server}
              onInput={(event) => setServer(event.currentTarget.value)}
              required
            />
          </>
        )}

        <label class="field-label" for="code">
          Pairing code
        </label>
        <input
          id="code"
          class="field code-input"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellcheck={false}
          placeholder="XXXXX-XXXXX"
          maxLength={16}
          value={code}
          onInput={(event) => setCode(event.currentTarget.value)}
          required
        />

        <label class="field-label" for="device-name">
          Name for this phone
        </label>
        <input
          id="device-name"
          class="field"
          maxLength={60}
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
        />

        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}

        <button class="action primary submit" type="submit" disabled={busy || !code.trim()}>
          {busy ? 'Pairing…' : 'Pair phone'}
        </button>
      </form>

      <p class="hint">
        The computer keeps only a fingerprint of this phone’s key. Remove it any time with{' '}
        <code>companion-remote revoke</code>.
      </p>
    </main>
  );
}

function defaultDeviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) {
    return 'iPhone';
  }
  if (/iPad/.test(agent)) {
    return 'iPad';
  }
  if (/Android/.test(agent)) {
    return 'Android phone';
  }
  return 'Phone';
}
