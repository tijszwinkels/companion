/** Preact binding for the framework-free store. */

import { createContext } from 'preact';
import { useSyncExternalStore } from 'preact/compat';
import { useContext } from 'preact/hooks';

import type { AppState, Store } from './store.ts';

export const StoreContext = createContext<Store | undefined>(undefined);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) {
    throw Error('StoreContext is missing');
  }
  return store;
}

/** Re-render on every store change and return the current state. */
export function useAppState(): AppState {
  const store = useStore();
  // Re-check after subscribing: a loopback authentication/snapshot can arrive
  // between render and the subscription, especially when reloading a paired
  // phone. A passive effect alone could leave the first snapshot invisible.
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.state,
  );
}
