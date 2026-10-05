/** Phone panel entry point. */

import { render } from 'preact';

import { App } from './components/App.tsx';
import { StoreContext } from './hooks.ts';
import { Store } from './store.ts';
import './styles.css';

const store = new Store();

render(
  <StoreContext.Provider value={store}>
    <App />
  </StoreContext.Provider>,
  document.getElementById('app')!,
);

store.start();
