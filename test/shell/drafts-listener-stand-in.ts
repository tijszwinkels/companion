/**
 * A stand-in gateway and listener for the listener-draft tables
 * (listener-drafts.test.ts), so the real phone Store and Connection can be
 * driven in Node through every ordering a table row needs.
 *
 * It answers as the gateway and listener do for one paired device
 * (src/remote/README.md, "Drafts"; src/desktop/README.md, "Text-box
 * drafts"):
 *
 * - a connection that authenticated with `drafts: true` becomes a draft host
 *   at its first `panel-state`, receives `draft-snapshot` before that
 *   report's answer, then every accepted change (`draft`), with `editId`
 *   only on the connection that wrote it;
 * - `draft-set` applies the text (the last edit received wins) and answers
 *   `{accepted: true, sequence}` after its change; a connection without
 *   drafts is refused, and so are `pendingSend` fields;
 * - an accepted `send-agent` from a draft host clears the draft if it still
 *   equals the sent text;
 * - an agent proposal is a `conflict` while any host reports `pendingSend`
 *   for that conversation or its draft is not empty.
 *
 * `supportsDrafts: false` plays an older gateway: the `drafts` field is
 * ignored and nothing about drafts is ever sent. Requests can be held and
 * released in order, refused, or lost with the connection.
 *
 * Browser stand-ins (window, document, storage, WebSocket) are installed by
 * `installBrowser()` before the Store is imported.
 */

import type { AgentSession } from '../../src/agents/types.ts';

type Frame = Record<string, any>;

/** This browser's localStorage, shared by every Store (tabs of one browser). */
export const storage = new Map<string, string>();

/** The listener the next socket connects to. */
let currentListener: StandInListener | undefined;

/** Install the browser objects the Store and Connection touch. */
export function installBrowser(): void {
  Object.assign(globalThis, {
    window: {
      addEventListener() {},
      removeEventListener() {},
      location: { origin: 'http://127.0.0.1:1' },
      history: {
        state: null as unknown,
        replaceState(state: unknown) {
          this.state = state;
        },
        pushState(state: unknown) {
          this.state = state;
        },
      },
    },
    document: {
      addEventListener() {},
      visibilityState: 'visible',
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    WebSocket: StandInSocket,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true,
    writable: true,
  });
}

/** A paired device, as the Connection stores it. */
export function pairDevice(): void {
  storage.clear();
  storage.set(
    'companion.remote.device',
    JSON.stringify({ token: 'token', deviceId: 'device', deviceName: 'Test', server: '' }),
  );
}

/** Let every queued socket message and answer run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The page's WebSocket: frames go to the stand-in listener, its messages come back. */
export class StandInSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = StandInSocket.CONNECTING;
  private readonly handlers = new Map<string, ((event: any) => void)[]>();
  private readonly link: Link;

  constructor(readonly url: string) {
    if (!currentListener) {
      throw Error('No stand-in listener');
    }
    this.link = currentListener.attach(this);
    // The connection opens on the next turn, as a real one does.
    setImmediate(() => {
      if (this.readyState === StandInSocket.CONNECTING) {
        this.readyState = StandInSocket.OPEN;
        this.fire('open', {});
      }
    });
  }

  addEventListener(type: string, handler: (event: any) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    setImmediate(() => this.link.received(frame));
  }

  /** Closed by the page. */
  close(): void {
    this.readyState = StandInSocket.CLOSED;
    this.link.closed = true;
  }

  /** Lost from the other side (the gateway restarted, the network went). */
  drop(): void {
    if (this.readyState === StandInSocket.CLOSED) {
      return;
    }
    this.readyState = StandInSocket.CLOSED;
    this.link.closed = true;
    this.fire('close', { code: 1006, reason: '' });
  }

  /** Deliver one gateway message to the page. */
  deliver(message: unknown): void {
    if (this.readyState !== StandInSocket.OPEN) {
      return;
    }
    this.fire('message', { data: JSON.stringify(message) });
  }

  private fire(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }
}

/** One page connection as the listener sees it. */
export class Link {
  /** The page asked for drafts in `auth`. */
  askedForDrafts = false;
  /** The listener made it a draft host (first `panel-state`). */
  host = false;
  /** Its latest `pendingSend`. */
  pendingSend = '';
  closed = false;
  /** Every request frame the page sent, in order. */
  readonly requests: Frame[] = [];

  constructor(
    private readonly listener: StandInListener,
    readonly socket: StandInSocket,
  ) {}

  received(frame: Frame): void {
    if (this.closed) {
      return;
    }
    if (frame.type === 'auth') {
      this.askedForDrafts = frame.drafts === true && this.listener.supportsDrafts;
      this.socket.deliver({ type: 'authenticated', deviceId: 'device', deviceName: 'Test' });
      this.socket.deliver({ type: 'engine', message: this.listener.state() });
      return;
    }
    if (frame.type !== 'request') {
      return;
    }
    this.requests.push(frame);
    this.listener.request(this, frame);
  }

  answer(frame: Frame, result: unknown): void {
    this.socket.deliver({
      type: 'result',
      requestId: frame.requestId,
      action: frame.action,
      result,
    });
  }

  refuse(frame: Frame, message: string): void {
    this.socket.deliver({
      type: 'error',
      requestId: frame.requestId,
      action: frame.action,
      message,
    });
  }

  /** The `draft-set` frames this connection sent. */
  draftSets(): Frame[] {
    return this.requests.filter((frame) => frame.action === 'draft-set');
  }

  /** The `panel-state` frames this connection sent. */
  reports(): Frame[] {
    return this.requests.filter((frame) => frame.action === 'panel-state');
  }
}

export interface ListenerDraft {
  text: string;
  source: string;
  sequence: number;
}

export class StandInListener {
  /** False: an older gateway, which ignores `drafts` and never sends draft events. */
  supportsDrafts = true;
  readonly drafts = new Map<string, ListenerDraft>();
  sequence = 0;
  readonly links: Link[] = [];
  sessions: AgentSession[];
  /** While true, requests wait in `held` until `release()`. */
  holding = false;
  /** Actions whose requests always wait in `held` until `release()`. */
  readonly holdActions = new Set<string>();
  private held: { link: Link; frame: Frame }[] = [];
  /** A reason to refuse every `draft-set` with (as a refused result), or ''. */
  refuseEdits = '';

  constructor(sessionIds: string[]) {
    this.sessions = sessionIds.map((id) => session(id));
    currentListener = this;
  }

  /** New sockets connect to this listener (a gateway restart may change it). */
  use(): void {
    currentListener = this;
  }

  attach(socket: StandInSocket): Link {
    const link = new Link(this, socket);
    this.links.push(link);
    return link;
  }

  /** The newest connection (of the page whose Store opened it last). */
  latest(): Link {
    return this.links[this.links.length - 1];
  }

  state(): Frame {
    return {
      type: 'state',
      protocol: 1,
      ready: true,
      paused: false,
      pauseReason: '',
      soundsEnabled: false,
      processing: 0,
      preview: false,
      history: [],
      activitySessionId: 'run',
      activityHistoryCount: 0,
      sessions: this.sessions,
      sessionOrderRevision: 'revision',
      sessionControlsAvailable: true,
      previousSessions: [],
      intents: [],
    };
  }

  request(link: Link, frame: Frame): void {
    if (this.holding || this.holdActions.has(frame.action)) {
      this.held.push({ link, frame });
      return;
    }
    this.handle(link, frame);
  }

  /** Answer the held requests, in the order they arrived. */
  release(): void {
    this.holding = false;
    this.holdActions.clear();
    const held = this.held;
    this.held = [];
    for (const { link, frame } of held) {
      this.handle(link, frame);
    }
  }

  /** Answer only the first held request; later ones keep waiting. */
  releaseNext(): void {
    const next = this.held.shift();
    if (next) {
      this.handle(next.link, next.frame);
    }
  }

  /** Answer the first held request that `matches`; the others keep waiting. */
  releaseMatching(matches: (frame: Frame) => boolean): void {
    const index = this.held.findIndex(({ frame }) => matches(frame));
    if (index >= 0) {
      const [next] = this.held.splice(index, 1);
      this.handle(next.link, next.frame);
    }
  }

  /** Forget held requests: they are lost with their connection. */
  dropHeld(): void {
    this.held = [];
  }

  private handle(link: Link, frame: Frame): void {
    if (link.closed) {
      return;
    }
    switch (frame.action) {
      case 'panel-state':
        this.panelState(link, frame);
        return;
      case 'draft-set':
        this.draftSet(link, frame);
        return;
      case 'send-agent':
        this.sendAgent(link, frame);
        return;
      default:
        link.answer(frame, {});
    }
  }

  private panelState(link: Link, frame: Frame): void {
    const draftsAllowed = link.askedForDrafts;
    if (!draftsAllowed && frame.pendingSend !== undefined) {
      link.refuse(frame, 'Unknown field pendingSend');
      return;
    }
    if (draftsAllowed && !link.host) {
      link.host = true;
      const drafts = [...this.drafts].map(([id, draft]) => ({ id, ...draft }));
      link.socket.deliver({
        type: 'engine',
        message: { type: 'draft-snapshot', sequence: this.sequence, drafts },
      });
    }
    link.pendingSend = typeof frame.pendingSend === 'string' ? frame.pendingSend : '';
    link.answer(frame, 'panel-recorded');
  }

  private draftSet(link: Link, frame: Frame): void {
    if (!link.host) {
      link.refuse(frame, 'This action is not available remotely');
      return;
    }
    if (this.refuseEdits) {
      link.answer(frame, { accepted: false, reason: this.refuseEdits });
      return;
    }
    this.apply(frame.id, frame.text, '', link, frame.editId);
    link.answer(frame, { accepted: true, sequence: this.sequence });
  }

  private sendAgent(link: Link, frame: Frame): void {
    link.answer(frame, { queued: false });
    // Clear-if-equal, only for a draft host's send.
    const draft = this.drafts.get(frame.id);
    if (link.host && draft && draft.text === frame.text) {
      this.apply(frame.id, '', '');
    }
  }

  /** Apply one change and tell every draft host (`editId` only to its writer). */
  apply(id: string, text: string, source: string, writer?: Link, editId?: string): void {
    this.sequence++;
    if (text) {
      this.drafts.set(id, { text, source, sequence: this.sequence });
    } else {
      this.drafts.delete(id);
    }
    for (const link of this.links) {
      if (!link.host || link.closed) {
        continue;
      }
      const change: Frame = { type: 'draft', id, text, source, sequence: this.sequence };
      if (link === writer && editId) {
        change.editId = editId;
      }
      link.socket.deliver({ type: 'engine', message: change });
    }
  }

  /** The desktop (another editor) writes a draft. */
  desktopEdit(id: string, text: string): void {
    this.apply(id, text, '');
  }

  /** An agent proposes a draft (inserted into an empty draft only). */
  propose(id: string, text: string, source: string): 'inserted' | 'conflict' | 'offline' {
    const hosts = this.links.filter((link) => link.host && !link.closed);
    if (hosts.length === 0) {
      return 'offline';
    }
    if (hosts.some((link) => link.pendingSend === id)) {
      return 'conflict';
    }
    if (this.drafts.has(id)) {
      return 'conflict';
    }
    this.apply(id, text, source);
    return 'inserted';
  }

  /** The listener's draft text ('' for none). */
  text(id: string): string {
    return this.drafts.get(id)?.text ?? '';
  }
}

function session(id: string): AgentSession {
  return {
    id,
    title: `Conversation ${id}`,
    status: 'completed',
    model: 'synthetic',
    error: '',
    messages: [],
    updatedAt: 0,
  } as AgentSession;
}
