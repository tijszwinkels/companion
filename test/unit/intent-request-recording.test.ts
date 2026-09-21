import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { IntentDetector, buildPrompt } from '../../src/core/intent-detector.ts';
import { restoreIntentRequest, snapshotIntentRequest } from '../../src/core/intent-request.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { UtteranceHistory } from '../../src/desktop/history.ts';
import { artifactPath } from '../../src/desktop/artifacts.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import { frame, screenshot, signal } from '../helpers.ts';

/** Real provider serialization and SQLite, with synthetic inputs and local SSE. */
async function fixture(reply = 'IGNORE', status = 200) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-intent-request-'));
  const path = join(directory, 'utterances.sqlite');
  const history = new UtteranceHistory(path);
  await history.open();
  const database = new DatabaseSync(path);
  const received: { body: unknown; recorded: string | null }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    const row = database
      .prepare('SELECT intent_request FROM utterances ORDER BY rowid DESC LIMIT 1')
      .get()!;
    received.push({ body: JSON.parse(body), recorded: row.intent_request as string | null });
    response.writeHead(status, {
      'content-type': status === 200 ? 'text/event-stream' : 'application/json',
    });
    if (status !== 200) {
      response.end(JSON.stringify({ error: { message: 'Fixture provider failure' } }));
      return;
    }
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    model: 'synthetic-eval-model',
    timeoutMs: 2000,
  };
  return {
    history,
    database,
    directory,
    config,
    received,
    async seed(id = frame.id) {
      history.add({ ...frame, id });
      await history.saveScreenshot(id, screenshot);
      return history.snapshot()[0].id;
    },
    record: (id: number, request: string) => history.saveIntentRequest(id, request),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      history.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const intents = [
  { name: 'IGNORE', instruction: 'Exact instruction.  Keep spacing.\nKeep the newline.' },
  {
    name: 'CHOOSE_AGENT_OPTION_1',
    instruction: 'Choose the open agent\'s option "Yes": "Apply the change".',
  },
];

test('stored request restores the complete real provider body and its dynamic conversation before transport', async (context) => {
  const setup = await fixture();
  context.after(setup.close);
  const id = await setup.seed();
  const detector = new IntentDetector(setup.config, undefined, 'detector', {
    intentRequested: setup.record,
  });
  const input = {
    ...frame,
    utterance: 'An image_url or artifact placeholder in text is just text. 🌱',
    interaction: {
      agentSessionId: 'captured-conversation',
      agentComposerFocused: false,
      revision: 42,
      agentConversation: {
        title: 'Captured title 🌱',
        titleTruncated: false,
        totalMessages: 6,
        messages: [1, 2, 5, 6].map((position) => ({
          position,
          role: 'user' as const,
          state: 'done' as const,
          text: `Original message ${position}`,
          truncated: false,
        })),
      },
    },
  };
  assert.equal(await detector.detect(input, intents, signal()), 'IGNORE');
  const saved = setup.received[0].recorded;
  assert.ok(saved, 'SQLite must already contain the snapshot when HTTP arrives');
  const record = JSON.parse(saved);
  assert.equal(record.version, 1);
  assert.equal(record.baseUrl, setup.config.baseUrl);
  assert.equal(record.body.model, setup.config.model);
  assert.equal(record.body.temperature, 0);
  assert.equal(record.body.max_tokens, 32);
  assert.equal(record.body.chat_template_kwargs.enable_thinking, false);
  assert.equal(record.body.messages[0].content, buildPrompt(intents));
  assert.deepEqual(
    record.body.messages.map((message: { role: string }) => message.role),
    ['system', 'user'],
  );
  const user = JSON.parse(record.body.messages[1].content[0].text);
  assert.equal(user.utterance, input.utterance);
  assert.deepEqual(user.interaction.agentConversation, input.interaction.agentConversation);
  assert.equal(user.interaction.revision, undefined);
  const reference = record.body.messages[1].content[1].image_url.url;
  assert.equal(reference.artifact, 'utterance-screenshot');
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  assert.equal(saved.includes(screenshot.png.toString('base64')), false);
  const png = await readFile(artifactPath(setup.directory, id, frame.observedAt, 'screenshots'));
  assert.deepEqual(restoreIntentRequest(saved, png).body, setup.received[0].body);

  // Later state, labels and reopening must not rewrite the captured example.
  input.interaction.agentConversation.title = 'New title';
  input.interaction.agentConversation.messages[0].text = 'Later changed text';
  setup.history.setIntent(frame.id, 'IGNORE');
  setup.history.setOutcome(frame.id, 'ignored');
  setup.history.finish(frame.id);
  setup.history.label(id, false, 'SEND_TEXT_TO_APPLICATION');
  setup.history.close();
  await setup.history.open();
  assert.equal(
    setup.database.prepare('SELECT intent_request FROM utterances WHERE id = ?').get(id)
      ?.intent_request,
    saved,
  );
  assert.equal(
    'intent_request' in setup.history.snapshot()[0],
    false,
    'Prompt data is not broadcast in ordinary history snapshots',
  );
});

for (const [reply, status] of [
  ['UNKNOWN', 200],
  ['', 503],
] as const) {
  test(`failed classification still retains its prepared request (${status}, ${reply})`, async (context) => {
    const setup = await fixture(reply, status);
    context.after(setup.close);
    await setup.seed();
    const detector = new IntentDetector(setup.config, undefined, 'detector', {
      intentRequested: setup.record,
    });
    await assert.rejects(detector.detect(frame, intents, signal()));
    assert.equal(setup.received.length, 1);
    assert.ok(setup.received[0].recorded);
    assert.deepEqual(
      restoreIntentRequest(setup.received[0].recorded!, screenshot.png).body,
      setup.received[0].body,
    );
  });
}

test('recording failure prevents HTTP and the first snapshot cannot be overwritten', async (context) => {
  const setup = await fixture();
  context.after(setup.close);
  await setup.seed();
  setup.database.exec(
    "CREATE TRIGGER reject_request BEFORE UPDATE OF intent_request ON utterances BEGIN SELECT RAISE(ABORT, 'Fixture recording failure'); END",
  );
  const detector = new IntentDetector(setup.config, undefined, 'detector', {
    intentRequested: setup.record,
  });
  await assert.rejects(detector.detect(frame, intents, signal()), /Fixture recording failure/);
  assert.equal(setup.received.length, 0);
  setup.database.exec('DROP TRIGGER reject_request');
  await detector.detect(frame, intents, signal());
  const first = setup.received[0].recorded;
  await assert.rejects(detector.detect(frame, intents, signal()), /already recorded/);
  assert.equal(setup.received.length, 1);
  assert.equal(
    setup.database.prepare('SELECT intent_request FROM utterances').get()?.intent_request,
    first,
  );
});

test('permanent prefixes, exact choices and pre-aborted frames do not invent request snapshots', async (context) => {
  const setup = await fixture();
  context.after(setup.close);
  await setup.seed();
  const detector = new IntentDetector(setup.config, undefined, 'detector', {
    intentRequested: setup.record,
  });
  const router = new UserSensorRouter({ detector }, () => {});
  new SendTextToApplication(() => {}, true).subscribe(router);
  new Ignore(() => {}).subscribe(router);
  router.registerScoped(() => [
    {
      name: 'CHOOSE_AGENT_OPTION_1',
      exactUtterance: 'Yes',
      instruction: 'Choose yes',
      process: async () => {},
    },
  ]);
  assert.equal(
    await router.route({ ...frame, utterance: 'insert example text' }, signal()),
    'SEND_TEXT_TO_APPLICATION',
  );
  assert.equal(
    await router.route({ ...frame, utterance: 'Yes' }, signal()),
    'CHOOSE_AGENT_OPTION_1',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(detector.detect(frame, intents, controller.signal));
  assert.equal(setup.received.length, 0);
  assert.equal(
    setup.database.prepare('SELECT intent_request FROM utterances').get()?.intent_request,
    null,
  );
});

test('version-four migration preserves old labels and starts with unknown request evidence', async (context) => {
  const setup = await fixture();
  context.after(setup.close);
  const id = await setup.seed();
  setup.history.setIntent(frame.id, 'IGNORE');
  setup.history.setOutcome(frame.id, 'ignored');
  setup.history.finish(frame.id);
  setup.history.label(id, true);
  setup.history.close();
  setup.database.exec(
    'ALTER TABLE utterances DROP COLUMN intent_request; PRAGMA user_version = 4;',
  );
  await setup.history.open();
  assert.equal(setup.database.prepare('PRAGMA user_version').get()?.user_version, 5);
  assert.equal(
    setup.database.prepare('SELECT intent_request FROM utterances WHERE id = ?').get(id)
      ?.intent_request,
    null,
  );
  assert.equal(setup.history.find(id)?.utterance, frame.utterance);
  assert.equal(setup.history.feedback(id).correct, true);
  assert.throws(() => setup.history.saveIntentRequest(frame.id, '{}'), /No active utterance/);
  setup.history.close();
  await setup.history.open();
  assert.equal(setup.history.feedback(id).correct, true);
});

test('image references round-trip only at their original content position and validate bytes', () => {
  const url = 'data:image/png;base64,' + screenshot.png.toString('base64');
  const payload = {
    model: 'test',
    messages: [
      { role: 'system', content: url },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url, detail: 'high' } },
          { type: 'text', text: url },
        ],
      },
    ],
  };
  const before = JSON.stringify(payload);
  const saved = snapshotIntentRequest(payload, screenshot.png, 'http://127.0.0.1:1/v1');
  assert.equal(JSON.stringify(payload), before, 'Recording never mutates the live provider body');
  assert.deepEqual(restoreIntentRequest(saved, screenshot.png).body, payload);
  assert.throws(() => restoreIntentRequest(saved, Buffer.from('changed image')), /checksum/);
  assert.throws(() => restoreIntentRequest(saved, Buffer.alloc(0)), /checksum/);
  assert.throws(
    () => restoreIntentRequest(saved.replace('"version":1', '"version":2'), screenshot.png),
    /Unsupported/,
  );
  for (const invalid of [
    { messages: [] },
    { messages: [{ content: [{ type: 'image_url', image_url: { url: 'different bytes' } }] }] },
  ]) {
    assert.throws(() => snapshotIntentRequest(invalid, screenshot.png, 'http://127.0.0.1:1/v1'));
  }
  assert.throws(
    () => snapshotIntentRequest(payload, screenshot.png, 'http://user:secret@localhost/v1'),
    /credentials/,
  );
});
