/**
 * The limit page: shown when the gateway refused this page over a
 * connection limit (close code 4429 with the reason `device` or `total`,
 * src/remote/README.md "Limits"). It says which limit was reached and what
 * to do (`limitMessages` in connection.ts), and offers Retry. Nothing
 * reconnects by itself while it is shown, no other tab or phone is closed
 * for this one, and the text names no other device.
 *
 * It lies over the whole app (App.tsx makes the rest inert meanwhile), so
 * the page underneath and its drafts are as the reader left them when Retry
 * connects. Open sheets and menus are closed when it appears (the Store
 * closes every modal: their layer would make the limit page inert); none
 * of them holds typed text.
 */

import { useEffect, useRef } from 'preact/hooks';

import { useAppState, useStore } from '../hooks.ts';

export function LimitPage() {
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
          class="action primary"
          onClick={() => store.connection.retryAfterLimit()}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
