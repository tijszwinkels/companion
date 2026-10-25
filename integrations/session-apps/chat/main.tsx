/**
 * Entry point of the trusted HTML chat page (dist/chat.html).
 *
 * Connects to the `companion` QWebChannel object registered by
 * TrustedChatView.qml, then renders the conversation it mirrors. Qt's
 * qwebchannel.js is loaded first by chat.html and defines `QWebChannel`.
 */

import { render } from 'preact';

import { blurComposer, Chat, focusComposer } from './Chat.tsx';
import { connectChannel } from '../web-channel.ts';
import type { NativeBridge } from './protocol.ts';
import { ChatStore } from './store.ts';
import './styles.css';

declare global {
  interface Window {
    companionChat?: { focusComposer(): void; blurComposer(): void };
  }
}

const store = new ChatStore();
const root = document.getElementById('chat')!;

window.companionChat = { focusComposer, blurComposer };

const connected = connectChannel<NativeBridge>((bridge) => {
  // Exposed for offscreen tests of the native checks. It grants nothing the
  // page does not already have; transcript content cannot run scripts.
  (window as unknown as { __companionBridge: NativeBridge }).__companionBridge = bridge;
  store.attach(bridge);
  render(<Chat store={store} />, root);
});

if (!connected) {
  root.textContent = 'This page only runs inside Companion.';
}
