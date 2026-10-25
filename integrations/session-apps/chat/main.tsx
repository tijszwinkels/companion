/**
 * Entry point of the trusted HTML chat page (dist/chat.html).
 *
 * Connects to the `companion` QWebChannel object registered by
 * TrustedChatView.qml, then renders the conversation it mirrors. Qt's
 * qwebchannel.js is loaded first by chat.html and defines `QWebChannel`.
 */

import { render } from 'preact';

import { blurComposer, Chat, focusComposer } from './Chat.tsx';
import type { NativeBridge } from './protocol.ts';
import { ChatStore } from './store.ts';
import './styles.css';

declare global {
  interface Window {
    QWebChannel?: new (
      transport: unknown,
      ready: (channel: { objects: { companion: NativeBridge } }) => void,
    ) => unknown;
    qt?: { webChannelTransport: unknown };
    companionChat?: { focusComposer(): void; blurComposer(): void };
  }
}

const store = new ChatStore();
const root = document.getElementById('chat')!;

window.companionChat = { focusComposer, blurComposer };

if (window.QWebChannel && window.qt) {
  new window.QWebChannel(window.qt.webChannelTransport, (channel) => {
    // Exposed for offscreen tests of the native checks. It grants nothing the
    // page does not already have; transcript content cannot run scripts.
    (window as unknown as { __companionBridge: NativeBridge }).__companionBridge =
      channel.objects.companion;
    store.attach(channel.objects.companion);
    render(<Chat store={store} />, root);
  });
} else {
  root.textContent = 'This page only runs inside Companion.';
}
