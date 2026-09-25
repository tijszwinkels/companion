import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultAgentSettings } from '../../src/agents/settings.ts';
import type { AgentSessions } from '../../src/agents/sessions.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { QuickQuestion } from '../../src/processors/quick-question.ts';
import { StartClaudeCodeSession } from '../../src/processors/start-claude-code-session.ts';
import { StartCodingAgentSession } from '../../src/processors/start-coding-agent-session.ts';
import { StartPiSession } from '../../src/processors/start-pi-session.ts';
import { frame, signal, testDetector } from '../helpers.ts';
import { harnessFixture } from '../harness-fixture.ts';

const claudeDefault = {
  ...defaultAgentSettings,
  codingDefaultHarness: 'claude-code',
  claudeCode: { model: 'claude-sonnet-5', effort: 'medium' },
};

/** The production start processors, with a detector that can pick the generic one. */
function router(sessions: AgentSessions, inferred: string[] = []) {
  const router = new UserSensorRouter(
    {
      detector: testDetector({
        detect: async () => {
          const name = inferred.shift();
          assert.ok(name, 'A prefix reached inference');
          return name;
        },
      }),
    },
    () => {},
  );
  new Ignore(() => {}).subscribe(router);
  new StartCodingAgentSession({ sessions }, () => {}).subscribe(router);
  new QuickQuestion({ sessions }, () => {}).subscribe(router);
  new StartClaudeCodeSession({ sessions }, () => {}).subscribe(router);
  new StartPiSession({ sessions }, () => {}).subscribe(router);
  return router;
}

for (const codingDefaultHarness of ['pi', 'claude-code'] as const) {
  test(`start phrasings select their harness when the coding default is ${codingDefaultHarness}`, async (context) => {
    const { sessions, runs } = await harnessFixture(context, {
      configuration: { ...claudeDefault, codingDefaultHarness },
    });
    // The retired "new codex session" wording is no shortcut any more: it
    // reaches inference like any other utterance (here the generic intent).
    const inferred = ['START_CODING_AGENT_SESSION', 'START_CODING_AGENT_SESSION'];
    const routes = router(sessions, inferred);

    const cases = [
      ['new claude session: Explain this', 'START_CLAUDE_CODE_SESSION', 'claude-code'],
      ['New Pi session, explain this', 'START_PI_SESSION', 'pi'],
      ['new session explain this', 'START_CODING_AGENT_SESSION', codingDefaultHarness],
      ['Could you explain this', 'START_CODING_AGENT_SESSION', codingDefaultHarness],
      ['new codex session explain this', 'START_CODING_AGENT_SESSION', codingDefaultHarness],
    ] as const;
    for (const [utterance, intent, harness] of cases) {
      assert.equal(await routes.route({ ...frame, utterance }, signal()), intent, utterance);
      await sessions.idle();

      const run = runs.at(-1);
      assert.equal(run?.harness, harness, utterance);
      // The speech-end screenshot accompanies every phrasing.
      assert.equal(run?.screenshot, true, utterance);
      if (harness === 'claude-code') {
        assert.equal(run?.settings.model, 'claude-sonnet-5', utterance);
      } else {
        // "new pi session" is Pi with its configured coding model.
        assert.equal(run?.settings.model, defaultAgentSettings.model, utterance);
      }
    }
    assert.equal(runs.length, cases.length);
    assert.equal(runs[0].text, 'Explain this');
    assert.equal(runs[1].text, 'explain this');
    assert.equal(runs[4].text, 'new codex session explain this', 'no prefix was stripped');
    assert.equal(inferred.length, 0);
  });
}

test('the new prefixes are prefix-only, keep priority and have independent switches', async (context) => {
  const { sessions, runs } = await harnessFixture(context);
  const routes = router(sessions);

  assert.deepEqual(routes.reservedPrefixes().toSorted(), [
    'new claude session',
    'new pi session',
    'new session',
    'quick question',
  ]);
  for (const name of ['START_CLAUDE_CODE_SESSION', 'START_PI_SESSION']) {
    const state = routes.intentStates().find((intent) => intent.name === name);
    assert.equal(state?.supportsInference, false, name);
    assert.equal(state?.toggleable, true, name);
  }
  assert.equal(
    routes.intentStates().find((intent) => intent.name === 'START_CODING_AGENT_SESSION')
      ?.supportsInference,
    true,
  );

  // "new session" is literal: it never captures the longer phrasings, and a
  // following word is ordinary payload for the generic session.
  assert.equal(
    await routes.route({ ...frame, utterance: 'new session claude, explain' }, signal()),
    'START_CODING_AGENT_SESSION',
  );
  await sessions.idle();
  assert.equal(runs.at(-1)?.harness, 'pi');
  assert.equal(runs.at(-1)?.text, 'claude, explain');

  // A switched-off shortcut is consumed, not reinterpreted by "new session"
  // or inference, and switching off the generic intent leaves the others.
  routes.setEnabled('START_CLAUDE_CODE_SESSION', false, 'shortcut');
  routes.setEnabled('START_CODING_AGENT_SESSION', false);
  const count = runs.length;
  assert.equal(
    await routes.route({ ...frame, utterance: 'new claude session explain' }, signal()),
    'START_CLAUDE_CODE_SESSION',
  );
  assert.equal(
    await routes.route({ ...frame, utterance: 'new session explain' }, signal()),
    'START_CODING_AGENT_SESSION',
  );
  await sessions.idle();
  assert.equal(runs.length, count);
  assert.equal(sessions.snapshot().length, 1);

  assert.equal(
    await routes.route({ ...frame, utterance: 'new pi session explain' }, signal()),
    'START_PI_SESSION',
  );
  await sessions.idle();
  assert.equal(runs.length, count + 1);
  assert.equal(runs.at(-1)?.harness, 'pi');

  // Bare prefixes create nothing.
  await routes.route({ ...frame, utterance: 'new pi session' }, signal());
  routes.setEnabled('START_CLAUDE_CODE_SESSION', true, 'shortcut');
  await routes.route({ ...frame, utterance: 'new claude session' }, signal());
  await sessions.idle();
  assert.equal(runs.length, count + 1);
});

test('preview names the harness without starting a conversation', async (context) => {
  const { sessions, runs } = await harnessFixture(context);
  const logged: string[] = [];
  const log = (_stage: string, detail: string) => {
    logged.push(detail);
  };
  const claude = new StartClaudeCodeSession({ sessions }, log, true);
  const pi = new StartPiSession({ sessions }, log, true);
  const generic = new StartCodingAgentSession({ sessions }, log, true);
  const quick = new QuickQuestion({ sessions }, log, true);
  for (const processor of [claude, pi, generic, quick]) {
    await processor.process({ ...frame, utterance: 'Explain' }, signal());
  }

  assert.deepEqual(logged, [
    'Would ask Claude Code (coding): Explain',
    'Would ask Pi (coding): Explain',
    'Would ask the configured coding harness (coding): Explain',
    'Would ask Pi (quickQuestion): Explain',
  ]);
  assert.equal(sessions.snapshot().length, 0);
  assert.equal(runs.length, 0);
});
