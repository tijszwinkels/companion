/**
 * Fixture for application chat access from a paired device
 * (src/desktop/README.md, "Application chat access from a paired device").
 *
 * Built on test/frame-fixture.ts: a real listener control socket, a real
 * widget service and a real gateway with a frame origin, all on loopback and
 * in temporary directories. It adds:
 * - two conversations: one with the synthetic `chat-notes` application, which
 *   asks to read and send chat, and one without an application;
 * - one paired device, whose phone connections are opened per case;
 * - a way to hold the application's queue (a held application action), so a
 *   permission change can be admitted and then wait while a test changes the
 *   selection or visibility, before the change runs.
 *
 * The synthetic backend keeps each conversation's first run open until a
 * test finishes it; nothing calls a model or reads personal state.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

import type { SessionApplicationDescriptor } from '../src/session-apps/types.ts';
import type { GatewayMessage } from '../src/remote/protocol.ts';
import { frameFixture, type FrameFixtureOptions } from './frame-fixture.ts';
import { deferred } from './helpers.ts';
import { waitFor, type PhoneClient, type SyntheticRun } from './remote-fixture.ts';

export type Permission = 'read' | 'send';

/** A reply as the desktop socket or the gateway delivers it. */
export interface Reply {
  type: string;
  result?: any;
  message?: string;
  duplicate?: boolean;
}

export async function consentFixture(options: FrameFixtureOptions = {}) {
  const fixture = await frameFixture(options);

  // The conversation with the application, its first run kept open so its
  // tool lease can replace the application's code later.
  const withApplication = await fixture.conversation();
  await fixture.applyNotes(withApplication.run, 0, 'chat-notes');
  const other = await fixture.conversation();

  const applicationConversation = withApplication.id;
  const otherConversation = other.id;
  const { token } = await fixture.pair('Synthetic consent device');

  // ---- Holding the application's queue ----------------------------------
  //
  // Application actions and permission changes share one queue per
  // conversation. A held `add_note` action keeps everything behind it
  // waiting until the test releases it.

  const renderer = (
    fixture.sessions as unknown as {
      widgets: { renderer: { reduce: (...args: unknown[]) => Promise<unknown> } };
    }
  ).widgets.renderer;
  const nodeReduce = renderer.reduce;
  let gate: { entered: () => void; release: Promise<void> } | undefined;
  const heldQueues = new Set<() => void>();
  renderer.reduce = async (...args: unknown[]) => {
    const current = gate;
    if (current) {
      gate = undefined;
      current.entered();
      await current.release;
    }
    return nodeReduce(...args);
  };

  /**
   * Start an application action that waits in the renderer, so later queue
   * work waits too. Returns the function that lets it (and them) finish.
   */
  async function holdApplicationQueue(): Promise<() => Promise<void>> {
    const entered = deferred<void>();
    const release = deferred<void>();
    gate = { entered: () => entered.resolve(), release: release.promise };
    // A test that fails while holding must not keep the fixture from closing.
    heldQueues.add(() => release.resolve());

    const application = listenerApplication();
    const action = fetch(application.viewUrl + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add_note',
        args: { text: 'Held' },
        version: application.version,
        requestId: 'hold-' + randomUUID(),
      }),
    });
    await entered.promise;

    return async () => {
      release.resolve();
      const response = await action;
      assert.equal(response.status, 200);
    };
  }

  // ---- The listener's own state ------------------------------------------

  /** The application descriptor as the listener holds it (desktop view). */
  function listenerApplication(): SessionApplicationDescriptor {
    const session = fixture.sessions.snapshot().find((each) => {
      return each.id === applicationConversation;
    });
    assert.ok(session?.application?.chatAccess, 'The conversation has its application');
    return session.application;
  }

  /** Whether `permission` is allowed now, according to the listener. */
  function allowedNow(permission: Permission): boolean {
    const access = listenerApplication().chatAccess!;
    if (permission === 'read') {
      return access.read;
    }
    return access.send!.allowed;
  }

  /** A permission change naming the current application, version and revision. */
  function change(
    permission: Permission,
    allowed: boolean,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const application = listenerApplication();
    return {
      action: `set-application-chat-${permission}`,
      id: applicationConversation,
      applicationId: application.id,
      version: application.version,
      revision: application.chatAccess!.revision,
      allowed,
      ...overrides,
    };
  }

  // ---- The desktop connection --------------------------------------------

  /** The desktop panel shows `id` on a visible page. */
  async function desktopShows(id: string): Promise<void> {
    fixture.desktop.send({ action: 'panel-state', id, composerFocused: false, visible: true });
    assert.equal((await fixture.desktop.reply('panel-state')).type, 'result');
  }

  /** Send a request from the desktop connection; `reply` waits for its answer. */
  function desktopSend(request: Record<string, unknown>): { reply: () => Promise<Reply> } {
    fixture.desktop.send(request);
    return {
      reply: async () => (await fixture.desktop.reply(request.action as string)) as Reply,
    };
  }

  /**
   * Make `permission` be `allowed` through the desktop (which shows the
   * application's conversation afterwards), so each case starts from a known
   * state whatever the case before it did.
   */
  async function arrange(permission: Permission, allowed: boolean): Promise<void> {
    await desktopShows(applicationConversation);
    if (allowedNow(permission) === allowed) {
      return;
    }
    const reply = await desktopSend(change(permission, allowed)).reply();
    assert.equal(reply.type, 'result', reply.message ?? '');
    assert.equal(allowedNow(permission), allowed);
  }

  // ---- Phone connections of the paired device ----------------------------

  /** A new authenticated connection of the paired device. */
  async function openPhone(): Promise<PhoneClient> {
    const phone = await fixture.phone(token);
    await waitFor(() => phone.messages.some((message) => message.type === 'authenticated'), 3000);
    return phone;
  }

  /** Send a request with a fresh request ID; `reply` waits for its answer. */
  function phoneSend(
    phone: PhoneClient,
    request: Record<string, unknown>,
    requestId = 'r' + randomUUID().replaceAll('-', ''),
  ): { requestId: string; reply: () => Promise<Reply> } {
    phone.send({ requestId, ...request });
    return {
      requestId,
      reply: async () => (await phone.reply(requestId)) as GatewayMessage as Reply,
    };
  }

  /** The phone reports its selection; `visible` is left out when undefined. */
  async function phoneReports(phone: PhoneClient, id: string, visible?: boolean): Promise<void> {
    const report: Record<string, unknown> = { action: 'panel-state', id };
    if (visible !== undefined) {
      report.visible = visible;
    }
    const reply = await phoneSend(phone, report).reply();
    assert.equal(reply.type, 'result', reply.message ?? '');
  }

  /** Close a phone connection and wait until the gateway has seen it close. */
  async function closePhone(phone: PhoneClient): Promise<void> {
    phone.socket.close();
    await phone.closed;
  }

  /**
   * The visible selections of the listener's remote connections. Read only
   * to know when the gateway's `withdraw-visibility` has been handled.
   */
  function remoteSelections(): string[] {
    const runtime = fixture.desktop.runtime as unknown as {
      remoteClients: Map<number, { selection: string }>;
    };
    return [...runtime.remoteClients.values()].map((remote) => remote.selection);
  }

  function remoteVisibleSelections(): string[] {
    const runtime = fixture.desktop.runtime as unknown as {
      remoteClients: Map<number, { visibleSelection: string }>;
    };
    return [...runtime.remoteClients.values()].map((remote) => remote.visibleSelection);
  }

  // ---- A remote connection without the gateway ---------------------------

  /**
   * A remote-role connection on the listener's control socket, as the
   * gateway opens one, for the one state a phone cannot reach while it can
   * still send: its visibility withdrawn while it stays connected.
   */
  async function remoteControlConnection() {
    const socket = createConnection(fixture.desktop.socketPath);
    const replies: (Reply & { requestId?: string })[] = [];
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const message = JSON.parse(buffered.slice(0, newline));
        if (message.type === 'result' || message.type === 'error') {
          replies.push(message);
        }
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

    async function request(fields: Record<string, unknown>): Promise<Reply> {
      const requestId = 'c' + randomUUID();
      socket.write(JSON.stringify({ ...fields, requestId }) + '\n');
      await waitFor(() => replies.some((reply) => reply.requestId === requestId), 3000);
      return replies.find((reply) => reply.requestId === requestId)!;
    }

    return {
      request,
      close: () => socket.destroy(),
    };
  }

  return {
    fixture,
    applicationConversation,
    otherConversation,
    /** The first run of the application's conversation, still open. */
    applicationRun: withApplication.run as SyntheticRun,
    otherRun: other.run as SyntheticRun,
    holdApplicationQueue,
    listenerApplication,
    allowedNow,
    change,
    desktopShows,
    desktopSend,
    arrange,
    openPhone,
    phoneSend,
    phoneReports,
    closePhone,
    remoteVisibleSelections,
    remoteSelections,
    remoteControlConnection,
    close: async () => {
      for (const release of heldQueues) {
        release();
      }
      await fixture.close();
    },
  };
}

export type ConsentFixture = Awaited<ReturnType<typeof consentFixture>>;
