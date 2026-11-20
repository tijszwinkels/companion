import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

import { PauseControl } from '../../src/core/pause-control.ts';
import { CaptureStoragePolicy } from '../../src/capture-storage/policy.ts';
import { DesktopRuntime } from '../../src/desktop/runtime.ts';
import { frame, signal } from '../helpers.ts';
import { remoteFixture, waitFor, type PhoneClient } from '../remote-fixture.ts';

/**
 * Remote draft hosts, as one table derived from the rules in
 * src/remote/README.md ("Drafts") and src/desktop/README.md ("Text-box
 * drafts", "Agent drafts", "Remote panels"):
 *
 * 1. A client opts in with `drafts: true` in `auth`; the gateway then adds
 *    `draftHost: true` to that connection's panel reports. Without it nothing
 *    changes: `draft-set` is "not available remotely", `pendingSend` and
 *    `draftHost` are unknown fields, and no draft event arrives.
 * 2. A draft host reads every draft once (`draft-snapshot`) at its first
 *    report, then every accepted change (`draft`); `editId` only on its own.
 * 3. A draft host writes with `draft-set` (≤ 16,000 units, known conversation,
 *    open or saved). The last edit received wins, from any connection.
 * 4. An agent's proposal reaches every draft host with the desktop's label;
 *    any draft host, desktop or remote, makes it stored rather than offline.
 *    `focus` moves only a desktop panel.
 * 5. `pendingSend` from a remote draft host blocks proposals for that
 *    conversation, as on the desktop.
 * 6. A send from a draft host (desktop or remote) clears an equal draft; a
 *    send from a remote connection that did not opt in leaves it.
 * 7. Drafts live in listener memory: they survive closing and reopening a
 *    conversation and connections coming back (fresh snapshot), and a
 *    listener restart loses them.
 *
 * Who edits × what happens → what each connection sees and what is refused.
 * Everything runs against a real listener control socket, the real gateway
 * and a synthetic agent backend in temporary directories.
 */

type Message = Record<string, any>;

/** `desktop`: a desktop editor; `H…`: remote draft hosts; `P…`: remote, not opted in. */
type ActorName = 'desktop' | 'H1' | 'H2' | 'P1';

/** Conversations of a case, by letter. */
type Conversation = 'A' | 'B';

type Step =
  /** A draft-set from `by`; `refused` is a pattern of the refusal message. */
  | { edit: ActorName; on: Conversation; text: string; refused?: RegExp }
  /** What `actor` shows for the conversation: its latest draft text and source. */
  | { sees: ActorName; on: Conversation; text: string; source?: string }
  /** `actor` never received any draft event or snapshot. */
  | { seesNoDrafts: ActorName }
  /** An agent's proposal; `external` sets an external (unverified) source. */
  | {
      propose: Conversation;
      text: string;
      from: 'agent' | 'external';
      focus?: boolean;
      outcome: 'inserted' | 'appended' | 'conflict' | 'offline';
    }
  /** Which connections received `agent-draft-focus` for the conversation. */
  | { focusedOnly: ActorName[]; on: Conversation }
  /** A panel report naming a send that waits for its reply ('' for none). */
  | { pendingSend: ActorName; on: Conversation | '' }
  /** A panel report with a field the client must not send; refused. */
  | { reportField: ActorName; field: string; value: unknown; refused: RegExp }
  /** An accepted send-agent from `by`. */
  | { send: ActorName; on: Conversation; text: string }
  /** Close or reopen a conversation (desktop request). */
  | { close: Conversation }
  | { reopen: Conversation }
  /** A remote connection goes away / comes back as a new connection. */
  | { disconnect: ActorName }
  | { reconnect: ActorName }
  /** The listener stops and a new one starts on the same socket. */
  | { restartListener: true };

interface Case {
  rule: string;
  /** Connections opened before the steps; `desktop` is always a draft host. */
  actors: ActorName[];
  steps: Step[];
}

const cases: Case[] = [
  // ---- Who edits -----------------------------------------------------------
  {
    rule: 'a remote draft host edits; the desktop and the writer see it',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'H1', on: 'A', text: 'typed on the phone' },
      { sees: 'desktop', on: 'A', text: 'typed on the phone' },
      { sees: 'H1', on: 'A', text: 'typed on the phone' },
    ],
  },
  {
    rule: 'the desktop edits; a remote draft host sees it',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'desktop', on: 'A', text: 'typed at the desk' },
      { sees: 'H1', on: 'A', text: 'typed at the desk' },
    ],
  },
  {
    rule: 'a remote connection that did not opt in can neither edit nor see drafts',
    actors: ['desktop', 'P1'],
    steps: [
      { edit: 'desktop', on: 'A', text: 'private draft' },
      { edit: 'P1', on: 'A', text: 'nope', refused: /^This action is not available remotely$/ },
      { pendingSend: 'P1', on: 'A' },
      { reportField: 'P1', field: 'draftHost', value: true, refused: /^Unknown field: draftHost$/ },
      { sees: 'desktop', on: 'A', text: 'private draft' },
      { seesNoDrafts: 'P1' },
    ],
  },
  {
    rule: 'a draft host cannot declare draftHost itself (the gateway adds it)',
    actors: ['H1'],
    steps: [
      {
        reportField: 'H1',
        field: 'draftHost',
        value: false,
        refused: /^Unknown field: draftHost$/,
      },
      { edit: 'H1', on: 'A', text: 'still a host' },
      { sees: 'H1', on: 'A', text: 'still a host' },
    ],
  },
  {
    rule: 'two remote draft hosts: each sees the other; the last edit received wins',
    actors: ['H1', 'H2'],
    steps: [
      { edit: 'H1', on: 'A', text: 'first' },
      { edit: 'H2', on: 'A', text: 'second' },
      { sees: 'H1', on: 'A', text: 'second' },
      { sees: 'H2', on: 'A', text: 'second' },
      { edit: 'H1', on: 'A', text: 'third' },
      { sees: 'H2', on: 'A', text: 'third' },
    ],
  },
  // ---- Edit while another edits ---------------------------------------------
  {
    rule: 'desktop and remote edit in turn: the last received wins everywhere',
    actors: ['desktop', 'H1', 'H2'],
    steps: [
      { edit: 'desktop', on: 'A', text: 'desk 1' },
      { edit: 'H1', on: 'A', text: 'phone 1' },
      { edit: 'desktop', on: 'A', text: 'desk 2' },
      { sees: 'desktop', on: 'A', text: 'desk 2' },
      { sees: 'H1', on: 'A', text: 'desk 2' },
      { sees: 'H2', on: 'A', text: 'desk 2' },
    ],
  },
  {
    rule: 'edits of different conversations do not interfere',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'desktop', on: 'A', text: 'about A' },
      { edit: 'H1', on: 'B', text: 'about B' },
      { sees: 'H1', on: 'A', text: 'about A' },
      { sees: 'desktop', on: 'B', text: 'about B' },
    ],
  },
  {
    rule: 'a draft over 16,000 units is refused and changes nothing',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'H1', on: 'A', text: 'kept' },
      {
        edit: 'H1',
        on: 'A',
        text: 'x'.repeat(16_001),
        refused: /^Invalid or missing field: text$/,
      },
      { edit: 'H1', on: 'A', text: 'y'.repeat(16_000) },
      { sees: 'desktop', on: 'A', text: 'y'.repeat(16_000) },
    ],
  },
  // ---- Agent proposals ------------------------------------------------------
  {
    rule: 'a proposal reaches a remote draft host with the desktop label',
    actors: ['desktop', 'H1'],
    steps: [
      { propose: 'A', text: 'from an agent', from: 'agent', outcome: 'inserted' },
      { sees: 'H1', on: 'A', text: 'from an agent', source: 'Planner' },
      { sees: 'desktop', on: 'A', text: 'from an agent', source: 'Planner' },
      { propose: 'B', text: 'from outside', from: 'external', outcome: 'inserted' },
      { sees: 'H1', on: 'B', text: 'from outside', source: 'external (unverified) · Rowan' },
    ],
  },
  {
    rule: 'with only a remote draft host the proposal is stored, not offline',
    actors: ['H1'],
    steps: [
      { propose: 'A', text: 'for the phone', from: 'agent', outcome: 'inserted', focus: true },
      { sees: 'H1', on: 'A', text: 'for the phone', source: 'Planner' },
      { focusedOnly: [], on: 'A' },
    ],
  },
  {
    rule: 'with only a remote connection that did not opt in the proposal is offline',
    actors: ['P1'],
    steps: [
      { propose: 'A', text: 'nobody', from: 'agent', outcome: 'offline' },
      { seesNoDrafts: 'P1' },
    ],
  },
  {
    rule: 'focus moves only the desktop, even when a remote host reported last',
    actors: ['desktop', 'H1'],
    steps: [
      { pendingSend: 'H1', on: '' },
      { propose: 'A', text: 'look here', from: 'agent', outcome: 'inserted', focus: true },
      { focusedOnly: ['desktop'], on: 'A' },
    ],
  },
  {
    rule: "a proposal never replaces a remote host's text",
    actors: ['H1'],
    steps: [
      { edit: 'H1', on: 'A', text: 'mine' },
      { propose: 'A', text: 'agent idea', from: 'agent', outcome: 'conflict' },
      { sees: 'H1', on: 'A', text: 'mine', source: '' },
    ],
  },
  {
    rule: "a remote host's pendingSend blocks proposals for that conversation only",
    actors: ['desktop', 'H1'],
    steps: [
      { pendingSend: 'H1', on: 'A' },
      { propose: 'A', text: 'blocked', from: 'agent', outcome: 'conflict' },
      { propose: 'B', text: 'elsewhere', from: 'agent', outcome: 'inserted' },
      { pendingSend: 'H1', on: '' },
      { propose: 'A', text: 'now allowed', from: 'agent', outcome: 'inserted' },
      { sees: 'desktop', on: 'A', text: 'now allowed' },
    ],
  },
  {
    rule: "a disconnected remote host's pendingSend no longer blocks",
    actors: ['desktop', 'H1'],
    steps: [
      { pendingSend: 'H1', on: 'A' },
      { disconnect: 'H1' },
      { propose: 'A', text: 'after it left', from: 'agent', outcome: 'inserted' },
    ],
  },
  // ---- Send from each kind of connection ------------------------------------
  {
    rule: 'a send from a remote draft host clears the equal draft everywhere',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'H1', on: 'A', text: 'send me' },
      { send: 'H1', on: 'A', text: 'send me' },
      { sees: 'desktop', on: 'A', text: '' },
      { sees: 'H1', on: 'A', text: '' },
    ],
  },
  {
    rule: 'a send from a remote draft host keeps a draft that differs',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'desktop', on: 'A', text: 'typed since' },
      { send: 'H1', on: 'A', text: 'something else' },
      { sees: 'H1', on: 'A', text: 'typed since' },
    ],
  },
  {
    rule: 'a send from the desktop clears the equal draft for remote hosts too',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'H1', on: 'A', text: 'from the phone' },
      { send: 'desktop', on: 'A', text: 'from the phone' },
      { sees: 'H1', on: 'A', text: '' },
    ],
  },
  {
    rule: 'a send from a remote connection that did not opt in leaves the draft',
    actors: ['desktop', 'P1'],
    steps: [
      { edit: 'desktop', on: 'A', text: 'same words' },
      { send: 'P1', on: 'A', text: 'same words' },
      { sees: 'desktop', on: 'A', text: 'same words' },
    ],
  },
  // ---- Closed and reopened, lost and back, restart ---------------------------
  {
    rule: 'a draft survives closing and reopening; a saved conversation can be edited',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'H1', on: 'A', text: 'before closing' },
      { close: 'A' },
      { sees: 'H1', on: 'A', text: 'before closing' },
      { edit: 'H1', on: 'A', text: 'while saved' },
      { sees: 'desktop', on: 'A', text: 'while saved' },
      { reopen: 'A' },
      { sees: 'H1', on: 'A', text: 'while saved' },
    ],
  },
  {
    rule: 'a reconnecting remote host reads what changed while it was away',
    actors: ['desktop', 'H1'],
    steps: [
      { edit: 'H1', on: 'A', text: 'before leaving' },
      { disconnect: 'H1' },
      { edit: 'desktop', on: 'A', text: 'changed meanwhile' },
      { edit: 'desktop', on: 'B', text: 'new meanwhile' },
      { reconnect: 'H1' },
      { sees: 'H1', on: 'A', text: 'changed meanwhile' },
      { sees: 'H1', on: 'B', text: 'new meanwhile' },
    ],
  },
  {
    rule: 'a listener restart loses drafts; a reconnecting host starts empty',
    actors: ['H1'],
    steps: [
      { edit: 'H1', on: 'A', text: 'only in memory' },
      { restartListener: true },
      { reconnect: 'H1' },
      { sees: 'H1', on: 'A', text: '' },
      { edit: 'H1', on: 'A', text: 'after the restart' },
      { sees: 'H1', on: 'A', text: 'after the restart' },
    ],
  },
];

/** One connection taking part in a case, and what it has received. */
interface Actor {
  name: ActorName;
  /** Send a request and wait for its result or error. */
  request(action: string, fields: Record<string, unknown>): Promise<Message>;
  /** Draft events and snapshots this connection received, in order. */
  draftEvents(): Message[];
  /** Every other event it received, by type. */
  events(type: string): Message[];
  /** Remote connections: how the gateway closed it. */
  closed?: Promise<{ code: number; reason: string }>;
  close(): void;
}

/** A desktop editor on the control socket, declared a draft host. */
async function desktopEditor(socketPath: string): Promise<Actor> {
  const socket: Socket = createConnection(socketPath);
  const messages: Message[] = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  await once(socket, 'connect');

  let nextId = 0;
  const actor: Actor = {
    name: 'desktop',
    async request(action, fields) {
      const requestId = `d${++nextId}`;
      socket.write(JSON.stringify({ action, requestId, ...fields }) + '\n');
      const matches = (message: Message) =>
        message.requestId === requestId && ['result', 'error'].includes(message.type);
      await waitFor(() => messages.some(matches), 3000);
      return messages.find(matches)!;
    },
    draftEvents() {
      return messages.filter((message) => ['draft', 'draft-snapshot'].includes(message.type));
    },
    events(type) {
      return messages.filter((message) => message.type === type);
    },
    close() {
      socket.destroy();
    },
  };

  const reported = await actor.request('panel-state', {
    id: '',
    composerFocused: false,
    draftHost: true,
  });
  assert.equal(reported.result, 'panel-recorded');
  return actor;
}

/** A remote connection through the gateway; `drafts` opts in. */
async function remoteClient(name: ActorName, client: PhoneClient): Promise<Actor> {
  await waitFor(() => client.messages.some((message) => message.type === 'authenticated'), 3000);
  let nextId = 0;
  const engine = () =>
    client.messages
      .filter((message) => message.type === 'engine')
      .map((message) => (message as { message: Message }).message);

  const actor: Actor = {
    name,
    async request(action, fields) {
      const requestId = `${name}-${++nextId}`;
      client.send({ requestId, action, ...fields });
      return (await client.reply(requestId)) as Message;
    },
    draftEvents() {
      return engine().filter((message) => ['draft', 'draft-snapshot'].includes(message.type));
    },
    events(type) {
      return engine().filter((message) => message.type === type);
    },
    closed: client.closed,
    close() {
      client.socket.terminate();
    },
  };

  // Every client reports its page first, as the phone does on connect.
  const reported = await actor.request('panel-state', { id: '', visible: true });
  assert.equal(reported.result, 'panel-recorded');
  return actor;
}

/** What a connection shows for a conversation: snapshot, then changes in order. */
function shownDraft(actor: Actor, sessionId: string): { text: string; source: string } {
  let shown = { text: '', source: '' };
  for (const event of actor.draftEvents()) {
    if (event.type === 'draft-snapshot') {
      const entry = event.drafts.find((draft: Message) => draft.id === sessionId);
      shown = entry ? { text: entry.text, source: entry.source } : { text: '', source: '' };
    } else if (event.id === sessionId) {
      shown = { text: event.text, source: event.source };
    }
  }
  return shown;
}

for (const { rule, actors: names, steps } of cases) {
  test(`drafts: ${rule}`, async (context) => {
    const fixture = await remoteFixture({ backend: async () => {} });
    const restarted: DesktopRuntime[] = [];
    context.after(async () => {
      for (const runtime of restarted) {
        await runtime.close();
      }
      await fixture.close();
    });

    const conversations: Record<Conversation, string> = {
      A: fixture.sessions.start({ ...frame, utterance: 'Conversation A' }, signal()),
      B: fixture.sessions.start({ ...frame, utterance: 'Conversation B' }, signal()),
    };
    await fixture.sessions.idle();

    // Both remote hosts and the plain connection share one paired device.
    const { token } = await fixture.pair();
    const actors = new Map<ActorName, Actor>();
    const connect = async (name: ActorName): Promise<Actor> => {
      if (name === 'desktop') {
        return desktopEditor(fixture.desktop.socketPath);
      }
      const drafts = name.startsWith('H');
      const client = await fixture.phone(token, fixture.origin, false, drafts ? { drafts } : {});
      const remote = await remoteClient(name, client);
      // A draft host reads every draft once, at its first report.
      if (drafts) {
        await waitFor(() => remote.draftEvents().some((event) => event.type === 'draft-snapshot'));
      }
      return remote;
    };
    for (const name of names) {
      actors.set(name, await connect(name));
    }
    const actor = (name: ActorName) => {
      const found = actors.get(name);
      assert.ok(found, `${name} is connected`);
      return found;
    };
    // The desktop runs `close-agent` and `reopen-agent` on its own socket.
    let control = actors.get('desktop');

    for (const [index, step] of steps.entries()) {
      const where = `step ${index + 1} ${JSON.stringify(step).slice(0, 120)}`;

      if ('edit' in step) {
        const answer = await actor(step.edit).request('draft-set', {
          id: conversations[step.on],
          text: step.text,
          editId: `edit-${index}`,
        });
        if (step.refused) {
          assert.equal(answer.type, 'error', where);
          assert.match(String(answer.message), step.refused, where);
        } else {
          assert.equal(answer.type, 'result', where);
          assert.equal(answer.result.accepted, true, where);
          // The writer recognises its own edit by its edit ID.
          await waitFor(() =>
            actor(step.edit)
              .draftEvents()
              .some((event) => event.type === 'draft' && event.editId === `edit-${index}`),
          );
        }
      } else if ('sees' in step) {
        const sessionId = conversations[step.on];
        await waitFor(() => shownDraft(actor(step.sees), sessionId).text === step.text, 3000).catch(
          () => {},
        );
        const shown = shownDraft(actor(step.sees), sessionId);
        assert.equal(shown.text, step.text, where);
        if (step.source !== undefined) {
          assert.equal(shown.source, step.source, where);
        }
      } else if ('seesNoDrafts' in step) {
        // Give any wrongly relayed event time to arrive.
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(actor(step.seesNoDrafts).draftEvents(), [], where);
      } else if ('propose' in step) {
        const origin =
          step.from === 'external'
            ? { kind: 'external', title: 'Rowan', requestId: 'abcdefgh_12345678', depth: 1 }
            : { kind: 'agent', sessionId: conversations.B, title: 'Planner', depth: 1 };
        // The tool service's entry point for `companion_session_draft`.
        const outcome = await (fixture.sessions as any).draftFromAgent(
          {
            id: conversations[step.propose],
            text: step.text,
            ifDraftExists: 'reject',
            focus: step.focus === true,
            origin,
          },
          signal(),
        );
        assert.equal(outcome.outcome, step.outcome, where);
      } else if ('focusedOnly' in step) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const sessionId = conversations[step.on];
        const focused = [...actors.values()]
          .filter((each) =>
            each.events('agent-draft-focus').some((event) => event.id === sessionId),
          )
          .map((each) => each.name);
        assert.deepEqual(focused, step.focusedOnly, where);
      } else if ('pendingSend' in step) {
        const name = step.pendingSend;
        const pendingSend = step.on === '' ? '' : conversations[step.on];
        const fields =
          name === 'desktop'
            ? { id: '', composerFocused: false, draftHost: true, pendingSend }
            : { id: '', visible: true, pendingSend };
        const answer = await actor(name).request('panel-state', fields);
        if (name.startsWith('P')) {
          assert.equal(answer.type, 'error', where);
          assert.equal(answer.message, 'Unknown field: pendingSend', where);
        } else {
          assert.equal(answer.result, 'panel-recorded', where);
        }
      } else if ('reportField' in step) {
        const answer = await actor(step.reportField).request('panel-state', {
          id: '',
          visible: true,
          [step.field]: step.value,
        });
        assert.equal(answer.type, 'error', where);
        assert.match(String(answer.message), step.refused, where);
      } else if ('send' in step) {
        const answer = await actor(step.send).request('send-agent', {
          id: conversations[step.on],
          text: step.text,
        });
        assert.equal(answer.result, 'submitted', where);
        // A draft change caused by the send would be published before the
        // reply; leave time for it to reach the other connections.
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else if ('close' in step || 'reopen' in step) {
        if (!control) {
          control = await desktopEditor(fixture.desktop.socketPath);
          actors.set('desktop', control);
        }
        const action = 'close' in step ? 'close-agent' : 'reopen-agent';
        const id = conversations['close' in step ? step.close : step.reopen];
        const answer = await control.request(action, { id });
        assert.equal(answer.type, 'result', where);
        await fixture.sessions.idle();
      } else if ('disconnect' in step) {
        actor(step.disconnect).close();
        actors.delete(step.disconnect);
        // The listener forgets the connection once the gateway's relay closed.
        await new Promise((resolve) => setTimeout(resolve, 200));
      } else if ('reconnect' in step) {
        actors.get(step.reconnect)?.close();
        actors.set(step.reconnect, await connect(step.reconnect));
      } else if ('restartListener' in step) {
        // Stop the listener, keep the agent sessions (the conversations
        // stay known), and start a new listener on the same socket.
        const old = fixture.desktop.runtime;
        fixture.desktop.controller.abort();
        await old.close();
        // The fixture closes its own runtime later; it is already closed.
        old.close = async () => {};
        const controller = new AbortController();
        const runtime = new DesktopRuntime(
          new PauseControl(),
          () => {},
          controller.signal,
          {
            database: join(fixture.desktop.directory, 'utterances.sqlite'),
            socket: fixture.desktop.socketPath,
            preview: false,
            sounds: false,
            agents: fixture.sessions,
            captureStorage: CaptureStoragePolicy.enabledForTesting(),
          },
          async () => assert.fail('No desktop commands'),
        );
        await runtime.start();
        restarted.push(runtime);
        // Every relay of the old listener was closed: engine unavailable.
        for (const each of actors.values()) {
          if (each.closed) {
            assert.equal((await each.closed).code, 4503, where);
          }
        }
      }
    }
  });
}

test('drafts: an edit before the first panel report is refused, then accepted', async (context) => {
  const fixture = await remoteFixture({ backend: async () => {} });
  context.after(() => fixture.close());
  const id = fixture.sessions.start({ ...frame, utterance: 'Early' }, signal());
  await fixture.sessions.idle();
  const { token } = await fixture.pair();
  const client = await fixture.phone(token, fixture.origin, false, { drafts: true });
  await waitFor(() => client.messages.some((message) => message.type === 'authenticated'), 3000);

  // Not yet a draft host at the listener: the desktop-only answer, and no
  // drafts yet.
  client.send({ requestId: 'early', action: 'draft-set', id, text: 'too soon', editId: 'e1' });
  const early = (await client.reply('early')) as Message;
  assert.equal(early.type, 'error');
  assert.equal(early.message, 'Error: This action is only available on the desktop');

  client.send({ requestId: 'report', action: 'panel-state', id: '' });
  assert.equal(((await client.reply('report')) as Message).result, 'panel-recorded');
  await client.engine('draft-snapshot');
  client.send({ requestId: 'later', action: 'draft-set', id, text: 'now', editId: 'e2' });
  assert.equal(((await client.reply('later')) as Message).result.accepted, true);
});
