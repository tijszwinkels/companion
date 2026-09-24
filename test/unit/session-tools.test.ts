import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AgentSessions } from '../../src/agents/sessions.ts';
import { PiBackend } from '../../src/agents/pi-backend.ts';
import { SessionStore } from '../../src/agents/session-store.ts';
import {
  SessionToolService,
  type SessionToolHost,
} from '../../src/agents/session-tools-service.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';
import { sessionTools } from '../../src/agents/session-tools.ts';
import {
  chatMessage,
  type AgentMessage,
  type AgentBackend,
  type AgentDraftOutcome,
  type AgentDraftRequest,
  type SessionEvent,
} from '../../src/agents/types.ts';
import { deferred, frame, signal } from '../helpers.ts';
import { waitFor } from '../desktop-fixture.ts';

/** One recorded backend invocation, including its session tool lease. */
interface RecordedRun {
  id: string;
  text: string;
  resume: boolean;
  model: string;
  screenshot: boolean;
  sessionTools?: { endpoint: string; token: string };
  emit: (message: AgentMessage) => void;
}

type TurnScript = (run: RecordedRun) => Promise<void>;

/**
 * Synthetic conversations only. A turn runs its scripted handler, which can
 * call the real Pi extension tools through the lease Companion supplied.
 */
async function fixture(context: { after(callback: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-session-tools-'));
  // Create the profile file up front; concurrent first turns must not race to
  // create it in a fresh directory.
  await writeFile(join(directory, 'companion-agent.json'), JSON.stringify(defaultAgentSettings));

  const runs: RecordedRun[] = [];
  const scripts = new Map<string, TurnScript[]>();
  const events: SessionEvent[] = [];
  const backend: AgentBackend = {
    id: 'session-tools-fixture',
    label: 'Session tools fixture',
    dependencies: {},
    async models() {
      const models = ['configured/one', 'configured/two'];
      return {
        models,
        pinned: models,
        thinkingLevels: Object.fromEntries(
          models.map((model) => [model, ['off', 'minimal', 'low', 'medium', 'high']]),
        ),
      };
    },
    async run(request, _signal, emit) {
      const run: RecordedRun = {
        id: request.id,
        text: request.prompt.text,
        resume: request.resume,
        model: request.settings.model,
        screenshot: request.prompt.screenshot !== undefined,
        sessionTools: request.sessionTools,
        emit,
      };
      runs.push(run);
      const script = scripts.get(request.id)?.shift();
      if (script) {
        await script(run);
      }
      emit(chatMessage(`answer-${runs.length}`, 'assistant', `Answer ${runs.length}`));
    },
  };
  const sessions = new AgentSessions({ backend }, () => {}, directory);
  sessions.subscribe((event) => events.push(event));
  context.after(async () => {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    directory,
    sessions,
    runs,
    events,
    /** Queue handlers for the next turns of one conversation, in order. */
    script(id: string, ...turns: TurnScript[]) {
      scripts.set(id, [...(scripts.get(id) ?? []), ...turns]);
    },
    view(id: string) {
      const view = sessions.snapshot().find((session) => session.id === id);
      assert.ok(view, `Expected open session ${id}`);
      return view;
    },
  };
}

/** Invoke a tool exactly as Pi does, with a Pi-style tool-call identity. */
async function call(
  run: RecordedRun,
  name: string,
  parameters: Record<string, unknown>,
  callId: string = randomUUID(),
): Promise<Record<string, unknown>> {
  assert.ok(run.sessionTools, 'The turn must receive a session tool lease');
  const tool = sessionTools(run.sessionTools.endpoint, run.sessionTools.token).find(
    (definition) => definition.name === name,
  );
  assert.ok(tool, `Unknown tool ${name}`);
  const result = await tool.execute(callId, parameters);
  return result.details;
}

/** Return the thrown tool error, whose message ends with its stable code. */
async function refusal(
  run: RecordedRun,
  name: string,
  parameters: Record<string, unknown>,
  callId?: string,
): Promise<string> {
  try {
    await call(run, name, parameters, callId);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail(`${name} unexpectedly succeeded`);
}

test('agent provenance points to the sender tool group when the call was retained', async (context) => {
  const { sessions, script, view, directory } = await fixture(context);
  const sender = sessions.start(frame, signal());
  const callId = randomUUID();
  let destination = '';
  let lookup: string | undefined;
  script(sender, async (run) => {
    const outbound = chatMessage(`tool-${callId}`, 'tool', '');
    outbound.toolName = 'companion_session_start';
    outbound.state = 'running';
    run.emit(outbound);
    lookup = new SessionStore(join(directory, '.companion-sessions')).tools.groupForCall(
      sender,
      callId,
    );
    const result = await call(run, 'companion_session_start', { text: 'Follow up' }, callId);
    destination = (result.session as { id: string }).id;
  });
  await sessions.idle();
  assert.ok(lookup, 'tool call must be stored before delivery');
  const origin = view(destination).messages[0].origin;
  assert.ok(origin?.sourceGroupId);
  assert.ok(view(sender).messages.some((message) => message.id === origin.sourceGroupId));
  await sessions.remove(destination);
  await sessions.reopen(destination);
  assert.equal(view(destination).messages[0].origin?.sourceGroupId, origin.sourceGroupId);
});

test('an agent starts a labelled background session that keeps its profile and model', async (context) => {
  const { sessions, runs, script, view } = await fixture(context);
  const started: Record<string, unknown>[] = [];
  const requester = sessions.start(frame, signal());
  script(requester, async (run) => {
    started.push(
      await call(run, 'companion_session_start', {
        text: 'Investigate the flaky order test',
        profile: 'quickQuestion',
        model: 'configured/two',
      }),
    );
    started.push(await call(run, 'companion_session_start', { text: 'Visible', focus: true }));
    assert.match(
      await refusal(run, 'companion_session_start', { text: 'Other', model: 'missing/model' }),
      /not available in Pi.*\[unavailable-model\]$/,
    );
  });
  await sessions.idle();

  const created = (started[0].session as { id: string }).id;
  const session = view(created);
  assert.equal(started[0].outcome, 'started');
  assert.equal(session.profile, 'quickQuestion');
  assert.equal(session.modelOverride, 'configured/two');
  assert.equal(session.openInBackground, true);
  assert.equal(view((started[1].session as { id: string }).id).openInBackground, undefined);

  // The display keeps the plain text with structured provenance; the user did
  // not write it, and it has no screenshot of the user's desktop.
  const question = session.messages[0];
  assert.equal(question.kind, 'user');
  assert.equal(question.text, 'Investigate the flaky order test');
  assert.equal(question.screenshot, false);
  assert.deepEqual(question.origin, {
    kind: 'agent',
    sessionId: requester,
    title: frame.utterance,
    depth: 1,
  });

  // Pi receives an explicit header naming the sending conversation.
  const createdRun = runs.find((run) => run.id === created)!;
  assert.equal(createdRun.resume, false);
  assert.equal(createdRun.model, 'configured/two');
  assert.equal(createdRun.screenshot, false);
  assert.match(createdRun.text, /^\[Companion agent message\] Written by the agent of another/);
  assert.ok(createdRun.text.includes(`(session ${requester}), not typed by the user`));
  assert.ok(createdRun.text.endsWith('\n\nInvestigate the flaky order test'));

  // Provenance, profile and model survive closing and reopening; the live-only
  // background flag is not archived.
  await sessions.remove(created);
  await sessions.reopen(created);
  const reopened = view(created);
  assert.deepEqual(reopened.messages[0].origin, question.origin);
  assert.equal(reopened.profile, 'quickQuestion');
  assert.equal(reopened.modelOverride, 'configured/two');
  assert.equal(reopened.openInBackground, undefined);
});

test('reopening a saved conversation keeps its identity, history and settings without focus', async (context) => {
  const { sessions, runs, events, script, view } = await fixture(context);
  const saved = sessions.start(
    { ...frame, utterance: 'Saved question' },
    signal(),
    'quickQuestion',
  );
  await sessions.idle();
  await sessions.setModel(saved, 'configured/one', signal());
  const history = view(saved).messages.map((message) => [message.id, message.kind, message.text]);
  await sessions.remove(saved);
  const runsBeforeReopen = runs.length;

  const results: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const requester = sessions.start(frame, signal());
  script(requester, async (run) => {
    const listed = await call(run, 'companion_sessions', { query: 'saved' });
    assert.deepEqual(
      (listed.previous as { id: string }[]).map((entry) => entry.id),
      [saved],
    );
    assert.equal(listed.self, requester);
    results.push(await call(run, 'companion_session_reopen', { id: saved }));
    results.push(await call(run, 'companion_session_reopen', { id: saved }));
    errors.push(await refusal(run, 'companion_session_reopen', { id: randomUUID() }));
    errors.push(await refusal(run, 'companion_session_reopen', { id: '../../etc/passwd' }));
  });
  await sessions.idle();

  assert.equal(results[0].outcome, 'reopened');
  assert.equal(results[0].messages, history.length);
  assert.equal(results[1].outcome, 'already-open');
  assert.match(errors[0], /No Companion conversation has that id.*\[unknown-session\]$/);
  assert.match(errors[1], /session UUID from companion_sessions \[invalid\]$/);

  const reopened = view(saved);
  assert.deepEqual(
    reopened.messages.map((message) => [message.id, message.kind, message.text]),
    history,
  );
  assert.equal(reopened.profile, 'quickQuestion');
  assert.equal(reopened.modelOverride, 'configured/one');
  // A client that misses agent-restored must not select it from a snapshot.
  assert.equal(reopened.openInBackground, true);
  const restored = events.find((event) => event.type === 'agent-restored');
  assert.ok(restored && restored.type === 'agent-restored');
  assert.equal(restored.reveal, false);
  // Reopening only restores the tab. It never starts a turn in that session.
  assert.equal(
    runs.slice(runsBeforeReopen).some((run) => run.id === saved),
    false,
  );
});

test('bad, saved, self and stale targets fail with explicit outcomes', async (context) => {
  const { sessions, script } = await fixture(context);
  const saved = sessions.start(frame, signal());
  await sessions.idle();
  await sessions.remove(saved);

  const errors: string[] = [];
  let lease: RecordedRun | undefined;
  const requester = sessions.start(frame, signal());
  script(requester, async (run) => {
    lease = run;
    errors.push(await refusal(run, 'companion_session_send', { id: randomUUID(), text: 'Hi' }));
    errors.push(await refusal(run, 'companion_session_send', { id: saved, text: 'Hi' }));
    errors.push(await refusal(run, 'companion_session_send', { id: requester, text: 'Hi' }));
    errors.push(await refusal(run, 'companion_session_send', { id: saved, text: '   ' }));
    errors.push(await refusal(run, 'companion_session_draft', { id: saved, text: 'Hi' }));
  });
  await sessions.idle();

  assert.match(errors[0], /\[unknown-session\]$/);
  assert.match(errors[1], /saved but not open.*companion_session_reopen first.*\[not-open\]$/);
  assert.match(errors[2], /own conversation \[self-target\]$/);
  assert.match(errors[3], /1–4000 characters \[invalid\]$/);
  assert.match(errors[4], /\[not-open\]$/);

  // The lease belonged to one turn. Reusing it afterwards is refused.
  assert.match(
    await refusal(lease!, 'companion_sessions', {}),
    /agent turn has ended.*\[expired\]$/,
  );
});

test('messages to a busy target join its FIFO queue behind earlier user messages', async (context) => {
  const { sessions, runs, script, view } = await fixture(context);
  const release = deferred<void>();
  const target = sessions.start({ ...frame, utterance: 'Long task' }, signal());
  script(target, async () => {
    await release.promise;
  });
  sessions.followUp(target, 'Human first', signal());

  let sent: Record<string, unknown> | undefined;
  const requester = sessions.start(frame, signal());
  script(requester, async (run) => {
    sent = await call(run, 'companion_session_send', { id: target, text: 'Agent second' });
  });
  // idle() would also wait for the deliberately blocked target turn.
  await waitFor(() => sent !== undefined);
  sessions.followUp(target, 'Human third', signal());

  // The agent's message waits in order; it never interrupts the running turn.
  assert.equal(sent!.outcome, 'queued');
  assert.equal(sent!.queuePosition, 2);
  assert.equal(view(target).status, 'running');
  release.resolve();
  await sessions.idle();

  const prompts = runs.filter((run) => run.id === target).map((run) => run.text);
  assert.equal(prompts.length, 4);
  assert.equal(prompts[0], 'Long task');
  assert.equal(prompts[1], 'Human first');
  assert.match(prompts[2], /^\[Companion agent message\][^]*\n\nAgent second$/);
  assert.equal(prompts[3], 'Human third');

  const labelled = view(target).messages.filter((message) => message.kind === 'user');
  assert.deepEqual(
    labelled.map((message) => [
      message.text,
      message.origin?.kind === 'agent' ? message.origin.sessionId : 'user',
    ]),
    [
      ['Long task', 'user'],
      ['Human first', 'user'],
      ['Agent second', requester],
      ['Human third', 'user'],
    ],
  );
});

test('agent-to-agent chains stop at the loop limit', async (context) => {
  const { sessions, runs, script } = await fixture(context);
  const first = sessions.start({ ...frame, utterance: 'Human request' }, signal());
  const second = sessions.start({ ...frame, utterance: 'Other human request' }, signal());
  await sessions.idle();

  let blocked = '';
  let blockedStart = '';
  // Each turn answers the other conversation, as a naive agent might do.
  script(first, async (run) => {
    await call(run, 'companion_session_send', { id: second, text: 'Ping 1' });
  });
  script(second, async (run) => {
    await call(run, 'companion_session_send', { id: first, text: 'Pong 2' });
  });
  script(first, async (run) => {
    await call(run, 'companion_session_send', { id: second, text: 'Ping 3' });
  });
  script(second, async (run) => {
    blocked = await refusal(run, 'companion_session_send', { id: first, text: 'Pong 4' });
    blockedStart = await refusal(run, 'companion_session_start', { text: 'Escape hatch' });
  });
  sessions.followUp(first, 'Please coordinate', signal());
  for (let attempt = 0; attempt < 5; attempt++) {
    await sessions.idle();
  }

  assert.match(blocked, /prevent a feedback loop.*\[loop-limit\]$/);
  assert.match(blockedStart, /\[loop-limit\]$/);
  // 2 initial turns + the human follow-up + three agent messages.
  assert.equal(runs.length, 6);
  assert.equal(sessions.snapshot().length, 2);
});

test('repeated tool calls and identical content are delivered once per turn', async (context) => {
  const { sessions, runs, script, view } = await fixture(context);
  const target = sessions.start(frame, signal());
  await sessions.idle();

  const replies: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const requester = sessions.start(frame, signal());
  script(requester, async (run) => {
    const callId = randomUUID();
    // Pi repeating one tool call gets the original reply, not a second send.
    replies.push(await call(run, 'companion_session_send', { id: target, text: 'Once' }, callId));
    replies.push(await call(run, 'companion_session_send', { id: target, text: 'Once' }, callId));
    errors.push(await refusal(run, 'companion_session_send', { id: target, text: 'Once' }));
    replies.push(await call(run, 'companion_session_send', { id: target, text: 'Different' }));
    // Remaining budget: 6 actions per turn, including refusals.
    await call(run, 'companion_session_reopen', { id: target });
    await call(run, 'companion_session_reopen', { id: target });
    await call(run, 'companion_session_reopen', { id: target });
    errors.push(await refusal(run, 'companion_session_reopen', { id: target }));
  });
  await sessions.idle();

  assert.deepEqual(replies[0], replies[1]);
  assert.match(errors[0], /already delivered.*\[duplicate\]$/);
  assert.match(errors[1], /at most 6 session actions \[limit\]$/);
  const received = view(target)
    .messages.filter((message) => message.origin)
    .map((message) => message.text);
  assert.deepEqual(received, ['Once', 'Different']);
  assert.equal(runs.filter((run) => run.id === target).length, 3);
});

test('drafts never start turns, retain conflicting user text and report uncertain outcomes', async (context) => {
  const { sessions, runs, script, view } = await fixture(context);
  const target = sessions.start(frame, signal());
  await sessions.idle();
  const targetMessages = view(target).messages.length;
  const targetRuns = runs.filter((run) => run.id === target).length;

  const requests: AgentDraftRequest[] = [];
  const outcomes: AgentDraftOutcome[] = [
    { outcome: 'conflict', reason: '' },
    { outcome: 'inserted', reason: '' },
    { outcome: 'unconfirmed', reason: 'The panel did not confirm the draft within 5 seconds.' },
  ];
  const errors: string[] = [];
  const replies: Record<string, unknown>[] = [];
  const requester = sessions.start({ ...frame, utterance: '📝 Drafting helper' }, signal());
  script(requester, async (run) => {
    errors.push(await refusal(run, 'companion_session_draft', { id: target, text: 'Offline' }));
    sessions.setDraftHost(async (request) => {
      requests.push(request);
      return outcomes.shift()!;
    });
    errors.push(await refusal(run, 'companion_session_draft', { id: target, text: 'Proposal' }));
    // A confirmed conflict changed nothing, so an identical retry is allowed.
    replies.push(
      await call(run, 'companion_session_draft', {
        id: target,
        text: 'Proposal',
        ifDraftExists: 'append',
        focus: true,
      }),
    );
    errors.push(await refusal(run, 'companion_session_draft', { id: target, text: 'Maybe' }));
    // After an uncertain outcome the same content is not delivered again.
    errors.push(await refusal(run, 'companion_session_draft', { id: target, text: 'Maybe' }));
    // A draft in the caller's own composer is not a feedback loop.
    outcomes.push({ outcome: 'inserted', reason: '' });
    replies.push(await call(run, 'companion_session_draft', { id: requester, text: 'Note' }));
  });
  await sessions.idle();

  assert.match(errors[0], /no Companion panel is connected.*\[offline\]$/);
  assert.match(errors[1], /already has unsent text there, which was left unchanged.*\[conflict\]$/);
  assert.match(errors[2], /may or may not have been inserted.*Do not resend.*\[unconfirmed\]$/);
  assert.match(errors[3], /\[duplicate\]$/);
  assert.equal(replies[0].outcome, 'inserted');
  assert.equal(replies[1].outcome, 'inserted');

  assert.deepEqual(requests[0], {
    sessionId: target,
    text: 'Proposal',
    ifDraftExists: 'reject',
    focus: false,
    source: { sessionId: requester, title: '📝 Drafting helper' },
  });
  assert.equal(requests[1].ifDraftExists, 'append');
  assert.equal(requests[1].focus, true);

  // Nothing was submitted to the target conversation.
  assert.equal(view(target).messages.length, targetMessages);
  assert.equal(runs.filter((run) => run.id === target).length, targetRuns);
});

test('archived agent provenance is validated when a conversation is read', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-origin-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory);
  context.after(() => store.tools.close());
  const id = randomUUID();
  const valid = {
    ...chatMessage('valid', 'user', 'From an agent'),
    origin: {
      kind: 'agent' as const,
      sessionId: randomUUID(),
      title: 'Sender',
      depth: 2,
      sourceGroupId: randomUUID(),
    },
  };
  const forged = {
    ...chatMessage('forged', 'user', 'Not really'),
    origin: { kind: 'agent' as const, sessionId: '../../x', title: 'Sender', depth: 1 },
  };
  const malformedAnchor = {
    ...chatMessage('malformed-anchor', 'user', 'From an agent'),
    origin: { ...valid.origin, sourceGroupId: '../../x' },
  };
  const assistant = { ...chatMessage('assistant', 'assistant', 'Answer'), origin: valid.origin };
  await store.save({
    id,
    title: 'Stored',
    status: 'completed',
    model: 'configured/one',
    error: '',
    updatedAt: 1,
    messages: [valid, forged, malformedAnchor, assistant],
  });

  const read = await store.read(id);
  assert.deepEqual(read.messages[0].origin, valid.origin);
  assert.equal(read.messages[1].origin, undefined);
  assert.deepEqual(read.messages[2].origin, {
    kind: 'agent',
    sessionId: valid.origin.sessionId,
    title: valid.origin.title,
    depth: valid.origin.depth,
  });
  assert.equal(read.messages[3].origin, undefined);
});

test('Pi loads the session tools extension only with a turn lease', async (context) => {
  const previousExternalSocket = process.env.COMPANION_EXTERNAL_SOCKET;
  process.env.COMPANION_EXTERNAL_SOCKET = '/synthetic/should-not-be-inherited.sock';
  context.after(() => {
    if (previousExternalSocket === undefined) {
      delete process.env.COMPANION_EXTERNAL_SOCKET;
    } else {
      process.env.COMPANION_EXTERNAL_SOCKET = previousExternalSocket;
    }
  });
  const directory = await mkdtemp(join(tmpdir(), 'companion-session-tools-pi-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fixture-pi');
  await copyFile(fileURLToPath(new URL('../fixtures/pi-rpc.mjs', import.meta.url)), executable);
  await chmod(executable, 0o700);
  const request = {
    id: 'session-tools',
    directory,
    settings: { ...defaultAgentSettings, executable },
    prompt: { text: 'plain' },
    resume: false,
  };
  const extension = fileURLToPath(new URL('../../src/agents/session-tools.ts', import.meta.url));
  const argv = async () =>
    JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')).argv as string[];

  await new PiBackend().run(request, signal(), () => {});
  assert.equal((await argv()).includes(extension), false);
  const environment = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  assert.equal(
    environment.internalAgent,
    '1',
    'Even a turn without a lease must use the internal API',
  );
  assert.equal(environment.externalSocketExported, false);

  await new PiBackend().run(
    {
      ...request,
      sessionTools: { endpoint: 'http://127.0.0.1:1/session', token: 'a'.repeat(64) },
    },
    signal(),
    () => {},
  );
  const withLease = await argv();
  assert.equal(withLease[withLease.indexOf(extension) - 1], '--extension');
});

test('agents close idle conversations but never stop another conversation’s work', async (context) => {
  const { sessions, runs, events, script, view } = await fixture(context);
  const idle = sessions.start({ ...frame, utterance: 'Finished work' }, signal());
  await sessions.idle();
  const history = view(idle).messages.map((message) => message.text);
  const release = deferred<void>();
  const running = sessions.start({ ...frame, utterance: 'Still running' }, signal());
  script(running, async () => {
    await release.promise;
  });

  const results: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const requester = sessions.start(frame, signal());
  script(requester, async (run) => {
    results.push(await call(run, 'companion_session_close', { id: idle }));
    results.push(await call(run, 'companion_session_close', { id: idle }));
    errors.push(await refusal(run, 'companion_session_close', { id: running }));
    errors.push(await refusal(run, 'companion_session_close', { id: randomUUID() }));
  });
  await waitFor(() => errors.length === 2);

  assert.equal(results[0].outcome, 'closed');
  assert.equal(results[1].outcome, 'already-closed');
  assert.match(errors[0], /left open\. \[busy\]$/);
  assert.match(errors[1], /\[unknown-session\]$/);
  assert.ok(events.some((event) => event.type === 'agent-removed' && event.id === idle));
  assert.equal(sessions.has(idle), false);
  assert.ok(sessions.previousSnapshot().some((entry) => entry.id === idle));
  // The busy conversation kept running; it was neither stopped nor closed.
  assert.equal(view(running).status, 'running');
  release.resolve();
  await sessions.idle();
  assert.equal(view(running).status, 'completed');

  // Closing saved the history, so reopening restores it unchanged.
  await sessions.reopen(idle);
  assert.deepEqual(
    view(idle).messages.map((message) => message.text),
    history,
  );
  assert.equal(runs.filter((run) => run.id === idle).length, 1);
});

test('an agent closes its own conversation only after its turn completes with nothing queued', async (context) => {
  const { sessions, events, script } = await fixture(context);
  const outcomes: Record<string, unknown>[] = [];

  // Closes once the answer is saved; the answer remains in its history.
  const finishing = sessions.start({ ...frame, utterance: 'Close when done' }, signal());
  script(finishing, async (run) => {
    outcomes.push(await call(run, 'companion_session_close', { id: finishing }));
    assert.equal(sessions.has(finishing), true, 'The tab stays open during the turn');
  });
  await sessions.idle();
  await waitFor(() => !sessions.has(finishing));
  assert.equal(outcomes[0].outcome, 'closing-after-turn');
  assert.ok(events.some((event) => event.type === 'agent-removed' && event.id === finishing));
  await sessions.reopen(finishing);
  assert.ok(
    sessions
      .snapshot()
      .find((session) => session.id === finishing)!
      .messages.some((message) => message.kind === 'assistant'),
  );

  // A message queued during the turn cancels the close and still runs.
  const continued = sessions.start({ ...frame, utterance: 'Close unless asked more' }, signal());
  script(continued, async (run) => {
    await call(run, 'companion_session_close', { id: continued });
    sessions.followUp(continued, 'One more thing', signal());
  });
  await sessions.idle();
  await sessions.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.has(continued), true);
  assert.equal(
    sessions
      .snapshot()
      .find((session) => session.id === continued)!
      .messages.filter((message) => message.kind === 'user').length,
    2,
  );

  // A failed turn keeps its tab so the user can see the error.
  const failing = sessions.start({ ...frame, utterance: 'Close then fail' }, signal());
  script(failing, async (run) => {
    await call(run, 'companion_session_close', { id: failing });
    throw Error('Synthetic failure');
  });
  await sessions.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.has(failing), true);
  assert.equal(sessions.snapshot().find((session) => session.id === failing)!.status, 'error');
});

test('a lease released while a request body is arriving performs no action', async (context) => {
  const performed: string[] = [];
  const unexpected = (name: string) => async () => {
    performed.push(name);
    throw Error(`${name} must not run`);
  };
  const host = {
    title: () => 'Sender',
    directory: () => ({ open: [], previous: [], previousMatches: 0 }),
    start: unexpected('start'),
    reopen: unexpected('reopen'),
    close: unexpected('close'),
    send: () => {
      performed.push('send');
      throw Error('send must not run');
    },
    draft: unexpected('draft'),
  } as unknown as SessionToolHost;
  const service = new SessionToolService(host);
  context.after(() => service.close());

  // Test-only barrier: resolve once the server has authenticated a request
  // and started reading its body, so the release below cannot happen first.
  let bodyEntered = deferred<void>();
  const internals = service as unknown as {
    body(request: unknown): Promise<Record<string, unknown>>;
  };
  const readBody = internals.body.bind(service);
  internals.body = (request) => {
    bodyEntered.resolve();
    return readBody(request);
  };

  for (const method of ['close', 'reopen', 'list']) {
    bodyEntered = deferred<void>();
    const lease = await service.lease(randomUUID(), 0, signal());
    const url = new URL(lease.endpoint);
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${lease.token}`,
            },
          },
          (response) => {
            let received = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (received += chunk));
            response.on('end', () => resolve({ status: response.statusCode!, body: received }));
          },
        );
        request.on('error', reject);
        // Authenticate with the headers alone, then end the turn before the
        // body arrives, as a stopped turn with an in-flight tool call would.
        request.flushHeaders();
        void bodyEntered.promise.then(() => {
          lease.release();
          request.end(JSON.stringify({ method, requestId: randomUUID(), id: randomUUID() }));
        });
      },
    );
    assert.equal(status, 403, `${method} after release`);
    assert.match(body, /"code":"expired"/);
  }
  assert.deepEqual(performed, []);
});

test('a reopen whose turn ends while its archive is read leaves it saved and closed', async (context) => {
  const { sessions } = await fixture(context);
  const saved = sessions.start(frame, signal());
  await sessions.idle();
  await sessions.remove(saved);

  const turn = new AbortController();
  const reopening = sessions.reopen(saved, false, turn.signal);
  turn.abort();
  await assert.rejects(reopening, /turn has ended/);
  assert.equal(sessions.has(saved), false);
  assert.ok(sessions.previousSnapshot().some((entry) => entry.id === saved));
});

test('Stop after the turn settles cancels a pending self-close', async (context) => {
  const { sessions, script } = await fixture(context);
  const id = sessions.start({ ...frame, utterance: 'Close later' }, signal());
  script(id, async (run) => {
    await call(run, 'companion_session_close', { id });
  });
  await sessions.idle();
  // The deferred close is scheduled but has not run yet.
  assert.equal(sessions.has(id), true);
  await sessions.stop(id);
  // A wrongly surviving close runs remove(), which saves before removing.
  // Allow ample time for that asynchronous removal to become observable.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sessions.has(id), true);
  assert.equal(
    sessions.previousSnapshot().some((entry) => entry.id === id),
    false,
  );
});
