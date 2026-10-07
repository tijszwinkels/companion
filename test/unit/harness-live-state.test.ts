import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  HarnessLiveStateReporter,
  parseAgentHarnessUrl,
  type SessionLiveState,
} from '../../src/agents/harness-live-state.ts';
import { deferred, frame, signal } from '../helpers.ts';
import { harnessFixture } from '../harness-fixture.ts';
import { waitFor } from '../desktop-fixture.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';

// ---------------------------------------------------------------------------
// Reporter with a fake fetch. Nothing listens on the network.
// ---------------------------------------------------------------------------

interface SentRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

/**
 * A fake `fetch` that records each request and answers with the next scripted
 * status (200 when the script is empty). `hold()` makes the next request wait
 * until the test releases it.
 */
function fakeHarness() {
  const sent: SentRequest[] = [];
  const statuses: number[] = [];
  let held: ReturnType<typeof deferred<void>> | undefined;
  let failNext = false;

  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: String(init?.method),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const gate = held;
    held = undefined;
    if (gate) {
      await gate.promise;
    }
    if (failNext) {
      failNext = false;
      throw Error('connection refused');
    }
    return new Response('{}', { status: statuses.shift() ?? 200 });
  }) as typeof fetch;

  return {
    sent,
    fetch: fetchImplementation,
    respond(...codes: number[]) {
      statuses.push(...codes);
    },
    hold() {
      held = deferred<void>();
      return held;
    },
    failOnce() {
      failNext = true;
    },
  };
}

function reporter(harness: ReturnType<typeof fakeHarness>, logs: string[] = [], heartbeatMs = 40) {
  return new HarnessLiveStateReporter({
    url: 'http://127.0.0.1:8877',
    log: (_component, message) => logs.push(message),
    heartbeatMs,
    leaseSeconds: 45,
    requestTimeoutMs: 500,
    closeTimeoutMs: 100,
    fetch: harness.fetch,
  });
}

const HARNESS_ID = 'ses_0c0f1a2b3c4d4e5f8a9b0c1d2e3f4a5b';

test('busy is sent at once, renewed by heartbeats, and ended by one idle', async () => {
  const harness = fakeHarness();
  const live = reporter(harness);

  live.update('conversation', true, HARNESS_ID);
  await waitFor(() => harness.sent.length >= 3);
  live.update('conversation', false, HARNESS_ID);
  await waitFor(() => harness.sent.at(-1)?.body.state === 'idle');
  const count = harness.sent.length;
  await delay(150);
  await live.close();

  assert.equal(harness.sent.length, count, 'heartbeats stop after idle');
  assert.ok(harness.sent.slice(0, -1).every((request) => request.body.state === 'busy'));
  assert.equal(harness.sent[0].method, 'PUT');
  assert.equal(harness.sent[0].url, `http://127.0.0.1:8877/v1/sessions/${HARNESS_ID}/live-state`);

  const sequences = harness.sent.map((request) => request.body.sequence as number);
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => a - b),
  );
  assert.equal(new Set(sequences).size, sequences.length, 'every request has a new sequence');

  // Metadata only: no prompt, title, path or transcript content.
  assert.deepEqual(Object.keys(harness.sent[0].body).sort(), [
    'lease_seconds',
    'producer',
    'sequence',
    'source',
    'state',
  ]);
  assert.equal(harness.sent[0].body.source, 'companion');
  assert.equal(harness.sent[0].body.lease_seconds, 45);
});

test('non-Pi conversations and idle conversations that were never busy send nothing', async () => {
  const harness = fakeHarness();
  const live = reporter(harness);

  live.update('claude', true, undefined);
  live.update('quiet', false, HARNESS_ID);
  await delay(100);
  await live.close();

  assert.equal(harness.sent.length, 0);
});

test('one request in flight per conversation; changes meanwhile are coalesced', async () => {
  const harness = fakeHarness();
  const live = reporter(harness, [], 10_000);

  const gate = harness.hold();
  live.update('conversation', true, HARNESS_ID);
  live.update('conversation', false, HARNESS_ID);
  live.update('conversation', true, HARNESS_ID);
  live.update('conversation', false, HARNESS_ID);
  assert.equal(harness.sent.length, 1, 'still waiting for the first request');

  gate.resolve();
  await waitFor(() => harness.sent.length === 2);
  await delay(50);
  await live.close();

  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent[0].body.state, 'busy');
  assert.equal(harness.sent[1].body.state, 'idle', 'only the latest state follows');
});

test('an unreachable harness never throws and is logged once per outage', async () => {
  const harness = fakeHarness();
  const logs: string[] = [];
  const live = reporter(harness, logs);

  harness.failOnce();
  assert.doesNotThrow(() => live.update('conversation', true, HARNESS_ID));
  await waitFor(() => harness.sent.length >= 1);
  harness.failOnce();
  await waitFor(() => harness.sent.length >= 2);
  await waitFor(() => harness.sent.length >= 3);
  await live.close();

  const failures = logs.filter((line) => line.includes('unreachable'));
  assert.equal(failures.length, 1, `logged once: ${logs.join(' | ')}`);
  assert.ok(logs.some((line) => line.includes('accepts live state again')));
});

test('a 404 before the harness has seen the transcript is retried by the heartbeat', async () => {
  const harness = fakeHarness();
  const logs: string[] = [];
  const live = reporter(harness, logs);

  harness.respond(404, 404);
  live.update('conversation', true, HARNESS_ID);
  await waitFor(() => harness.sent.length >= 3);
  live.update('conversation', false, HARNESS_ID);
  await waitFor(() => harness.sent.at(-1)?.body.state === 'idle');
  await live.close();

  assert.equal(logs.length, 0, '404 is expected, not an error');
});

test('an idle after only 404s is not sent: the harness never knew it was busy', async () => {
  const harness = fakeHarness();
  const live = reporter(harness, [], 10_000);

  harness.respond(404);
  live.update('conversation', true, HARNESS_ID);
  await waitFor(() => harness.sent.length === 1);
  await delay(20);
  live.update('conversation', false, HARNESS_ID);
  await delay(50);
  await live.close();

  assert.equal(harness.sent.length, 1);
});

test('forget ends a busy conversation; close stops heartbeats without waiting long', async () => {
  const harness = fakeHarness();
  const live = reporter(harness);

  live.update('closed-tab', true, HARNESS_ID);
  await waitFor(() => harness.sent.length === 1);
  live.forget('closed-tab');
  await waitFor(() => harness.sent.at(-1)?.body.state === 'idle');

  live.update('other', true, 'ses_' + 'b'.repeat(32));
  await waitFor(() => harness.sent.at(-1)?.body.state === 'busy');
  harness.hold(); // the next request never answers
  const started = Date.now();
  await live.close();
  assert.ok(Date.now() - started < 1_000, 'close is bounded');
  const count = harness.sent.length;
  await delay(150);
  assert.equal(harness.sent.length, count, 'no heartbeats after close');
  live.update('late', true, HARNESS_ID);
  assert.equal(harness.sent.length, count, 'updates after close are ignored');
});

test('only loopback http URLs are accepted', () => {
  assert.equal(parseAgentHarnessUrl('http://127.0.0.1:8877'), 'http://127.0.0.1:8877');
  assert.equal(parseAgentHarnessUrl('http://localhost:18877/'), 'http://localhost:18877');
  assert.equal(parseAgentHarnessUrl('http://[::1]:8877'), 'http://[::1]:8877');
  for (const bad of [
    'https://127.0.0.1:8877',
    'http://192.0.2.1:8877',
    'http://example.com',
    'http://user:pw@127.0.0.1:8877',
    'http://127.0.0.1:8877/v1',
    'http://127.0.0.1:8877/?x=1',
    'not a url',
  ]) {
    assert.throws(() => parseAgentHarnessUrl(bad), /agent-harness-url/, bad);
  }
});

// ---------------------------------------------------------------------------
// AgentSessions → reporter: busy follows Companion's own turn lifecycle.
// ---------------------------------------------------------------------------

/** Records every call AgentSessions makes, as busy transitions per id. */
function recordingSink() {
  const calls: { id: string; busy: boolean; harnessSessionId: string | undefined }[] = [];
  const forgotten: string[] = [];
  const sink: SessionLiveState = {
    update(id, busy, harnessSessionId) {
      calls.push({ id, busy, harnessSessionId });
    },
    forget(id) {
      forgotten.push(id);
    },
    async close() {},
  };

  /** Busy values for one conversation, with repeats collapsed. */
  function transitions(id: string): boolean[] {
    const values: boolean[] = [];
    for (const call of calls) {
      if (call.id === id && call.harnessSessionId !== undefined && values.at(-1) !== call.busy) {
        values.push(call.busy);
      }
    }
    return values;
  }

  return { sink, calls, forgotten, transitions };
}

test('a Pi turn is busy until it has settled, under its harness session id', async (context) => {
  const live = recordingSink();
  const { sessions, script } = await harnessFixture(context, { liveState: live.sink });
  const answer = deferred<void>();
  let checkedWhileRunning = false;

  const id = sessions.start(frame, signal());
  script(id, async () => {
    // Pi is "thinking": the conversation must be reported busy now.
    assert.equal(live.transitions(id).at(-1), true);
    checkedWhileRunning = true;
    await answer.promise;
  });
  await waitFor(() => checkedWhileRunning);
  answer.resolve();
  await sessions.idle();

  assert.deepEqual(live.transitions(id), [true, false]);
  const harnessIds = new Set(
    live.calls.filter((call) => call.id === id).map((call) => call.harnessSessionId),
  );
  harnessIds.delete(undefined);
  assert.deepEqual([...harnessIds], ['ses_' + id.replaceAll('-', '')]);
});

test('a queued follow-up keeps the conversation busy without an idle gap', async (context) => {
  const live = recordingSink();
  const { sessions, script } = await harnessFixture(context, { liveState: live.sink });
  const first = deferred<void>();

  const id = sessions.start(frame, signal());
  script(id, async () => first.promise);
  await waitFor(() => live.transitions(id).at(-1) === true);
  sessions.followUp(id, 'And then?', signal());
  first.resolve();
  await sessions.idle();

  assert.deepEqual(live.transitions(id), [true, false], 'one busy period across both turns');
});

test('failed and stopped turns end busy', async (context) => {
  const live = recordingSink();
  const { sessions, script } = await harnessFixture(context, { liveState: live.sink });

  const failing = sessions.start(frame, signal());
  script(failing, async () => {
    throw Error('synthetic Pi failure');
  });
  await sessions.idle();
  assert.deepEqual(live.transitions(failing), [true, false]);

  const stopped = sessions.start(frame, signal());
  const never = deferred<void>();
  script(stopped, async (run) => {
    await Promise.race([
      never.promise,
      new Promise((resolve) => run.signal.addEventListener('abort', resolve)),
    ]);
  });
  await waitFor(() => live.transitions(stopped).at(-1) === true);
  await sessions.stop(stopped);
  await sessions.idle();
  assert.deepEqual(live.transitions(stopped), [true, false]);
});

test('Claude Code conversations are not reported; closing a tab forgets it', async (context) => {
  const live = recordingSink();
  const { sessions } = await harnessFixture(context, {
    liveState: live.sink,
    configuration: {
      ...defaultAgentSettings,
      codingDefaultHarness: 'claude-code',
      claudeCode: { executable: '/opt/claude', model: 'claude-sonnet-5', effort: 'medium' },
    },
  });

  const claude = sessions.start(frame, signal());
  await sessions.idle();
  assert.ok(
    live.calls
      .filter((call) => call.id === claude)
      .every((call) => call.harnessSessionId === undefined),
  );

  const pi = sessions.start(frame, signal(), 'coding', 'pi');
  await sessions.idle();
  assert.deepEqual(live.transitions(pi), [true, false]);
  await sessions.remove(pi);
  assert.deepEqual(live.forgotten, [pi]);
});
