import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  HarnessLiveStateReporter,
  parseAgentHarnessUrl,
  type LiveStateTransport,
  type SessionLiveState,
} from '../../src/agents/harness-live-state.ts';
import registerLiveStateOwner, {
  liveStateOwnerEntryType,
} from '../../src/agents/live-state-owner-extension.ts';
import { deferred, frame, signal } from '../helpers.ts';
import { harnessFixture } from '../harness-fixture.ts';
import { waitFor } from '../desktop-fixture.ts';
import { defaultAgentSettings } from '../../src/agents/settings.ts';

// ---------------------------------------------------------------------------
// Reporter with a fake transport. Nothing listens on the network.
// ---------------------------------------------------------------------------

interface SentRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A fake transport that records each request and answers with the next
 * scripted status (200 when the script is empty; 0 means "no response").
 * `hold()` makes the next request wait until the test releases it.
 */
function fakeHarness() {
  const sent: SentRequest[] = [];
  const statuses: number[] = [];
  let held: ReturnType<typeof deferred<void>> | undefined;

  const transport: LiveStateTransport = async (url, body) => {
    sent.push({ url, body: JSON.parse(body) as Record<string, unknown> });
    const gate = held;
    held = undefined;
    if (gate) {
      await gate.promise;
    }
    return statuses.shift() ?? 200;
  };

  return {
    sent,
    transport,
    respond(...codes: number[]) {
      statuses.push(...codes);
    },
    hold() {
      held = deferred<void>();
      return held;
    },
    states() {
      return sent.map((request) => request.body.state);
    },
  };
}

function reporter(
  harness: ReturnType<typeof fakeHarness>,
  logs: string[] = [],
  heartbeatMs = 40,
  idleRetryDelaysMs = [20, 20, 20],
) {
  return new HarnessLiveStateReporter({
    url: 'http://127.0.0.1:8877',
    log: (_component, message) => logs.push(message),
    heartbeatMs,
    leaseSeconds: 45,
    requestTimeoutMs: 500,
    closeTimeoutMs: 300,
    idleRetryDelaysMs,
    transport: harness.transport,
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

  assert.deepEqual(harness.states(), ['busy', 'idle'], 'only the latest state follows');
});

test('an unreachable harness never throws and is logged once per outage', async () => {
  const harness = fakeHarness();
  const logs: string[] = [];
  const live = reporter(harness, logs);

  harness.respond(0, 0);
  assert.doesNotThrow(() => live.update('conversation', true, HARNESS_ID));
  await waitFor(() => harness.sent.length >= 3);
  await live.close();

  const failures = logs.filter((line) => line.includes('unreachable'));
  assert.equal(failures.length, 1, `logged once: ${logs.join(' | ')}`);
  assert.ok(logs.some((line) => line.includes('accepts live state again')));
});

test('a 404/409 before the harness knows the conversation is quiet and retried', async () => {
  const harness = fakeHarness();
  const logs: string[] = [];
  const live = reporter(harness, logs);

  harness.respond(404, 409);
  live.update('conversation', true, HARNESS_ID);
  await waitFor(() => harness.sent.length >= 3);
  live.update('conversation', false, HARNESS_ID);
  await waitFor(() => harness.sent.at(-1)?.body.state === 'idle');
  await live.close();

  assert.equal(logs.length, 0, '404/409 are expected, not errors');
});

test('the final idle is sent even though busy was never acknowledged (short turn)', async () => {
  // Review finding: busy → 404 (transcript not written yet); the harness then
  // discovers the conversation; the turn ends before the next heartbeat.
  const harness = fakeHarness();
  const live = reporter(harness, [], 10_000);

  harness.respond(404);
  live.update('conversation', true, HARNESS_ID);
  await waitFor(() => harness.sent.length === 1);
  await delay(10);
  live.update('conversation', false, HARNESS_ID);
  await waitFor(() => harness.sent.length === 2);
  await live.close();

  assert.deepEqual(harness.states(), ['busy', 'idle']);
});

test('an undelivered idle is retried a bounded number of times', async () => {
  const harness = fakeHarness();
  const live = reporter(harness, [], 10_000, [20, 20]);

  live.update('conversation', true, HARNESS_ID);
  await waitFor(() => harness.sent.length === 1);
  harness.respond(0, 404, 0, 0);
  live.update('conversation', false, HARNESS_ID);
  await delay(200);
  await live.close();

  // One attempt plus two retries, then the harness's lease takes over.
  assert.deepEqual(harness.states(), ['busy', 'idle', 'idle', 'idle']);
});

test('an idle retry stops when the conversation becomes busy again', async () => {
  const harness = fakeHarness();
  const live = reporter(harness, [], 10_000, [60]);

  live.update('conversation', true, HARNESS_ID);
  await waitFor(() => harness.sent.length === 1);
  harness.respond(0);
  live.update('conversation', false, HARNESS_ID);
  await waitFor(() => harness.sent.length === 2);
  live.update('conversation', true, HARNESS_ID);
  await delay(120);
  await live.close();

  assert.deepEqual(harness.states(), ['busy', 'idle', 'busy'], 'no stale idle after the new busy');
});

test('close delivers a final idle coalesced behind a busy in flight', async () => {
  // Review finding: busy in flight → update(false) → close() must not drop the idle.
  const harness = fakeHarness();
  const live = reporter(harness, [], 10_000);

  const gate = harness.hold();
  live.update('conversation', true, HARNESS_ID);
  live.update('conversation', false, HARNESS_ID);
  const closing = live.close();
  gate.resolve();
  await closing;

  assert.deepEqual(harness.states(), ['busy', 'idle']);
});

test('forget ends a busy conversation; close is bounded and stops heartbeats', async () => {
  const harness = fakeHarness();
  const live = reporter(harness);

  live.update('closed-tab', true, HARNESS_ID);
  await waitFor(() => harness.sent.length === 1);
  live.forget('closed-tab');
  await waitFor(() => harness.sent.at(-1)?.body.state === 'idle');

  live.update('other', true, 'ses_' + 'b'.repeat(32));
  await waitFor(() => harness.sent.at(-1)?.body.state === 'busy');
  harness.hold(); // the next request never answers
  await waitFor(() => harness.sent.length >= 4);
  const started = Date.now();
  await live.close();
  assert.ok(Date.now() - started < 1_000, 'close is bounded');
  const count = harness.sent.length;
  await delay(150);
  assert.equal(harness.sent.length, count, 'no heartbeats after close');
  live.update('late', true, HARNESS_ID);
  assert.equal(harness.sent.length, count, 'updates after close are ignored');
});

test('the HTTP transport ignores environment proxies and does not follow redirects', async () => {
  // Real sockets, local only: a target and a "proxy" on loopback ports. The
  // check runs in a child process with NODE_USE_ENV_PROXY and HTTP_PROXY set.
  const hits = { target: 0, proxy: 0, redirected: 0 };
  const target = createServer((request, response) => {
    if (request.url?.startsWith('/redirect')) {
      response.writeHead(302, { location: `http://127.0.0.1:${portOf(target)}/landing` }).end();
      return;
    }
    if (request.url?.startsWith('/landing')) {
      hits.redirected += 1;
    } else {
      hits.target += 1;
    }
    request.resume();
    response.writeHead(200).end('{}');
  });
  const proxy = createServer((request, response) => {
    hits.proxy += 1;
    request.resume();
    response.writeHead(200).end('{}');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

  try {
    const module = new URL('../../src/agents/harness-live-state.ts', import.meta.url).href;
    const script = `
      const { httpTransport } = await import(${JSON.stringify(module)});
      const base = 'http://127.0.0.1:${portOf(target)}';
      const direct = await httpTransport(base + '/v1/sessions/x/live-state', '{}', 2000);
      const redirect = await httpTransport(base + '/redirect', '{}', 2000);
      console.log(JSON.stringify({ direct, redirect }));
    `;
    const proxyUrl = `http://127.0.0.1:${portOf(proxy)}`;
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          env: {
            ...process.env,
            NODE_USE_ENV_PROXY: '1',
            HTTP_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            NO_PROXY: '',
            no_proxy: '',
          },
          timeout: 20_000,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });

    assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1) ?? '{}'), {
      direct: 200,
      redirect: 302,
    });
    assert.deepEqual(hits, { target: 1, proxy: 0, redirected: 0 });
  } finally {
    target.close();
    proxy.close();
  }
});

function portOf(server: ReturnType<typeof createServer>): number {
  return (server.address() as AddressInfo).port;
}

test('the owner extension marks a conversation once', () => {
  const appended: { customType: string; data: unknown }[] = [];
  let handler: ((event: unknown, context: unknown) => void) | undefined;
  const entries: { type?: string; customType?: string }[] = [{ type: 'message' }];
  registerLiveStateOwner({
    on(_event, registered) {
      handler = registered as typeof handler;
    },
    appendEntry(customType, data) {
      appended.push({ customType, data });
      entries.push({ type: 'custom', customType });
    },
  });
  const context = { sessionManager: { getEntries: () => entries } };

  handler?.({}, context);
  handler?.({}, context); // the next Companion turn starts a new Pi process

  assert.deepEqual(appended, [
    { customType: liveStateOwnerEntryType, data: { source: 'companion' } },
  ]);
  assert.equal(liveStateOwnerEntryType, 'agent-harness.live-state-owner');
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
