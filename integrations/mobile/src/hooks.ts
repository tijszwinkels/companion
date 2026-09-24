/** Preact binding for the framework-free store. */

import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';

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
  const [, setVersion] = useState(0);

  useEffect(() => {
    return store.subscribe(() => setVersion((version) => version + 1));
  }, [store]);

  return store.state;
}
