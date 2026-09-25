import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultAgentSettings, defaultClaudeCodeSettings } from '../../src/agents/settings.ts';
import type { ClaudeCodeSettings } from '../../src/agents/types.ts';
import { frame, signal } from '../helpers.ts';
import { callTool, harnessFixture, toolRefusal, type HarnessRun } from '../harness-fixture.ts';

const claudeDefault = {
  ...defaultAgentSettings,
  codingDefaultHarness: 'claude-code',
  claudeCode: { model: 'claude-sonnet-5', effort: 'low' },
};

/**
 * Run one sender turn whose script performs the tool calls, and return what
 * the script produced. The sender is a Pi conversation unless `harness` says
 * otherwise; session tools behave the same for both.
 */
async function fromSender<T>(
  fixture: Awaited<ReturnType<typeof harnessFixture>>,
  body: (run: HarnessRun) => Promise<T>,
  harness: 'pi' | 'claude-code' = 'pi',
): Promise<T> {
  const sender = fixture.sessions.start(frame, signal(), 'coding', harness);
  let result: T | undefined;
  fixture.script(sender, async (run) => {
    result = await body(run);
  });
  // `idle` waits for the conversations open when called; a second call also
  // waits for conversations the sender's tools started meanwhile.
  await fixture.sessions.idle();
  await fixture.sessions.idle();
  return result as T;
}

test('session_start with harness claude-code captures the requested Claude model', async (context) => {
  const fixture = await harnessFixture(context);
  const started = await fromSender(fixture, (run) =>
    callTool(run, 'companion_session_start', {
      text: 'Review this',
      harness: 'claude-code',
      model: 'claude-sonnet-5',
    }),
  );
  const session = started.session as Record<string, unknown>;
  assert.equal(session.harness, 'claude-code');
  assert.equal(session.model, 'claude-sonnet-5');
  assert.equal(session.profile, 'coding');
  assert.equal('modelOverride' in session, false);

  const id = session.id as string;
  const run = fixture.runs.find((entry) => entry.id === id);
  assert.equal(run?.harness, 'claude-code');
  assert.deepEqual(run?.settings, {
    ...defaultClaudeCodeSettings,
    model: 'claude-sonnet-5',
  } satisfies ClaudeCodeSettings);
  assert.deepEqual(fixture.view(id).claudeCode, {
    model: 'claude-sonnet-5',
    effort: defaultClaudeCodeSettings.effort,
  });
  assert.equal(fixture.view(id).messages[0].origin?.kind, 'agent');
});

test('session_start without harness uses the coding default and its configured model', async (context) => {
  const fixture = await harnessFixture(context, { configuration: claudeDefault });
  const [coding, quick] = await fromSender(fixture, async (run) => [
    await callTool(run, 'companion_session_start', { text: 'Coding' }),
    await callTool(run, 'companion_session_start', { text: 'Quick', profile: 'quickQuestion' }),
  ]);

  const codingSession = coding.session as Record<string, unknown>;
  assert.equal(codingSession.harness, 'claude-code');
  assert.equal(codingSession.model, 'claude-sonnet-5');
  const quickSession = quick.session as Record<string, unknown>;
  assert.equal(quickSession.harness, 'pi');

  const codingRun = fixture.runs.find((entry) => entry.id === codingSession.id);
  assert.deepEqual(codingRun?.settings, {
    executable: defaultClaudeCodeSettings.executable,
    model: 'claude-sonnet-5',
    effort: 'low',
  });
  const quickRun = fixture.runs.find((entry) => entry.id === quickSession.id);
  assert.equal(quickRun?.harness, 'pi');
});

test('session_start refuses malformed or unavailable models before creating a tab', async (context) => {
  const fixture = await harnessFixture(context, { configuration: claudeDefault });
  const refusals = await fromSender(
    fixture,
    async (run) => [
      await toolRefusal(run, 'companion_session_start', {
        text: 'A',
        harness: 'claude-code',
        model: 'anthropic/claude-opus-5-5',
      }),
      await toolRefusal(run, 'companion_session_start', {
        text: 'B',
        harness: 'claude-code',
        model: '--dangerously',
      }),
      await toolRefusal(run, 'companion_session_start', {
        text: 'C',
        harness: 'claude-code',
        model: 'claude opus',
      }),
      // Without a harness the Claude Code default applies, so Pi's form is wrong.
      await toolRefusal(run, 'companion_session_start', { text: 'D', model: 'configured/one' }),
      await toolRefusal(run, 'companion_session_start', {
        text: 'E',
        harness: 'pi',
        model: 'claude-opus-5-5',
      }),
      await toolRefusal(run, 'companion_session_start', {
        text: 'F',
        harness: 'pi',
        model: 'invented/model',
      }),
    ],
    'pi',
  );

  for (const refusal of refusals.slice(0, 5)) {
    assert.match(refusal, /\[invalid\]$/);
  }
  assert.match(refusals[0], /Claude model ID/);
  assert.match(refusals[4], /provider\/model/);
  assert.match(refusals[5], /not available in Pi.*\[unavailable-model\]$/);

  // Only the sender's own tab exists; no refused request left a tab behind.
  assert.equal(fixture.sessions.snapshot().length, 1);
  assert.equal(fixture.runs.length, 1);
});

test('session_start validates the harness and refuses a Claude Code quick question', async (context) => {
  const fixture = await harnessFixture(context);
  const refusals = await fromSender(fixture, async (run) => [
    await toolRefusal(run, 'companion_session_start', { text: 'A', harness: 'codex' }),
    await toolRefusal(run, 'companion_session_start', {
      text: 'B',
      harness: 'claude-code',
      profile: 'quickQuestion',
    }),
  ]);
  assert.match(refusals[0], /\[invalid\]$/);
  assert.match(refusals[1], /Quick questions always use Pi.*\[invalid\]$/);
  assert.equal(fixture.sessions.snapshot().length, 1);
});

test('session_start with harness pi keeps Pi catalog validation and model override', async (context) => {
  const fixture = await harnessFixture(context, { configuration: claudeDefault });
  const started = await fromSender(fixture, (run) =>
    callTool(run, 'companion_session_start', {
      text: 'Pi please',
      harness: 'pi',
      model: 'configured/two',
    }),
  );
  const session = started.session as Record<string, unknown>;
  assert.equal(session.harness, 'pi');
  assert.equal(session.modelOverride, 'configured/two');
  const run = fixture.runs.find((entry) => entry.id === session.id);
  assert.equal(run?.harness, 'pi');
  assert.equal(run?.settings.model, 'configured/two');
});

test('Claude Code conversations list, receive messages and close through session tools', async (context) => {
  const fixture = await harnessFixture(context);
  const claude = fixture.sessions.start(frame, signal(), 'coding', 'claude-code');
  await fixture.sessions.idle();

  const [listed, sent] = await fromSender(fixture, async (run) => [
    await callTool(run, 'companion_sessions', {}),
    await callTool(run, 'companion_session_send', { id: claude, text: 'From Pi' }),
  ]);
  const open = listed.open as Record<string, unknown>[];
  const claudeSummary = open.find((entry) => entry.id === claude);
  assert.equal(claudeSummary?.harness, 'claude-code');
  assert.equal(claudeSummary?.model, defaultClaudeCodeSettings.model);
  assert.equal(open.find((entry) => entry.self)?.harness, 'pi');
  assert.equal(sent.outcome, 'started');
  await fixture.sessions.idle();

  // The provenance header reaches Claude Code exactly as it reaches Pi.
  const delivered = fixture.runs.filter((entry) => entry.id === claude).at(-1);
  assert.equal(delivered?.harness, 'claude-code');
  assert.match(delivered?.text ?? '', /^\[Companion agent message\]/);
  assert.equal(delivered?.resume, true);

  // A Claude Code sender uses the same tools; closing archives the harness.
  const closed = await fromSender(
    fixture,
    (run) => callTool(run, 'companion_session_close', { id: claude }),
    'claude-code',
  );
  assert.equal(closed.outcome, 'closed');
  const previous = fixture.sessions.previousSnapshot().find((entry) => entry.id === claude);
  assert.equal(previous?.harness, 'claude-code');

  const reopened = await fromSender(fixture, (run) =>
    callTool(run, 'companion_session_reopen', { id: claude }),
  );
  assert.equal((reopened.session as Record<string, unknown>).harness, 'claude-code');
});
