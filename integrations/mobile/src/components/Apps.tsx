/**
 * Local apps on the computer that this phone may open (docs/local-apps.md).
 *
 * The gateway lists apps whose registration allows phone access and which
 * have their own configured origin. Opening one asks the gateway, with this
 * phone's device token, for a one-time address on the app's own origin and
 * opens it as a normal top-level page: the app never runs inside this panel,
 * never shares its origin, and never sees the device token. Apps that refuse
 * to be framed therefore still work.
 *
 * The list is fetched when the phone comes online and whenever the sheet is
 * opened; nothing here is cached across sign-out.
 */

import { useEffect, useState } from 'preact/hooks';

import { gatewayUrl } from '../connection.ts';
import { useAppState, useStore } from '../hooks.ts';
import { Sheet } from './Sheet.tsx';

/** One entry from `GET api/apps`. */
export interface PhoneApp {
  id: string;
  name: string;
  /** The app's own origin, e.g. https://budget.example.ts.net. */
  origin: string;
  /** Whether its backend accepted a connection when listed. */
  running: boolean;
}

/**
 * The current app list, refreshed each time the connection comes online.
 * `refresh` reloads it on demand. Failures leave the previous list in place;
 * an unconfigured gateway simply returns no apps.
 */
export function usePhoneApps(): { apps: PhoneApp[]; refresh(): Promise<void> } {
  const state = useAppState();
  const store = useStore();
  const [apps, setApps] = useState<PhoneApp[]>([]);
  const online = state.connection.status === 'online';

  async function refresh(): Promise<void> {
    const response = await fetch(gatewayUrl('api/apps', store.connection.server), {
      headers: { Authorization: `Bearer ${store.connection.token}` },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) {
      throw Error(`Could not list apps (${response.status})`);
    }

    const body = (await response.json()) as { apps?: PhoneApp[] };
    setApps(Array.isArray(body.apps) ? body.apps : []);
  }

  useEffect(() => {
    if (!online) {
      return;
    }
    refresh().catch(() => {});
  }, [online]);

  useEffect(() => {
    if (state.connection.status === 'unpaired') {
      setApps([]);
    }
  }, [state.connection.status]);

  return { apps, refresh };
}

export function AppsSheet(props: { apps: PhoneApp[]; refresh(): Promise<void>; onClose(): void }) {
  const store = useStore();
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    props.refresh().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);

  async function open(app: PhoneApp): Promise<void> {
    setError('');
    setOpening(app.id);

    // Open the new tab now, inside the tap, so Safari's pop-up blocker allows
    // it; it is pointed at the app once the gateway answers. The app must not
    // be able to reach back to this panel through window.opener.
    const tab = window.open('', '_blank');
    if (tab) {
      tab.opener = null;
    }

    try {
      const response = await fetch(
        gatewayUrl(`api/apps/${encodeURIComponent(app.id)}/open`, store.connection.server),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${store.connection.token}` },
          credentials: 'omit',
          cache: 'no-store',
        },
      );
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || typeof body.url !== 'string') {
        throw Error(body.error || `Could not open ${app.name} (${response.status})`);
      }

      // Only ever navigate to the origin this app was listed with.
      if (new URL(body.url).origin !== app.origin) {
        throw Error(`Unexpected address for ${app.name}`);
      }

      if (tab) {
        tab.location.replace(body.url);
      } else {
        window.location.assign(body.url);
      }
    } catch (reason) {
      tab?.close();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpening('');
    }
  }

  return (
    <Sheet title="Apps" onClose={props.onClose}>
      {props.apps.length === 0 && <p class="hint">No apps are available on this phone.</p>}
      {props.apps.map((app) => (
        <div class="setting-row" key={app.id}>
          <div class="label">
            {app.name}
            <small>
              {app.running ? 'Running' : 'Not running on the computer'} · {app.origin}
            </small>
          </div>
          <button
            class="action small"
            disabled={opening !== ''}
            aria-label={`Open ${app.name}`}
            onClick={() => void open(app)}
          >
            {opening === app.id ? 'Opening…' : 'Open'}
          </button>
        </div>
      ))}
      {error && (
        <p class="hint" role="alert">
          {error}
        </p>
      )}
      <p class="hint">
        Apps open in their own browser tab on their own address. They are separate web apps running
        on your computer; Companion only passes them your tap, never this phone's Companion
        credentials. Apps are added and made available to phones on the computer with{' '}
        <code>companion-app</code>.
      </p>
    </Sheet>
  );
}
