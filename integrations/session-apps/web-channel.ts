/**
 * Connects a trusted Companion page to the `companion` object its native view
 * registers on the QWebChannel. Qt's qwebchannel.js, loaded by the page's
 * HTML before the module, defines `QWebChannel`; `qt.webChannelTransport`
 * exists only in views that have a channel (never in session applications).
 *
 * Returns false outside Companion, where the page shows a short notice.
 */

interface ChannelHost {
  QWebChannel?: new (
    transport: unknown,
    ready: (channel: { objects: { companion: unknown } }) => void,
  ) => unknown;
  qt?: { webChannelTransport: unknown };
}

export function connectChannel<Bridge>(ready: (bridge: Bridge) => void): boolean {
  const host = window as unknown as ChannelHost;
  if (!host.QWebChannel || !host.qt) {
    return false;
  }

  new host.QWebChannel(host.qt.webChannelTransport, (channel) => {
    ready(channel.objects.companion as Bridge);
  });
  return true;
}
