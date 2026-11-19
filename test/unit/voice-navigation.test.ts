// Explicit voice navigation and the voice target (#11), and the pop-out voice
// command (#14).
//
// "Go to session N" selects a conversation in the sidebar (or focuses its
// window) without taking focus from the window the person was in. The
// conversation it chose must still receive the next utterance, and the
// visible voice indication must agree. "Pop out session N" uses the same
// numbering and captured navigation to show an existing conversation in its
// own window.
//
// These tests drive the real desktop runtime over its real socket, real
// AgentSessions with a scripted backend, the real router with the real
// GO_TO_SESSION, POP_OUT_SESSION and continuation processors. The native UI is
// played by this test: it reports what it shows in `panel-state`, as the
// pop-out host does after carrying out an `agent-select`. No microphone,
// model provider, compositor or native window is involved.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../../src/agents/sessions.ts';
import type { AgentBackend } from '../../src/agents/types.ts';
import type { InteractionContext } from '../../src/core/frame.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { ContinueOpenAgentConversation } from '../../src/processors/continue-open-agent-conversation.ts';
import { GoToSession } from '../../src/processors/go-to-session.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { PopOutSession } from '../../src/processors/pop-out-session.ts';
import { desktopFixture, waitFor } from '../desktop-fixture.ts';
import { frame, signal, testDetector } from '../helpers.ts';

interface Popout {
  id: string;
  active: boolean;
  composerFocused: boolean;
}

function window(id: string, active = false, composerFocused = false): Popout {
  return { id, active, composerFocused };
}

/** Three real conversations (numbered 1–3), the real runtime and router. */
async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-voice-navigation-'));
  const requests: Parameters<AgentBackend['run']>[0][] = [];
  const sessions = new AgentSessions(
    {
      pi: {
        id: 'navigation-fixture',
        label: 'Navigation fixture',
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

  const one = sessions.start({ ...frame, utterance: 'Conversation one' }, signal());
  const two = sessions.start({ ...frame, utterance: 'Conversation two' }, signal());
  const three = sessions.start({ ...frame, utterance: 'Conversation three' }, signal());
  await sessions.idle();

  const activity = desktop.runtime.activity;
  const outcomes: string[] = [];
  const feedback = {
    ...activity,
    outcome: (_id: number, outcome: string) => outcomes.push(outcome),
  };

  // Navigation commands by prefix; anything else is a follow-up to the
  // voice target (the detector always picks continuation when offered).
  const continuation = new ContinueOpenAgentConversation({ sessions }, () => {}, false, feedback);
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async (_input, intents) =>
          intents.some((intent) => intent.name === continuation.name)
            ? continuation.name
            : 'IGNORE',
      }),
    },
    () => {},
    feedback,
  );
  new Ignore(() => {}).subscribe(router);
  new GoToSession(() => {}, false, feedback).subscribe(router);
  new PopOutSession(() => {}, false, feedback).subscribe(router);
  continuation.subscribe(router);

  let tokenSequence = 0;
  let token = 'token-0';

  /**
   * One native pop-out host report. A new navigation token is issued
   * whenever the UI's selection or windows change, as the real UI does.
   */
  async function report(fields: {
    id?: string;
    composerFocused?: boolean;
    rail?: 'full' | 'compact';
    popouts?: Popout[];
    newToken?: boolean;
    popoutHost?: boolean;
  }): Promise<void> {
    if (fields.newToken !== false) {
      token = `token-${++tokenSequence}`;
    }
    const request: Record<string, unknown> = {
      action: 'panel-state',
      id: fields.id ?? '',
      composerFocused: fields.composerFocused ?? false,
      visible: true,
      navigationToken: token,
      draftHost: true,
    };
    if (fields.popoutHost !== false) {
      request.popoutHost = true;
      request.rail = fields.rail ?? 'full';
      request.popouts = fields.popouts ?? [];
    }
    desktop.send(request);
    assert.equal((await desktop.reply('panel-state')).type, 'result');
  }

  function current(): InteractionContext {
    return activity.interactionContext!();
  }

  /**
   * Speak `utterance` with the context captured now. Returns the UI command
   * it sent, if any: an admitted navigation reaches the socket shortly after
   * the route returns, so wait for its outcome's message (or its absence).
   */
  async function say(utterance: string, captured = current()) {
    const before = desktop.messages.length;
    const outcomesBefore = outcomes.length;
    await router.route({ ...frame, utterance, interaction: captured }, signal());
    const selected = outcomes.length > outcomesBefore && outcomes.at(-1) === 'selected';
    const sent = () =>
      desktop.messages.slice(before).filter((message) => message.type === 'agent-select');
    if (selected) {
      await waitFor(() => sent().length > 0);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return sent().at(-1) as (Record<string, unknown> & { id?: string }) | undefined;
  }

  /**
   * Wait until the voice projection the UI shows ("Voice: this
   * conversation") names `expected`: the latest state snapshot's
   * `agentActions` or `agent-actions` event, whichever came last.
   */
  async function indicated(expected: string): Promise<void> {
    const latest = () => {
      const message = desktop.messages
        .filter(
          (entry) =>
            entry.type === 'agent-actions' || (entry.type === 'state' && 'agentActions' in entry),
        )
        .at(-1) as
        { actions?: { sessionId?: string }; agentActions?: { sessionId?: string } } | undefined;
      return (message?.agentActions ?? message?.actions)?.sessionId ?? '';
    };
    await waitFor(() => latest() === expected).catch(() => {
      assert.equal(latest(), expected, 'voice indication');
    });
  }

  return {
    sessions,
    requests,
    desktop,
    activity,
    outcomes,
    one,
    two,
    three,
    report,
    current,
    say,
    indicated,
  };
}

test('go to session N selects the sidebar conversation as the voice target while a pop-out keeps focus', async (context) => {
  const f = await fixture(context);

  // The sidebar shows one; conversation three is popped out and focused,
  // with its composer focused: three is the voice target.
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentSessionId, f.three);
  assert.equal(f.current().agentTargetSource, 'popout');

  // "Go to session two": the UI is asked to select it. Routing does not run
  // ahead of the view: until the UI shows it, the target is unchanged.
  const select = await f.say('Go to session two');
  assert.equal(f.outcomes.at(-1), 'selected');
  assert.equal(select?.id, f.two);
  assert.equal(select?.presentation, undefined, 'plain navigation, not a pop-out');
  assert.equal(f.current().agentSessionId, f.three);

  // The UI selected it in the sidebar; the window kept keyboard focus.
  await f.report({ id: f.two, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentSessionId, f.two);
  assert.equal(f.current().agentTargetSource, 'navigation');
  // The sidebar composer is not focused: the ordinary unfocused wording.
  assert.equal(f.current().agentComposerFocused, false);

  // Unrelated repeated reports (same view) keep it.
  await f.report({ id: f.two, popouts: [window(f.three, true, true)], newToken: false });
  assert.equal(f.current().agentSessionId, f.two);

  // The next utterance is a follow-up to two, not to the pop-out, and the
  // navigation command itself was never sent as text.
  const before = f.requests.length;
  await f.say('Please also check the tests');
  await waitFor(() => f.requests.length === before + 1);
  assert.equal(f.requests.at(-1)!.id, f.two);
  assert.ok(
    f.requests.every((request) => !JSON.stringify(request).includes('Go to session two')),
    'navigation is not a conversation message',
  );
});

test('the voice indication agrees with the navigation target', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.one, popouts: [window(f.three, true)] });
  await f.indicated(f.three);

  await f.say('Go to session two');
  await f.report({ id: f.two, popouts: [window(f.three, true)] });
  await f.indicated(f.two);

  // A genuine later focus change (the person clicks the sidebar, so the
  // window loses focus) ends the explicit choice; ordinary precedence again.
  await f.report({ id: f.two, popouts: [window(f.three)] });
  assert.equal(f.current().agentTargetSource, 'panel');
  await f.indicated(f.two);
});

test('genuine later selection or focus changes end the explicit choice, never a permanent sticky target', async (context) => {
  const f = await fixture(context);

  // Clicking back into the pop-out window's composer.
  await f.report({ id: f.one, popouts: [window(f.three, true)] });
  await f.say('Go to session two');
  await f.report({ id: f.two, popouts: [window(f.three, true)] });
  assert.equal(f.current().agentSessionId, f.two);
  await f.report({ id: f.two, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentSessionId, f.three);
  assert.equal(f.current().agentTargetSource, 'popout');

  // Selecting another tab by hand.
  await f.say('Go to session two');
  await f.report({ id: f.two, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentTargetSource, 'navigation');
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentSessionId, f.three, 'back to ordinary precedence');

  // Another window gaining focus.
  await f.say('Go to session one');
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentSessionId, f.one);
  assert.equal(f.current().agentTargetSource, 'navigation');
  await f.report({ id: f.one, popouts: [window(f.three), window(f.two, true)] });
  assert.equal(f.current().agentSessionId, f.two);
  assert.equal(f.current().agentTargetSource, 'popout');
});

test('the conversation already shown behind the window is chosen without another report', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.two, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentSessionId, f.three);

  // Nothing changes on screen, so the UI reports nothing new.
  await f.say('Go to session two');
  assert.equal(f.current().agentSessionId, f.two);
  assert.equal(f.current().agentTargetSource, 'navigation');
});

test('stale, failed and out-of-range navigation never redirects voice', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });

  // Out of range: skipped, nothing sent, target unchanged.
  assert.equal(await f.say('Go to session nine'), undefined);
  assert.equal(f.outcomes.at(-1), 'skipped');
  assert.equal(f.current().agentSessionId, f.three);

  // Stale: captured before the UI changed its view.
  const stale = f.current();
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  assert.equal(await f.say('Go to session two', stale), undefined);
  assert.equal(f.outcomes.at(-1), 'skipped');
  assert.equal(f.current().agentSessionId, f.three);

  // Admitted, but the UI changed something else instead of showing it (for
  // example the person clicked into the sidebar at the same moment): ends.
  // A report of an unchanged view only means the UI has not acted yet.
  await f.say('Go to session two');
  await f.report({ id: f.one, popouts: [window(f.three, true, true)], newToken: false });
  assert.equal(f.current().agentSessionId, f.three, 'unchanged view: not carried out yet');
  await f.report({ id: f.one, popouts: [window(f.three)] });
  assert.equal(f.current().agentSessionId, f.one);
  assert.equal(f.current().agentTargetSource, 'panel');
  // A late report that does show two no longer makes it the target.
  await f.report({ id: f.two, popouts: [window(f.three)] });
  assert.equal(f.current().agentTargetSource, 'panel');
});

test('speech captured before a navigation is not delivered to the old target afterwards', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  const before = f.current();
  assert.equal(before.agentSessionId, f.three);
  await f.say('Go to session two');
  await f.report({ id: f.two, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentSessionId, f.two);
  assert.equal(f.activity.interactionCurrent!(before), false);

  // Also when the chosen conversation was already shown (no report follows).
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  const again = f.current();
  assert.equal(again.agentSessionId, f.three);
  await f.say('Go to session one');
  assert.equal(f.current().agentSessionId, f.one);
  assert.equal(f.activity.interactionCurrent!(again), false);
});

test('closing the chosen conversation or losing its UI ends the choice', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.one, popouts: [window(f.three, true)] });
  await f.say('Go to session two');
  await f.report({ id: f.two, popouts: [window(f.three, true)] });
  assert.equal(f.current().agentSessionId, f.two);

  // Closed: the target follows ordinary precedence; a reopened conversation
  // with the same ID would not be chosen again.
  await f.sessions.remove(f.two);
  await waitFor(() => f.current().agentSessionId === f.three);
  assert.equal(f.current().agentTargetSource, 'popout');

  // Losing navigation (the UI is hidden) ends it too.
  await f.say('Go to session one');
  await f.report({ id: f.one, popouts: [window(f.three, true)] });
  assert.equal(f.current().agentTargetSource, 'navigation');
  f.desktop.send({
    action: 'panel-state',
    id: '',
    composerFocused: false,
    visible: false,
    draftHost: true,
    popoutHost: true,
    rail: 'full',
    popouts: [],
  });
  await f.desktop.reply('panel-state');
  assert.notEqual(f.current().agentTargetSource, 'navigation');
});

test('pop out session N opens the numbered conversation in a window, by the same numbering', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentNavigation?.popoutHost, true);

  const request = await f.say('Pop out session two');
  assert.equal(f.outcomes.at(-1), 'selected');
  assert.equal(request?.id, f.two);
  assert.equal(request?.presentation, 'window');

  // The UI opened its window; the compositor did not give it focus.
  await f.report({ id: f.one, popouts: [window(f.three, true, true), window(f.two)] });
  assert.equal(f.current().agentSessionId, f.two, 'the popped-out conversation is addressed next');
  assert.equal(f.current().agentTargetSource, 'navigation');
  // When it does take focus, ordinary precedence agrees.
  await f.report({ id: f.one, popouts: [window(f.three), window(f.two, true, true)] });
  assert.equal(f.current().agentSessionId, f.two);
  assert.equal(f.current().agentTargetSource, 'popout');

  // Nothing was created or sent as conversation text.
  assert.equal(f.sessions.snapshot().length, 3);
  assert.ok(f.requests.every((entry) => !JSON.stringify(entry).includes('Pop out session')));
});

test('pop out and go to reach every position up to the 32-conversation limit, never beyond', async (context) => {
  const f = await fixture(context);
  for (let number = 4; number <= 32; number++) {
    f.sessions.start({ ...frame, utterance: `Conversation ${number}` }, signal());
    await f.sessions.idle();
  }
  const ids = f.sessions.order().ids;
  assert.equal(ids.length, 32);

  for (const [utterance, position] of [
    ['Pop out session 17', 17],
    ['Pop out session twenty', 20],
    ['Pop out session twenty-one', 21],
    ['Pop out session twenty nine', 29],
    ['Pop out session 30', 30],
    ['Pop out session thirty one', 31],
    ['Pop out session thirty-two', 32],
    ['Go to session 32', 32],
    ['Go to session thirty-one', 31],
  ] as const) {
    await f.report({ id: f.one, popouts: [] });
    const request = await f.say(utterance);
    assert.equal(f.outcomes.at(-1), 'selected', utterance);
    assert.equal(request?.id, ids[position - 1], utterance);
    assert.equal(
      request?.presentation,
      utterance.startsWith('Pop out') ? 'window' : undefined,
      utterance,
    );
  }

  for (const utterance of [
    'Pop out session 33',
    'Pop out session thirty-three',
    'Pop out session twenty or one',
    'Pop out session 32 or 2',
    'Pop out session minus twenty one',
    'Pop out session thirty second',
  ]) {
    await f.report({ id: f.one, popouts: [] });
    assert.equal(await f.say(utterance), undefined, utterance);
    assert.equal(f.outcomes.at(-1), 'skipped', utterance);
  }

  // Captured before the order changed: refused, nothing sent.
  await f.report({ id: f.one, popouts: [] });
  const stale = f.current();
  const order = f.sessions.order();
  f.sessions.move(order.ids[31], order.ids[0], order.revision);
  assert.equal(await f.say('Pop out session thirty-two', stale), undefined);
  assert.equal(f.outcomes.at(-1), 'skipped');
  assert.equal(f.sessions.snapshot().length, 32, 'navigation never creates conversations');
});

test('pop out session N is refused clearly when the target or a pop-out host is unavailable', async (context) => {
  const f = await fixture(context);

  // Out of range or ambiguous: skipped, nothing sent.
  await f.report({ id: f.one, popouts: [] });
  assert.equal(await f.say('Pop out session seven'), undefined);
  assert.equal(f.outcomes.at(-1), 'skipped');
  assert.equal(await f.say('Pop out session'), undefined);
  assert.equal(f.outcomes.at(-1), 'skipped');

  // A UI without pop-out windows (portable panel): the command is not
  // offered, and the shortcut is consumed rather than sent as text.
  await f.report({ id: f.one, popoutHost: false });
  assert.equal(f.current().agentNavigation?.popoutHost, false);
  const before = f.requests.length;
  assert.equal(await f.say('Pop out session two'), undefined);
  assert.equal(f.outcomes.at(-1), 'skipped');
  assert.equal(f.requests.length, before);

  // Directly asking the runtime on behalf of such a UI is refused too.
  assert.equal(f.activity.popOutSession!(f.current(), 1), false);
});

test('closing or returning the chosen inactive window ends the choice (R1-2)', async (context) => {
  const f = await fixture(context);
  // Sidebar shows one; window three is active, window two visible behind it.
  await f.report({ id: f.one, popouts: [window(f.three, true, true), window(f.two)] });
  assert.equal(f.current().agentSessionId, f.three);
  // Two is already shown: the choice takes effect at once.
  await f.say('Go to session two');
  assert.equal(f.current().agentSessionId, f.two);
  assert.equal(f.current().agentTargetSource, 'navigation');
  // Window two returns to the sidebar without being selected there.
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  assert.equal(
    f.current().agentSessionId,
    f.three,
    'a conversation no longer shown is not the target',
  );
  assert.equal(f.current().agentTargetSource, 'popout');
});

test('a refused or not-yet-shown navigation keeps the choice in effect (R1-3)', async (context) => {
  const f = await fixture(context);
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  // "Go to session one": already shown, in effect at once.
  await f.say('Go to session one');
  assert.equal(f.current().agentSessionId, f.one);
  assert.equal(f.current().agentTargetSource, 'navigation');

  // "Pop out session one" is refused by the UI (a send still being
  // confirmed): no view changes; the UI renews its navigation token.
  const request = await f.say('Pop out session one');
  assert.equal(request?.presentation, 'window');
  assert.equal(f.current().agentSessionId, f.one, 'pending request: the choice in effect stays');
  await f.report({ id: f.one, popouts: [window(f.three, true, true)] });
  assert.equal(f.current().agentSessionId, f.one, 'refused: still the earlier choice');
  assert.equal(f.current().agentTargetSource, 'navigation');
  // The dropped request cannot take effect later when the person pops one
  // out by hand; that window's own focus decides as usual.
  await f.report({
    id: '',
    rail: 'compact',
    popouts: [window(f.three), window(f.one, true, true)],
  });
  assert.equal(f.current().agentSessionId, f.one);
  assert.equal(f.current().agentTargetSource, 'popout');

  // A successful second navigation replaces the first only once shown.
  await f.report({ id: f.two, popouts: [window(f.three, true, true), window(f.one)] });
  await f.say('Go to session two');
  assert.equal(f.current().agentSessionId, f.two);
  await f.say('Pop out session two');
  assert.equal(f.current().agentSessionId, f.two, 'until shown, the earlier choice stays');
  await f.report({
    id: '',
    rail: 'compact',
    popouts: [window(f.three, true, true), window(f.one), window(f.two)],
  });
  assert.equal(f.current().agentSessionId, f.two);
  assert.equal(f.current().agentTargetSource, 'navigation');
});
