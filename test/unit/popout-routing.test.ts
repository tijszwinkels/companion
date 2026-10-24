// Pop-out windows and the voice target.
//
// A native Companion UI can show real conversations in their own windows and
// reports them in its `panel-state` (popoutHost, rail, popouts). These tests
// drive the real desktop runtime over its real socket, real AgentSessions with
// a scripted backend, the real router and the real continuation processor.
// No microphone, screenshot, model provider or native window is involved; the
// native side is covered by the window/panel suites.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import type { InteractionContext } from '../../src/core/frame.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal, testDetector } from '../helpers.ts';

/** The exact existing instructions; pop-outs must not add or change wording. */
const focusedInstruction =
  'The user has  a coding agent session open and has the input field selected. Unless your context gives you strong reasons to think that the user has a different intention, select this intent.';
const unfocusedInstruction =
  "The user has a coding agent conversation selected in the open sidebar, but its input field is not selected. Choose this intent if the utterance is a follow-up, answer, correction, or request addressed to that conversation. Use the selected conversation's title and message excerpts together with the utterance and screenshot to judge this. The open sidebar alone is not a reason to choose this intent. Choose another intent if the utterance is intended for the active application, starts an independent request to the assistant, or is not addressed to the assistant.";

interface Popout {
  id: string;
  active: boolean;
  composerFocused: boolean;
}

/** Three real conversations, the real desktop runtime and a continuation route. */
async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-popout-routing-'));
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'popout-fixture',
        label: 'Pop-out fixture',
        dependencies: {},
        async run(request) {
          requests.push(request);
        },
      },
    },
    () => {},
    directory,
  );
  const desktop = await desktopFixture(
    async () => assert.fail('No keyboard or desktop command'),
    sessions,
  );
  context.after(async () => {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });

  const a = sessions.start({ ...frame, utterance: 'Conversation A' }, signal());
  const b = sessions.start({ ...frame, utterance: 'Conversation B' }, signal());
  const c = sessions.start({ ...frame, utterance: 'Conversation C' }, signal());
  await sessions.idle();

  const activity = desktop.runtime.activity;
  const outcomes: string[] = [];
  const feedback = {
    ...activity,
    outcome: (_id: number, outcome: string) => outcomes.push(outcome),
  };
  const continuation = new ContinueOpenAgentConversation({ sessions }, () => {}, false, feedback);

  /** Send one native report; returns the reply type ('result' or 'error'). */
  async function report(fields: {
    id?: string;
    composerFocused?: boolean;
    keyboardFocused?: boolean;
    rail?: unknown;
    popouts?: unknown;
    popoutHost?: unknown;
  }): Promise<string> {
    desktop.send({
      action: 'panel-state',
      id: fields.id ?? '',
      composerFocused: fields.composerFocused ?? false,
      keyboardFocused: fields.keyboardFocused,
      visible: true,
      draftHost: true,
      popoutHost: 'popoutHost' in fields ? fields.popoutHost : true,
      rail: 'rail' in fields ? fields.rail : 'full',
      popouts: 'popouts' in fields ? fields.popouts : [],
    });
    return (await desktop.reply('panel-state')).type;
  }

  function current(): InteractionContext {
    return activity.interactionContext!();
  }

  /** A router whose detector picks continuation and records the instruction offered. */
  function continuationRouter(seen: string[]) {
    const router = new UserSensorRouter(
      {
        detector: testDetector({
          detect: async (_input, intents) => {
            const entry = intents.find((intent) => intent.name === continuation.name);
            if (!entry) {
              return 'IGNORE';
            }
            seen.push(entry.instruction);
            return entry.name;
          },
        }),
      },
      () => {},
      feedback,
    );
    new Ignore(() => {}).subscribe(router);
    continuation.subscribe(router);
    return router;
  }

  return {
    sessions,
    requests,
    desktop,
    activity,
    outcomes,
    a,
    b,
    c,
    report,
    current,
    continuationRouter,
  };
}

function window(id: string, active = false, composerFocused = false): Popout {
  return { id, active, composerFocused };
}

test('legacy reports keep the exact single-view behavior', async (context) => {
  const f = await fixture(context);

  // A client without popoutHost and without the new fields: unchanged.
  f.desktop.send({ action: 'panel-state', id: f.a, composerFocused: true });
  assert.equal((await f.desktop.reply('panel-state')).type, 'result');
  assert.equal(f.current().agentSessionId, f.a);
  assert.equal(f.current().agentComposerFocused, true);
  assert.equal(f.current().agentTargetSource, 'panel');

  // popoutHost: false is the same as omitting it.
  f.desktop.send({ action: 'panel-state', id: f.b, composerFocused: false, popoutHost: false });
  assert.equal((await f.desktop.reply('panel-state')).type, 'result');
  assert.equal(f.current().agentSessionId, f.b);
  assert.equal(f.current().agentComposerFocused, false);
});

test('malformed pop-out reports are refused without changing the previous target', async (context) => {
  const f = await fixture(context);
  assert.equal(await f.report({ id: f.a, popouts: [window(f.b)] }), 'result');
  const before = f.current();

  const nine = Array.from({ length: 9 }, () => window(f.c));
  const malformed: Parameters<typeof f.report>[0][] = [
    // Fields without the capability, or a capability that is not exactly true.
    { popoutHost: undefined, popouts: [window(f.b)] },
    { popoutHost: 'yes' },
    // Missing or unknown rail, missing popouts.
    { rail: undefined },
    { rail: 'hidden' },
    { popouts: undefined },
    // More than eight windows, duplicates, unknown or closed conversations.
    { popouts: nine },
    { popouts: [window(f.b), window(f.b)] },
    { popouts: [window('00000000-0000-4000-8000-000000000000')] },
    // More than one active window; a focused composer in an inactive window.
    { popouts: [window(f.b, true), window(f.c, true)] },
    { popouts: [window(f.b, false, true)] },
    // Extra or mistyped window fields.
    { popouts: [{ ...window(f.b), url: 'https://example.com/' }] },
    { popouts: [{ id: f.b, active: 'true', composerFocused: false }] },
    { popouts: [{ id: '', active: false, composerFocused: false }] },
    { popouts: 'none' },
  ];
  for (const fields of malformed) {
    assert.equal(await f.report({ id: f.c, ...fields }), 'error', JSON.stringify(fields));
    assert.deepEqual(f.current(), before, JSON.stringify(fields));
  }
});

test('remote panels cannot claim pop-out windows or answer presentation requests', async (context) => {
  const f = await fixture(context);
  assert.equal(await f.report({ popouts: [window(f.a, true)] }), 'result');
  const before = f.current();

  const remote = createConnection(f.desktop.socketPath);
  context.after(async () => {
    remote.destroy();
  });
  const received: string[] = [];
  remote.setEncoding('utf8');
  remote.on('data', (chunk: string) => received.push(chunk));
  await once(remote, 'connect');
  remote.write(JSON.stringify({ action: 'client-role', role: 'remote' }) + '\n');
  await waitFor(() => received.join('').includes('role-recorded'));

  remote.write(
    JSON.stringify({
      action: 'panel-state',
      id: f.b,
      popoutHost: true,
      rail: 'compact',
      popouts: [window(f.b, true)],
    }) + '\n',
  );
  await waitFor(() => received.join('').includes('Remote panels cannot report pop-out windows'));

  remote.write(
    JSON.stringify({
      action: 'agent-present-result',
      requestId: 'x',
      outcome: 'shown',
      focused: true,
    }) + '\n',
  );
  await waitFor(() => received.join('').includes('only available on the desktop'));

  // The desktop's pop-out target is untouched.
  assert.deepEqual(f.current(), before);
});

test('voice target precedence: active window, visible sidebar, single window beside compact rail, none', async (context) => {
  const f = await fixture(context);

  // An active window wins over the visible sidebar conversation.
  await f.report({ id: f.a, popouts: [window(f.b, true)] });
  assert.equal(f.current().agentSessionId, f.b);
  assert.equal(f.current().agentTargetSource, 'popout');

  // No active window: the visible sidebar conversation.
  await f.report({ id: f.a, popouts: [window(f.b)] });
  assert.equal(f.current().agentSessionId, f.a);
  assert.equal(f.current().agentTargetSource, 'panel');

  // Compact rail with exactly one window: that window, as a weak candidate.
  await f.report({ rail: 'compact', popouts: [window(f.b)] });
  assert.equal(f.current().agentSessionId, f.b);
  assert.equal(f.current().agentTargetSource, 'popout-only');
  assert.equal(f.current().agentComposerFocused, false);

  // Several unfocused windows are never guessed between.
  await f.report({ rail: 'compact', popouts: [window(f.b), window(f.c)] });
  assert.equal(f.current().agentSessionId, '');
  assert.equal(f.current().agentTargetSource, undefined);

  // A full rail with an empty main view and one window: no target either.
  await f.report({ rail: 'full', popouts: [window(f.b)] });
  assert.equal(f.current().agentSessionId, '');
});

test('only a focused composer earns the strong instruction; the follow-up reaches the same real session', async (context) => {
  const f = await fixture(context);
  const seen: string[] = [];
  const router = f.continuationRouter(seen);
  const sessionCount = f.sessions.snapshot().length;

  const cases: [Parameters<typeof f.report>[0], string, string][] = [
    // Active window, composer not focused: the ordinary unfocused wording.
    [{ id: f.a, popouts: [window(f.b, true)] }, f.b, unfocusedInstruction],
    // Active window with its own composer focused: the strong wording.
    [{ id: f.a, popouts: [window(f.b, true, true)] }, f.b, focusedInstruction],
    // Single window beside the compact rail: weak candidate.
    [{ rail: 'compact', popouts: [window(f.c)] }, f.c, unfocusedInstruction],
    // A stale main composer flag cannot outrank the active window's focus.
    [{ id: f.a, composerFocused: true, popouts: [window(f.b, true)] }, f.b, unfocusedInstruction],
  ];

  for (const [fields, target, instruction] of cases) {
    assert.equal(await f.report(fields), 'result');
    const before = f.requests.length;
    await router.route({ ...frame, interaction: f.current() }, signal());
    await f.sessions.idle();

    assert.equal(seen.at(-1), instruction);
    assert.equal(f.requests.length, before + 1);
    assert.equal(f.requests.at(-1)!.id, target);
    assert.equal(f.requests.at(-1)!.resume, true);
  }

  // Pop-outs never create or clone conversations.
  assert.equal(f.sessions.snapshot().length, sessionCount);
});

test('the continue session prefix addresses the active window', async (context) => {
  const f = await fixture(context);
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => assert.fail('Prefix reached inference') }) },
    () => {},
  );
  new ContinueOpenAgentConversation({ sessions: f.sessions }, () => {}, false, {
    ...f.activity,
    outcome: () => {},
  }).subscribe(router);

  await f.report({ id: f.a, rail: 'compact', popouts: [window(f.c, true)] });
  await router.route(
    { ...frame, utterance: 'Continue session, check the logs.', interaction: f.current() },
    signal(),
  );
  await f.sessions.idle();
  assert.equal(f.requests.at(-1)!.id, f.c);
  assert.equal(f.requests.at(-1)!.prompt.text, 'check the logs.');
});

test('every semantic view change invalidates captured speech, even for the same conversation', async (context) => {
  const f = await fixture(context);
  const seen: string[] = [];

  type Change = () => Promise<unknown>;
  const changes: [string, Parameters<typeof f.report>[0], Change][] = [
    // The same conversation moves from the sidebar into its own active window.
    [
      'sidebar to window',
      { id: f.a },
      () => f.report({ rail: 'compact', popouts: [window(f.a, true)] }),
    ],
    // ... and back.
    ['window to sidebar', { popouts: [window(f.a, true)] }, () => f.report({ id: f.a })],
    // Activation moves away and back to the same window.
    [
      'activation away and back',
      { popouts: [window(f.a, true), window(f.b)] },
      async () => {
        await f.report({ popouts: [window(f.a), window(f.b, true)] });
        await f.report({ popouts: [window(f.a, true), window(f.b)] });
      },
    ],
    // Composer focus inside the active window toggles and returns.
    [
      'window composer focus',
      { popouts: [window(f.a, true, true)] },
      async () => {
        await f.report({ popouts: [window(f.a, true)] });
        await f.report({ popouts: [window(f.a, true, true)] });
      },
    ],
    // Another conversation's window opens while the target stays the same.
    ['membership', { id: f.a }, () => f.report({ id: f.a, popouts: [window(f.c)] })],
    // Rail layout changes while the target stays the same window.
    [
      'rail',
      { rail: 'full', popouts: [window(f.a, true)] },
      () => f.report({ rail: 'compact', popouts: [window(f.a, true)] }),
    ],
    // The target window closes.
    ['close window', { popouts: [window(f.a, true)] }, () => f.report({ popouts: [] })],
  ];

  for (const [name, initial, change] of changes) {
    assert.equal(await f.report(initial), 'result', name);
    const captured = f.current();
    assert.equal(captured.agentSessionId, f.a, name);
    const before = f.requests.length;

    const router = new UserSensorRouter(
      {
        detector: testDetector({
          detect: async (_input, intents) => {
            await change();
            const entry = intents.find(
              (intent) => intent.name === 'CONTINUE_OPEN_AGENT_CONVERSATION',
            );
            seen.push(entry?.instruction ?? '');
            return 'CONTINUE_OPEN_AGENT_CONVERSATION';
          },
        }),
      },
      () => {},
    );
    new Ignore(() => {}).subscribe(router);
    new ContinueOpenAgentConversation({ sessions: f.sessions }, () => {}, false, {
      ...f.activity,
      outcome: (_id: number, outcome: string) => f.outcomes.push(outcome),
    }).subscribe(router);

    await router.route({ ...frame, interaction: captured }, signal());
    await f.sessions.idle();
    assert.equal(f.activity.interactionCurrent!(captured), false, name);
    assert.equal(f.requests.length, before, name);
    assert.equal(f.outcomes.at(-1), 'skipped', name);
  }
});

test('identical reports and streamed conversation updates keep captured speech current', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.b, rail: 'full', popouts: [window(f.a, true), window(f.c)] });
  const captured = f.current();

  // The same report again, with windows listed in another order.
  await f.report({ id: f.b, rail: 'full', popouts: [window(f.c), window(f.a, true)] });
  // A turn in another conversation streams transcript and title updates.
  await f.sessions.followUp(f.c, 'Background work', signal());
  await f.sessions.idle();

  assert.equal(f.activity.interactionCurrent!(captured), true);
  assert.equal(f.current().revision, captured.revision);
});

test('window focus changes stop pending keyboard delivery', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.a, keyboardFocused: false, popouts: [window(f.b)] });

  // Activating a window: keyboard focus moves into Companion.
  f.activity.processing!(frame.id);
  await f.report({ id: f.a, popouts: [window(f.b, true)] });
  assert.equal(f.activity.deliveryAllowed!(frame.id), false);
  f.activity.finished!(frame.id);

  // Moving focus between windows of the same panel.
  await f.report({ popouts: [window(f.b, true), window(f.c)] });
  f.activity.processing!(frame.id + 1);
  await f.report({ popouts: [window(f.b), window(f.c, true)] });
  assert.equal(f.activity.deliveryAllowed!(frame.id + 1), false);
  f.activity.finished!(frame.id + 1);

  // Opening an inactive window does not touch keyboard delivery.
  await f.report({ popouts: [] });
  f.activity.processing!(frame.id + 2);
  await f.report({ popouts: [window(f.b)] });
  assert.equal(f.activity.deliveryAllowed!(frame.id + 2), true);
  f.activity.finished!(frame.id + 2);

  // While a window is active, typed Activity text is refused like a focused panel.
  await f.report({ popouts: [window(f.b, true)] });
  f.desktop.send({ action: 'submit-utterance', text: 'Hello', target: '0x1' });
  const refused = await f.desktop.reply('submit-utterance');
  assert.equal(refused.type, 'error');
  assert.match(String(refused.message), /Release Companion keyboard focus/);
});

test('pop-out windows admit their own conversation controls, and only for their owner', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.a, popouts: [window(f.b)] });

  const page = (id: string) => ({
    action: 'agent-history-page',
    id,
    epoch: 'stale-epoch',
    requestId: 'page-1',
    direction: 'before',
    index: 0,
    offset: 0,
  });

  // The window's conversation passes the "shown" check (and then fails on the
  // fabricated epoch); a conversation shown nowhere is refused as unselected.
  f.desktop.send(page(f.b));
  const shown = await f.desktop.reply('agent-history-page');
  assert.doesNotMatch(String(shown.message), /no longer selected/);
  f.desktop.send(page(f.c));
  assert.match(String((await f.desktop.reply('agent-history-page')).message), /no longer selected/);

  // Another desktop connection cannot use the first panel's window.
  const other = createConnection(f.desktop.socketPath);
  context.after(async () => {
    other.destroy();
  });
  const received: string[] = [];
  other.setEncoding('utf8');
  other.on('data', (chunk: string) => received.push(chunk));
  await once(other, 'connect');
  other.write(JSON.stringify(page(f.b)) + '\n');
  await waitFor(() => received.join('').includes('no longer selected'));
});

test('a stale observer cannot clear the owner window target; disconnect and session close do', async (context) => {
  const f = await fixture(context);
  await f.report({ rail: 'compact', popouts: [window(f.b, true)] });
  const captured = f.current();
  assert.equal(captured.agentSessionId, f.b);

  // A second (legacy) desktop panel reports nothing selected.
  const observer = createConnection(f.desktop.socketPath);
  context.after(async () => {
    observer.destroy();
  });
  observer.setEncoding('utf8');
  const received: string[] = [];
  observer.on('data', (chunk: string) => received.push(chunk));
  await once(observer, 'connect');
  observer.write(JSON.stringify({ action: 'panel-state', id: '', composerFocused: false }) + '\n');
  await waitFor(() => received.join('').includes('panel-recorded'));
  assert.equal(f.activity.interactionCurrent!(captured), true);

  // Closing the windowed conversation removes it at once.
  await f.sessions.remove(f.b);
  await waitFor(() => f.current().agentSessionId === '');
  assert.equal(f.activity.interactionCurrent!(captured), false);

  // The owner's windows disappear with its connection.
  await f.report({ rail: 'compact', popouts: [window(f.c, true)] });
  const second = f.current();
  assert.equal(second.agentSessionId, f.c);
  f.desktop.client.destroy();
  await once(f.desktop.client, 'close');
  await waitFor(() => f.current().agentSessionId === '');
  assert.equal(f.activity.interactionCurrent!(second), false);
});

test('withdrawing the capability forgets the windows', async (context) => {
  const f = await fixture(context);
  await f.report({ rail: 'compact', popouts: [window(f.b, true)] });
  const captured = f.current();

  f.desktop.send({ action: 'panel-state', id: '', composerFocused: false, visible: true });
  assert.equal((await f.desktop.reply('panel-state')).type, 'result');
  assert.equal(f.current().agentSessionId, '');
  assert.equal(f.activity.interactionCurrent!(captured), false);
});
