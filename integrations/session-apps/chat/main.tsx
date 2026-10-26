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
    companionChat?: {
      focusComposer(): void;
      blurComposer(): void;
      connected: boolean;
      heldText(sessionId: string): string;
    };
  }
}

const store = new ChatStore();
const root = document.getElementById('chat')!;

// `connected` is the native view's liveness signal (TrustedChatView.qml).
window.companionChat = {
  focusComposer,
  blurComposer,
  connected: false,
  // Read by the native view before a disappeared conversation's window goes.
  heldText: (sessionId: string) => store.held()[sessionId] ?? '',
};

const connected = connectChannel<NativeBridge>((bridge) => {
  // Exposed for offscreen tests of the native checks. It grants nothing the
  // page does not already have; transcript content cannot run scripts.
  (window as unknown as { __companionBridge: NativeBridge }).__companionBridge = bridge;
  store.attach(bridge);
  window.companionChat!.connected = true;
  render(<Chat store={store} />, root);
});

if (!connected) {
  root.textContent = 'This page only runs inside Companion.';
}
