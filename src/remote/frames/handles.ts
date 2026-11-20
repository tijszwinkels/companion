/**
 * Frame handles: per-device stand-ins for the listener's widget and
 * application view capabilities.
 *
 * The listener names every widget view and session application view with a
 * capability address on loopback, `http://127.0.0.1:<port>/view/<64 hex>`.
 * A browser on another machine cannot load it, and it must never learn it.
 * The relay therefore keeps that address here, in memory, and gives the
 * device `<frame origin>/f/<handle>/` instead. The frame origin
 * (./server.ts) turns a handle back into the capability and forwards a small
 * set of operations to the widget service's private Unix socket.
 *
 * Inputs:  view addresses seen by a device's relays (snapshots, events,
 *          history pages, pinned attachments), connection open/close of that
 *          device, revocation rechecks, conversation and application changes,
 *          upstream "view unknown" answers.
 * Outputs: handles for the relay to send, and handle lookups for the frame
 *          origin, each with the per-device request budget.
 *
 * Lifetime rules (src/remote/README.md, "Widget and application frames"):
 * - A handle is 256 random bits, bound to one device and one view address.
 *   The same device and address always get the same handle while it lives,
 *   so a frame does not reload when a snapshot or event repeats the view.
 * - A device's handles live while any of its connections is open and for
 *   `graceMilliseconds` after the last one closed. A reconnect within the
 *   grace period keeps them.
 * - They end at once when the device is revoked (the gateway's recheck),
 *   when the conversation closes (`agent-removed`), when the widget service
 *   says the view is unknown (upstream 404: the conversation closed or the
 *   application was removed), and when the gateway stops. Nothing is written
 *   to disk.
 * - Only ordered facts end a handle. Several relays deliver listener events
 *   at different times (an initial snapshot can wait for role negotiation),
 *   so a relay may still process an older snapshot after another relay saw
 *   a newer one. A snapshot without a view therefore never ends anything.
 *   `agent-removed` ends exactly the view capabilities that the same
 *   connection saw for that conversation before the event: those belong to
 *   the closed conversation and are dead for every device (a reopened
 *   conversation gets new random capabilities).
 *
 * Handles are bearer capabilities, like the listener's own: a frame request
 * carries no device credential (no cookie, no token). "Bound to a device"
 * means the handle is only ever sent to that device, ends with that device,
 * and its requests count against that device's budget.
 *
 * Everything here runs on the gateway's single event loop; there are no
 * concurrent mutations to guard against.
 */

import { randomBytes } from 'node:crypto';

/** Handles live this long after a device's last connection closed. */
export const graceMilliseconds = 30_000;

/**
 * Table bounds. A device can show at most 32 open conversations with 24
 * widgets and one application each (800 views), so 1024 per device is never
 * reached in normal use. At a bound no new handle is issued: the view is sent
 * without a frame address, exactly as when no frame origin is configured, and
 * existing frames keep working. Nothing is evicted, because evicting would
 * break a frame the person is looking at.
 */
export const maximumHandlesPerDevice = 1024;
export const maximumHandles = 4096;

/** Frame-origin request budget per device: 40 per second, bursts of 120. */
export const frameRequestsPerSecond = 40;
export const frameRequestBurst = 120;

/** Which kind of listener view a handle names; decides the allowed operations. */
export type FrameKind = 'widget' | 'application';

/** What a live handle resolves to. */
export interface FrameTarget {
  deviceId: string;
  conversationId: string;
  kind: FrameKind;
  /** The 64-hex view capability of the widget service, never sent to a browser. */
  capability: string;
}

/**
 * The relay's view of the table for one device connection. Each method takes
 * listener data as received (unknown types) and validates it here.
 */
export interface RelayFrames {
  /** The frame address for a widget view address, or undefined to drop it. */
  widget(conversationId: unknown, viewUrl: unknown): string | undefined;
  /** The frame address for a conversation's application view address. */
  application(conversationId: unknown, viewUrl: unknown): string | undefined;
  /**
   * The conversation closed: the views this connection saw for it end, for
   * every device.
   */
  conversationRemoved(conversationId: unknown): void;
}

/** One open device connection; `close()` once, when the phone socket closes. */
export interface FrameConnection extends RelayFrames {
  close(): void;
}

/** The only view address shape the listener produces. */
const viewAddress = /^http:\/\/127\.0\.0\.1:\d{1,5}\/view\/([0-9a-f]{64})$/;

/** Conversation IDs are UUIDs; anything else is not a conversation. */
const conversationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface HandleEntry extends FrameTarget {
  handle: string;
}

interface DeviceRecord {
  deviceId: string;
  /** Open phone connections of this device. */
  connections: Set<FrameConnection>;
  /** Started when the last connection closed; ends the record. */
  graceTimer?: ReturnType<typeof setTimeout>;
  /** Capability → handle, for reuse across snapshots and events. */
  handles: Map<string, string>;
  /** Token bucket for frame-origin requests. */
  tokens: number;
  tokensUpdatedAt: number;
}

export class FrameHandles {
  private readonly entries = new Map<string, HandleEntry>();
  private readonly devices = new Map<string, DeviceRecord>();

  /**
   * @param frameOrigin  Public origin of the frame listener, e.g.
   *                     `https://desk.example.ts.net:8444`.
   * @param now          Clock in milliseconds (tests may inject one).
   * @param grace        Grace period in milliseconds (tests may shorten it).
   */
  constructor(
    private readonly frameOrigin: string,
    private readonly now: () => number = Date.now,
    private readonly grace: number = graceMilliseconds,
  ) {}

  /** Number of live handles, for tests and limits. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Register an authenticated connection of `deviceId`. The returned object
   * issues handles for that device and must be closed when the phone's
   * socket closes. A reconnect within the grace period finds the same
   * record, and with it the same handles and the same request budget.
   */
  connect(deviceId: string): FrameConnection {
    let record = this.devices.get(deviceId);
    if (!record) {
      record = {
        deviceId,
        connections: new Set(),
        handles: new Map(),
        tokens: frameRequestBurst,
        tokensUpdatedAt: this.now(),
      };
      this.devices.set(deviceId, record);
    }
    clearTimeout(record.graceTimer);
    record.graceTimer = undefined;

    const owner = record;
    let closed = false;
    // Conversation → view capabilities this connection was given a handle
    // for, in the order of its own event stream (see the header comment).
    const seen = new Map<string, Set<string>>();
    const issueAndRemember = (conversationId: unknown, kind: FrameKind, viewUrl: unknown) => {
      const issued = this.issue(owner, conversationId, kind, viewUrl);
      if (issued) {
        const conversation = conversationId as string;
        let views = seen.get(conversation);
        if (!views) {
          views = new Set();
          seen.set(conversation, views);
        }
        views.add(capabilityOf(viewUrl)!);
      }
      return issued;
    };
    const connection: FrameConnection = {
      widget: (conversationId, viewUrl) => {
        return issueAndRemember(conversationId, 'widget', viewUrl);
      },
      application: (conversationId, viewUrl) => {
        return issueAndRemember(conversationId, 'application', viewUrl);
      },
      conversationRemoved: (conversationId) => {
        if (typeof conversationId !== 'string') {
          return;
        }
        for (const capability of seen.get(conversationId) ?? []) {
          this.viewEnded(capability);
        }
        seen.delete(conversationId);
      },
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        this.disconnect(owner, connection);
      },
    };
    record.connections.add(connection);
    return connection;
  }

  /** Resolve a handle from a frame request; undefined for any unknown or ended one. */
  lookup(handle: string): FrameTarget | undefined {
    const entry = this.entries.get(handle);
    if (!entry) {
      return undefined;
    }
    return {
      deviceId: entry.deviceId,
      conversationId: entry.conversationId,
      kind: entry.kind,
      capability: entry.capability,
    };
  }

  /**
   * Take one request from the device's budget. False when it is spent: the
   * caller answers 429 and changes nothing else (handles and connections stay).
   */
  takeRequest(deviceId: string): boolean {
    const record = this.devices.get(deviceId);
    if (!record) {
      return false;
    }

    const now = this.now();
    const refill = ((now - record.tokensUpdatedAt) / 1000) * frameRequestsPerSecond;
    record.tokens = Math.min(frameRequestBurst, record.tokens + refill);
    record.tokensUpdatedAt = now;

    if (record.tokens < 1) {
      return false;
    }
    record.tokens -= 1;
    return true;
  }

  /**
   * The widget service answered "unknown view" for this capability: it ended
   * for everyone (conversation closed, application removed). End every
   * device's handle for it.
   */
  viewEnded(capability: string): void {
    this.endWhere((entry) => entry.capability === capability);
  }

  /**
   * Revocation recheck: keep only devices in `paired`. Ends the handles of
   * every other device at once, whether it is connected or in its grace
   * period. The gateway terminates the revoked device's relays itself.
   */
  retainDevices(paired: ReadonlySet<string>): void {
    for (const deviceId of [...this.devices.keys()]) {
      if (!paired.has(deviceId)) {
        this.endDevice(deviceId);
      }
    }
  }

  /** Gateway shutdown: forget everything. */
  clear(): void {
    for (const deviceId of [...this.devices.keys()]) {
      this.endDevice(deviceId);
    }
  }

  // ---- Internals ------------------------------------------------------------

  private disconnect(record: DeviceRecord, connection: FrameConnection): void {
    // The record may already be gone (revoked) or replaced by a new one after
    // a revocation and re-pairing; only the record that owns this connection
    // counts it.
    if (this.devices.get(record.deviceId) !== record) {
      return;
    }
    record.connections.delete(connection);
    if (record.connections.size > 0) {
      return;
    }

    clearTimeout(record.graceTimer);
    record.graceTimer = setTimeout(() => {
      if (this.devices.get(record.deviceId) === record && record.connections.size === 0) {
        this.endDevice(record.deviceId);
      }
    }, this.grace);
    // The grace timer alone never keeps the gateway process alive.
    record.graceTimer.unref();
  }

  private endDevice(deviceId: string): void {
    const record = this.devices.get(deviceId);
    if (!record) {
      return;
    }
    clearTimeout(record.graceTimer);
    for (const handle of record.handles.values()) {
      this.entries.delete(handle);
    }
    record.handles.clear();
    this.devices.delete(deviceId);
  }

  /** Remove every entry matching `ended`, from both indexes. */
  private endWhere(ended: (entry: HandleEntry) => boolean): void {
    for (const entry of [...this.entries.values()]) {
      if (!ended(entry)) {
        continue;
      }
      this.entries.delete(entry.handle);
      this.devices.get(entry.deviceId)?.handles.delete(entry.capability);
    }
  }

  private issue(
    record: DeviceRecord,
    conversationId: unknown,
    kind: FrameKind,
    viewUrl: unknown,
  ): string | undefined {
    // A connection that outlived its record (revoked, then still draining)
    // must not create handles for a device that is no longer here.
    if (this.devices.get(record.deviceId) !== record) {
      return undefined;
    }
    if (typeof conversationId !== 'string' || !conversationIdPattern.test(conversationId)) {
      return undefined;
    }
    const capability = capabilityOf(viewUrl);
    if (!capability) {
      return undefined;
    }

    const existing = record.handles.get(capability);
    if (existing) {
      return this.frameUrl(existing);
    }
    if (record.handles.size >= maximumHandlesPerDevice || this.entries.size >= maximumHandles) {
      return undefined;
    }

    const handle = randomBytes(32).toString('base64url');
    this.entries.set(handle, {
      handle,
      deviceId: record.deviceId,
      conversationId,
      kind,
      capability,
    });
    record.handles.set(capability, handle);
    return this.frameUrl(handle);
  }

  private frameUrl(handle: string): string {
    return `${this.frameOrigin}/f/${handle}/`;
  }
}

/** The 64-hex capability of a listener view address, or undefined. */
function capabilityOf(viewUrl: unknown): string | undefined {
  if (typeof viewUrl !== 'string') {
    return undefined;
  }
  return viewAddress.exec(viewUrl)?.[1];
}
