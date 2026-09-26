/**
 * The phone's single WebSocket to the Companion gateway.
 *
 * Responsibilities:
 * - Keep the paired device credential (token) for this origin.
 * - Connect, authenticate with the first message, and reconnect with backoff
 *   after network loss, sleep or an unavailable listener.
 * - Correlate requests with replies by request ID.
 *
 * Deliberate non-behavior: a request that was sent but not answered before the
 * connection dropped is reported as *uncertain* and is never resent. The user
 * sees the refreshed state and decides. (The gateway also keeps receipts, so
 * even an accidental resend with the same ID would not execute twice.)
 */

import type {
  EngineEvent,
  GatewayMessage,
  RemoteAction,
  RemoteActionParameters,
} from '../../../src/remote/protocol.ts';

export type ConnectionStatus =
  'unpaired' | 'connecting' | 'online' | 'reconnecting' | 'engine-unavailable' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Human explanation for the current status, shown in the banner. */
  message: string;
  /** Epoch milliseconds of the next automatic attempt, when waiting. */
  retryAt: number;
  deviceName: string;
}

export interface DeviceCredential {
  token: string;
  deviceId: string;
  deviceName: string;
  /** Gateway origin; empty means the page's own origin. */
  server: string;
}

/** Thrown when the outcome of a request is unknown (connection lost/timeout). */
export class UncertainOutcome extends Error {}

const credentialKey = 'companion.remote.device';

/** A reply is expected well within this; slower means "unknown outcome". */
const requestTimeoutMilliseconds = 20_000;

const closeCodes = {
  unauthorized: 4401,
  revoked: 4403,
  overloaded: 4429,
  engineUnavailable: 4503,
};

/** Storage can be unavailable (private mode, blocked site data). */
function readCredential(): DeviceCredential | undefined {
  try {
    const text = localStorage.getItem(credentialKey);
    if (!text) {
      return undefined;
    }
    const value = JSON.parse(text) as DeviceCredential;
    return typeof value.token === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeCredential(value: DeviceCredential | undefined): void {
  try {
    if (value) {
      localStorage.setItem(credentialKey, JSON.stringify(value));
    } else {
      localStorage.removeItem(credentialKey);
    }
  } catch {
    // The session still works until reload; the pairing screen explains.
  }
}

/** Random, URL-safe request ID; works outside secure contexts too. */
export function newRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}

/** Absolute gateway URL for a path, honoring a configured server origin. */
export function gatewayUrl(path: string, server = ''): string {
  return new URL(path, server || window.location.origin).href;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class Connection {
  private socket?: WebSocket;
  private credential = readCredential();
  private readonly pending = new Map<string, Pending>();
  private attempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastMessageAt = 0;
  private stopped = false;

  // A paired phone starts as "connecting" so it never flashes the pairing form.
  state: ConnectionState = {
    status: this.credential ? 'connecting' : 'unpaired',
    message: '',
    retryAt: 0,
    deviceName: this.credential?.deviceName ?? '',
  };

  constructor(
    private readonly onEvent: (event: EngineEvent) => void,
    private readonly onState: (state: ConnectionState) => void,
    /** Called after each successful authentication, before any events. */
    private readonly onOnline: () => void,
  ) {
    window.addEventListener('online', () => this.connectNow());
    window.addEventListener('offline', () => this.networkLost());
    document.addEventListener('visibilitychange', () => {
      // Phones suspend sockets in the background. Coming back should not wait
      // for a long backoff that accumulated while the screen was off.
      if (document.visibilityState === 'visible') {
        this.connectNow();
      }
    });
  }

  get paired(): boolean {
    return Boolean(this.credential);
  }

  get server(): string {
    return this.credential?.server ?? '';
  }

  get token(): string {
    return this.credential?.token ?? '';
  }

  start(): void {
    this.stopped = false;
    if (!this.credential) {
      this.setState({ status: 'unpaired', message: '', retryAt: 0 });
      return;
    }
    this.open();
  }

  /** Exchange a pairing code for a device token and connect. */
  async pair(code: string, name: string, server: string): Promise<void> {
    const response = await fetch(gatewayUrl('api/pair', server), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name }),
      credentials: 'omit',
    });
    const body = (await response.json().catch(() => ({}))) as {
      token?: string;
      deviceId?: string;
      deviceName?: string;
      error?: string;
    };

    if (!response.ok || !body.token || !body.deviceId) {
      throw Error(body.error || `Pairing failed (HTTP ${response.status})`);
    }

    this.credential = {
      token: body.token,
      deviceId: body.deviceId,
      deviceName: body.deviceName ?? name,
      server,
    };
    writeCredential(this.credential);
    this.retireSocket();
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** Forget this phone's credential locally. Revoke it on the computer too. */
  forget(): void {
    this.credential = undefined;
    writeCredential(undefined);
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retireSocket();
    this.setState({ status: 'unpaired', message: 'This phone was signed out.', retryAt: 0 });
  }

  /**
   * Send one request and resolve with its result. Rejects with the server's
   * error message, or with `UncertainOutcome` when the reply never arrived.
   */
  request<Action extends RemoteAction>(
    action: Action,
    parameters: RemoteActionParameters[Action],
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.state.status !== 'online') {
      return Promise.reject(Error('Not connected to Companion'));
    }

    const requestId = newRequestId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new UncertainOutcome(
            'Companion has not answered yet. It may still complete; check before retrying.',
          ),
        );
      }, requestTimeoutMilliseconds);

      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'request', requestId, action, ...parameters }));
    });
  }

  private setState(change: Partial<ConnectionState>): void {
    this.state = {
      ...this.state,
      ...change,
      deviceName: this.credential?.deviceName ?? '',
    };
    this.onState(this.state);
  }

  private open(): void {
    clearTimeout(this.retryTimer);
    if (!this.credential || this.stopped) {
      return;
    }

    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      return;
    }

    if (!navigator.onLine) {
      this.networkLost();
      return;
    }

    this.setState({
      status: this.attempt === 0 ? 'connecting' : 'reconnecting',
      message: this.attempt === 0 ? 'Connecting to Companion…' : 'Reconnecting…',
      retryAt: 0,
    });

    const url = new URL('api/socket', this.credential.server || window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const socket = new WebSocket(url.href);
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket) {
        return;
      }
      this.retireSocket();
      this.scheduleRetry('reconnecting', 'Connection timed out. Retrying…');
    }, 10_000);

    socket.addEventListener('open', () => {
      if (this.socket === socket) {
        socket.send(JSON.stringify({ type: 'auth', token: this.credential?.token ?? '' }));
      }
    });
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) {
        this.message(event.data);
      }
    });
    socket.addEventListener('close', (event) => this.closed(socket, event.code, event.reason));
  }

  private message(data: unknown): void {
    let message: GatewayMessage;
    try {
      message = JSON.parse(String(data)) as GatewayMessage;
    } catch {
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }
    this.lastMessageAt = Date.now();

    if (message.type === 'pong') {
      return;
    }

    if (message.type === 'authenticated') {
      clearTimeout(this.connectTimer);
      this.startHeartbeat();
      this.attempt = 0;
      this.setState({ status: 'online', message: '', retryAt: 0 });
      this.onOnline();
      return;
    }

    if (message.type === 'engine') {
      this.onEvent(message.message);
      return;
    }

    if (!message.requestId) {
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);

    if (message.type === 'result') {
      pending.resolve(message.result);
    } else {
      pending.reject(Error(message.message));
    }
  }

  private closed(socket: WebSocket, code: number, reason: string): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);

    this.rejectPending();

    if (this.stopped) {
      return;
    }

    if (code === closeCodes.unauthorized || code === closeCodes.revoked) {
      this.credential = undefined;
      writeCredential(undefined);
      this.setState({
        status: 'unpaired',
        message:
          code === closeCodes.revoked
            ? 'This phone was removed on the computer. Pair it again to continue.'
            : 'This phone is not paired (or its pairing was removed).',
        retryAt: 0,
      });
      return;
    }

    if (!navigator.onLine) {
      this.networkLost();
      return;
    }

    if (code === closeCodes.engineUnavailable) {
      this.scheduleRetry(
        'engine-unavailable',
        reason || 'Companion is not running on the computer.',
      );
      return;
    }

    if (code === closeCodes.overloaded) {
      this.scheduleRetry('reconnecting', 'Too many phones are connected. Retrying…');
      return;
    }

    this.scheduleRetry('reconnecting', 'Connection lost. Reconnecting…');
  }

  private rejectPending(): void {
    // Replies that did not arrive have an unknown outcome. Never resend.
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new UncertainOutcome(
          'The connection dropped before Companion answered. Check the result before retrying.',
        ),
      );
      this.pending.delete(id);
    }
  }

  /** Retired sockets may still deliver close/message events; identity guards ignore them. */
  private retireSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    this.rejectPending();
    socket?.close(1000, 'Reconnecting or signed out');
  }

  /** Detect half-open connections even when the browser still reports online. */
  private startHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (Date.now() - this.lastMessageAt >= 30_000) {
        this.retireSocket();
        this.scheduleRetry('reconnecting', 'Companion stopped responding. Reconnecting…');
        return;
      }
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 15_000);
  }

  private networkLost(): void {
    clearTimeout(this.retryTimer);
    this.retireSocket();
    if (this.credential) {
      this.setState({ status: 'offline', message: 'This phone is offline.', retryAt: 0 });
    }
  }

  private scheduleRetry(status: ConnectionStatus, message: string): void {
    this.attempt += 1;

    // 1, 2, 4, 8, 15, 15… seconds, with jitter so phones do not synchronize.
    const base = Math.min(15_000, 1000 * 2 ** (this.attempt - 1));
    const delay = base * (0.8 + Math.random() * 0.4);
    const retryAt = Date.now() + delay;

    this.setState({ status, message, retryAt });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  /** Try immediately (user tap, network back, app foregrounded). */
  connectNow(): void {
    if (!this.credential || this.stopped) {
      return;
    }
    // Browsers can retain OPEN on a suspended, dead connection. A foreground
    // or network transition deliberately obtains a fresh snapshot and selection.
    // Pending mutations become uncertain and are never resent.
    this.retireSocket();
    this.open();
  }
}
