import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.ts';
import { Transcriber, type TranscriptionDiagnostic } from '../../src/sensors/audio/transcriber.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { MAX_UTTERANCE_SAMPLES } from '../../src/core/utterance-continuation.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { processor, screenshot, signal, testDetector, testSensors } from '../helpers.ts';

interface Plan {
  start?: string;
  /** Action for every request, unless `requests` scripts that request index. */
  request?: string;
  requests?: (string | undefined)[];
}

interface WorkerEvent {
  /** `waiting`: an `on-signal` request is ready to be released by SIGUSR2. */
  event: 'start' | 'request' | 'waiting';
  pid: number;
  /** Request framing only: counts and a hash, never samples. */
  samples?: number;
  leadingZeros?: number;
  trailingZeros?: number;
  hash?: string;
}

/**
 * A real child process makes pipe handling and reaping part of the assertion.
 * `texts` scripts consecutive responses within one worker process; `text`
 * answers every other request.
 */
async function fixture(
  context: TestContext,
  plans: Plan[] = [{}],
  text = 'Dublin.',
  texts?: string[],
) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-asr-test-'));
  await writeFile(join(directory, 'worker.json'), JSON.stringify({ plans, text, texts }));
  const config = {
    workerBinary: fileURLToPath(new URL('../fixtures/asr-worker.cjs', import.meta.url)),
    modelDir: directory,
    timeoutMs: 3000,
  };
  const transcriber = new Transcriber(config);
  context.after(async () => {
    await transcriber.close();
    await rm(directory, { recursive: true, force: true });
  });

  const events = async (): Promise<WorkerEvent[]> => {
    try {
      const lines = await readFile(join(directory, 'events.jsonl'), 'utf8');
      return lines
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  };
  const waitFor = async (event: WorkerEvent['event'], count = 1) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const matches = (await events()).filter((item) => item.event === event);
      if (matches.length >= count) {
        return matches[count - 1];
      }
      await delay(10);
    }
    throw Error(`Test worker did not record ${event}`);
  };

  return { transcriber, config, events, waitFor, directory };
}

function assertReaped(pid: number): void {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

const speech = () => new Float32Array(1600).fill(0.1);

test('construction, silence, invalid samples and pre-cancellation acquire no worker', async (context) => {
  const worker = await fixture(context);
  assert.deepEqual(await worker.events(), []);
  assert.equal(await worker.transcriber.transcribe(new Float32Array(), signal()), '');
  assert.equal(await worker.transcriber.transcribe(new Float32Array(16000), signal()), '');
  await assert.rejects(
    worker.transcriber.transcribe(new Float32Array(16000 * 61 + 1), signal()),
    /61 seconds/,
  );
  await assert.rejects(
    worker.transcriber.transcribe(new Float32Array([NaN]), signal()),
    /nonfinite/,
  );
  await assert.rejects(worker.transcriber.start(AbortSignal.abort()), /abort/i);
  await assert.rejects(worker.transcriber.transcribe(speech(), AbortSignal.abort()), /abort/i);
  assert.deepEqual(await worker.events(), []);
  await worker.transcriber.close();
  await assert.rejects(worker.transcriber.start(signal()), /closed/);
  assert.deepEqual(await worker.events(), []);
});

test('startup and successful requests reuse one model process, then close reaps it', async (context) => {
  const worker = await fixture(context, [{ request: 'partial' }], '  Héllo Dublin.  ');
  await worker.transcriber.start(signal());
  await worker.transcriber.start(signal());
  for (let index = 0; index < 3; index++) {
    assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Héllo Dublin.');
  }
  const events = await worker.events();
  assert.equal(events.filter((item) => item.event === 'start').length, 1);
  assert.equal(events.filter((item) => item.event === 'request').length, 3);
  await Promise.all([worker.transcriber.close(), worker.transcriber.close()]);
  assertReaped(events[0].pid);
  await assert.rejects(worker.transcriber.transcribe(speech(), signal()), /closed/);
});

test('punctuation-only transcripts are filtered and exactly 4000 characters are accepted', async (context) => {
  const punctuation = await fixture(context, [{}], '… !');
  assert.equal(await punctuation.transcriber.transcribe(speech(), signal()), '');
  const bounded = await fixture(context, [{}], 'é'.repeat(4000));
  assert.equal((await bounded.transcriber.transcribe(speech(), signal())).length, 4000);
});

test('silence surrounding a quiet short word does not suppress its ASR request', async (context) => {
  const worker = await fixture(context);
  const diagnostics: TranscriptionDiagnostic[] = [];

  // This word is above the unchanged silence floor for 128 ms. Its whole-buffer
  // RMS falls below that floor after adding normal preroll and ending silence.
  const word = new Float32Array(2048).fill(0.0008);
  for (const trailingSamples of [12800, 48000]) {
    const samples = new Float32Array(4096 + word.length + trailingSamples);
    samples.set(word, 4096);
    const original = samples.slice();
    assert.equal(
      await worker.transcriber.transcribe(samples, signal(), (entry) => diagnostics.push(entry)),
      'Dublin.',
    );
    assert.deepEqual(samples, original, 'The guard must not normalize or trim model input');
  }

  assert.equal((await worker.events()).filter((entry) => entry.event === 'request').length, 2);
  assert.ok(diagnostics.every((entry) => entry.rms < 0.0005));
  assert.ok(diagnostics.every((entry) => entry.speechWindowRms > 0.0005));
  assert.ok(diagnostics.every((entry) => entry.outcome === 'text'));
});

test('diagnostics distinguish quiet input, empty output, punctuation and worker failure', async (context) => {
  const diagnostics: TranscriptionDiagnostic[] = [];
  const observe = (entry: TranscriptionDiagnostic) => diagnostics.push(entry);
  const quiet = await fixture(context);
  const empty = await fixture(context, [{}], '');
  const punctuation = await fixture(context, [{}], '...');
  const failure = await fixture(context, [{ request: 'inference-error' }]);

  assert.equal(
    await quiet.transcriber.transcribe(new Float32Array(16000).fill(0.0004), signal(), observe),
    '',
  );
  assert.deepEqual(await quiet.events(), [], 'Quiet input still acquires no native resources');
  assert.equal(await empty.transcriber.transcribe(speech(), signal(), observe), '');
  assert.equal(await punctuation.transcriber.transcribe(speech(), signal(), observe), '');
  await assert.rejects(failure.transcriber.transcribe(speech(), signal(), observe), /ASR worker/);

  assert.deepEqual(
    diagnostics.map((entry) => entry.outcome),
    ['silence', 'empty', 'punctuation', 'error'],
  );
  assert.ok(diagnostics.every((entry) => entry.elapsedMs >= 0));
  assert.equal(JSON.stringify(diagnostics).includes('secret-transcript'), false);
});

// Empty-result recovery: one padded retry on the same worker, and only after a
// first pass that returned no text at all.
const RETRY_PADDING_SAMPLES = 4000;

async function requests(worker: Awaited<ReturnType<typeof fixture>>): Promise<WorkerEvent[]> {
  return (await worker.events()).filter((event) => event.event === 'request');
}

test('a first-pass result sends exactly one request and reports no retry', async (context) => {
  const worker = await fixture(context);
  const diagnostics: TranscriptionDiagnostic[] = [];

  assert.equal(
    await worker.transcriber.transcribe(speech(), signal(), (entry) => diagnostics.push(entry)),
    'Dublin.',
  );

  const sent = await requests(worker);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].samples, speech().length);
  assert.equal(sent[0].leadingZeros, 0, 'Normal requests are not padded');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].outcome, 'text');
  assert.equal('emptyRetry' in diagnostics[0], false);
  assert.equal('retryMs' in diagnostics[0], false);
});

test('an empty first pass is retried once with padding around unchanged samples', async (context) => {
  const worker = await fixture(context, [{}], 'unused', ['', ' Dublin. ']);
  const diagnostics: TranscriptionDiagnostic[] = [];
  const samples = speech();
  const original = samples.slice();

  assert.equal(
    await worker.transcriber.transcribe(samples, signal(), (entry) => diagnostics.push(entry)),
    'Dublin.',
  );

  assert.deepEqual(samples, original, 'The caller keeps its original, unpadded samples');
  const [first, retry, ...rest] = await requests(worker);
  assert.deepEqual(rest, []);
  assert.equal(first.samples, samples.length);
  assert.equal(first.leadingZeros, 0);
  assert.equal(retry.pid, first.pid, 'The retry reuses the resident worker');
  assert.equal(retry.samples, samples.length + 2 * RETRY_PADDING_SAMPLES);
  assert.equal(retry.leadingZeros, RETRY_PADDING_SAMPLES);
  assert.equal(retry.trailingZeros, RETRY_PADDING_SAMPLES);
  assert.equal(retry.hash, first.hash, 'The retry carries the same encoded samples');

  assert.equal(diagnostics.length, 1, 'One report per operation');
  assert.equal(diagnostics[0].outcome, 'text');
  assert.equal(diagnostics[0].emptyRetry, 'recovered');
  assert.equal(diagnostics[0].characters, 'Dublin.'.length);
  assert.equal(diagnostics[0].audioMs, samples.length / 16, 'Audio length excludes padding');
  assert.ok(diagnostics[0].retryMs! >= 0);
  assert.ok(diagnostics[0].elapsedMs >= diagnostics[0].retryMs!);
  assert.equal(JSON.stringify(diagnostics).includes('Dublin'), false);
});

for (const [retryText, outcome] of [
  ['', 'empty'],
  ['  ', 'empty'],
  ['…', 'punctuation'],
] as const) {
  test(`a retry returning ${JSON.stringify(retryText)} stays unusable and is not retried again`, async (context) => {
    const worker = await fixture(context, [{}], 'Dublin.', ['', retryText]);
    const diagnostics: TranscriptionDiagnostic[] = [];

    assert.equal(
      await worker.transcriber.transcribe(speech(), signal(), (entry) => diagnostics.push(entry)),
      '',
    );

    assert.equal((await requests(worker)).length, 2);
    assert.deepEqual(
      diagnostics.map((entry) => [entry.outcome, entry.emptyRetry]),
      [[outcome, outcome]],
    );

    // The next utterance starts a fresh first pass on the same worker.
    assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Dublin.');
    assert.equal((await requests(worker)).length, 3);
    assert.equal((await worker.events()).filter((item) => item.event === 'start').length, 1);
  });
}

test('punctuation, silence and quiet input never send a retry', async (context) => {
  const diagnostics: TranscriptionDiagnostic[] = [];
  const observe = (entry: TranscriptionDiagnostic) => diagnostics.push(entry);
  const punctuation = await fixture(context, [{}], 'Dublin.', ['...', 'Dublin.']);
  const silence = await fixture(context, [{}], '');
  const quiet = await fixture(context, [{}], 'Dublin.', ['', 'Dublin.']);

  assert.equal(await punctuation.transcriber.transcribe(speech(), signal(), observe), '');
  assert.equal((await requests(punctuation)).length, 1);

  assert.equal(
    await silence.transcriber.transcribe(new Float32Array(16000), signal(), observe),
    '',
  );
  assert.deepEqual(await silence.events(), []);

  // Strongest-window RMS 0.004: above the 0.0005 silence floor, below the
  // 0.005 retry floor where public quiet phrases mostly retried to wrong words.
  const quietSpeech = new Float32Array(16000).fill(0.004);
  assert.equal(await quiet.transcriber.transcribe(quietSpeech, signal(), observe), '');
  assert.equal((await requests(quiet)).length, 1);

  assert.deepEqual(
    diagnostics.map((entry) => [entry.outcome, entry.emptyRetry]),
    [
      ['punctuation', undefined],
      ['silence', undefined],
      ['empty', 'quiet'],
    ],
  );
  assert.equal(diagnostics[2].retryMs, undefined);
});

test('a one-minute utterance is retried; padding beyond the 61-second bound is not', async (context) => {
  const worker = await fixture(context, [{}], '', []);
  const diagnostics: TranscriptionDiagnostic[] = [];
  const observe = (entry: TranscriptionDiagnostic) => diagnostics.push(entry);
  const limit = 16000 * 61;

  // The longest live utterance fits with its padding. Exactly at the bound once
  // padded: retried. One sample longer: skipped. At the input bound itself:
  // skipped, with the original request unchanged.
  for (const length of [
    MAX_UTTERANCE_SAMPLES,
    limit - 2 * RETRY_PADDING_SAMPLES,
    limit - 2 * RETRY_PADDING_SAMPLES + 1,
    limit,
  ]) {
    assert.equal(
      await worker.transcriber.transcribe(new Float32Array(length).fill(0.1), signal(), observe),
      '',
    );
  }

  assert.deepEqual(
    (await requests(worker)).map((event) => event.samples),
    [
      MAX_UTTERANCE_SAMPLES,
      MAX_UTTERANCE_SAMPLES + 2 * RETRY_PADDING_SAMPLES,
      limit - 2 * RETRY_PADDING_SAMPLES,
      limit,
      limit - 2 * RETRY_PADDING_SAMPLES + 1,
      limit,
    ],
  );
  assert.deepEqual(
    diagnostics.map((entry) => entry.emptyRetry),
    ['empty', 'empty', 'too-long', 'too-long'],
  );
});

test('cancelling a one-minute request reaps its worker; the next one gets a replacement', async (context) => {
  const worker = await fixture(context, [{ request: 'hang' }, {}]);
  const controller = new AbortController();

  const operation = worker.transcriber.transcribe(
    new Float32Array(MAX_UTTERANCE_SAMPLES).fill(0.1),
    controller.signal,
  );
  const hung = await worker.waitFor('request');
  assert.equal(hung.samples, MAX_UTTERANCE_SAMPLES);
  controller.abort();
  await assert.rejects(operation, /abort/i);
  assertReaped(hung.pid);

  assert.equal(
    await worker.transcriber.transcribe(
      new Float32Array(MAX_UTTERANCE_SAMPLES).fill(0.1),
      signal(),
    ),
    'Dublin.',
  );
  const sent = await requests(worker);
  assert.equal(sent.length, 2, 'The cancelled request is not replayed');
  assert.notEqual(sent[1].pid, hung.pid);
});

test('the pipeline routes 45- and 60-second utterances through the real request bound', async (context) => {
  const worker = await fixture(context);
  const delivered: string[] = [];
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  processor('IGNORE', async (frame) => {
    delivered.push(frame.utterance);
  }).subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async () => assert.fail('Replaced by the real transcriber'),
      }),
      transcriber: worker.transcriber,
      router,
    },
    () => {},
    signal(),
  );

  pipeline.submit(new Float32Array(16000 * 45).fill(0.1));
  pipeline.submit(new Float32Array(MAX_UTTERANCE_SAMPLES).fill(0.1));
  await pipeline.idle();

  assert.deepEqual(
    (await requests(worker)).map((event) => event.samples),
    [16000 * 45, MAX_UTTERANCE_SAMPLES],
  );
  assert.deepEqual(delivered, ['Dublin.', 'Dublin.']);
  assert.equal(pipeline.failures, 0);
});

test('a first-pass worker error is not retried', async (context) => {
  const worker = await fixture(context, [{ request: 'inference-error' }, {}]);
  const diagnostics: TranscriptionDiagnostic[] = [];

  await assert.rejects(
    worker.transcriber.transcribe(speech(), signal(), (entry) => diagnostics.push(entry)),
    /ASR worker/,
  );

  const sent = await requests(worker);
  assert.equal(sent.length, 1);
  assertReaped(sent[0].pid);
  assert.deepEqual(
    diagnostics.map((entry) => [entry.outcome, entry.emptyRetry]),
    [['error', undefined]],
  );
});

test('a retry failure rejects without a hidden restart; the next utterance recovers', async (context) => {
  const worker = await fixture(
    context,
    [{ requests: [undefined, 'inference-error'] }, {}],
    'Dublin.',
    [''],
  );
  const diagnostics: TranscriptionDiagnostic[] = [];

  await assert.rejects(
    worker.transcriber.transcribe(speech(), signal(), (entry) => diagnostics.push(entry)),
    (error: Error) => {
      assert.match(error.message, /ASR worker/);
      assert.equal(error.message.includes('secret-transcript'), false);
      return true;
    },
  );

  const sent = await requests(worker);
  assert.equal(sent.length, 2);
  assertReaped(sent[1].pid);
  assert.equal((await worker.events()).filter((item) => item.event === 'start').length, 1);
  assert.deepEqual(
    diagnostics.map((entry) => [entry.outcome, entry.emptyRetry]),
    [['error', 'error']],
  );
  assert.ok(diagnostics[0].retryMs! >= 0);

  // Only a later utterance starts a replacement. Its operation begins with a
  // fresh unpadded first pass (scripted empty again), then its own one retry.
  assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Dublin.');
  const events = await worker.events();
  const starts = events.filter((item) => item.event === 'start');
  assert.equal(starts.length, 2);
  const replacement = (await requests(worker)).filter((item) => item.pid === starts[1].pid);
  assert.deepEqual(
    replacement.map((item) => item.leadingZeros),
    [0, RETRY_PADDING_SAMPLES],
  );
});

test('cancellation during the first pass sends no retry', async (context) => {
  const worker = await fixture(context, [{ requests: ['delay'] }, {}], 'Dublin.', ['']);
  const diagnostics: TranscriptionDiagnostic[] = [];
  const controller = new AbortController();

  const operation = worker.transcriber.transcribe(speech(), controller.signal, (entry) =>
    diagnostics.push(entry),
  );
  const rejected = assert.rejects(operation, /abort/i);
  const first = await worker.waitFor('request');
  controller.abort();
  await rejected;

  // Give a (wrong) retry the chance to reach the reaped worker.
  await delay(200);
  assertReaped(first.pid);
  assert.equal((await requests(worker)).length, 1);
  assert.deepEqual(
    diagnostics.map((entry) => [entry.outcome, entry.emptyRetry]),
    [['error', undefined]],
  );
});

for (const reason of ['cancel', 'close'] as const) {
  test(`${reason} during the retry rejects and reaps the worker`, async (context) => {
    const worker = await fixture(context, [{ requests: [undefined, 'hang'] }, {}], 'Dublin.', ['']);
    const diagnostics: TranscriptionDiagnostic[] = [];
    const controller = new AbortController();

    const operation = worker.transcriber.transcribe(speech(), controller.signal, (entry) =>
      diagnostics.push(entry),
    );
    const rejected = assert.rejects(operation, /abort|closed/i);
    const retry = await worker.waitFor('request', 2);
    if (reason === 'cancel') {
      controller.abort();
    } else {
      await worker.transcriber.close();
    }
    await rejected;

    assertReaped(retry.pid);
    assert.equal((await requests(worker)).length, 2);
    assert.deepEqual(
      diagnostics.map((entry) => [entry.outcome, entry.emptyRetry]),
      [['error', 'error']],
    );
  });
}

test('the retry shares the operation timeout instead of receiving a new one', async (context) => {
  // The first pass answers empty only when released; the retry never answers.
  const worker = await fixture(context, [{ requests: ['on-signal', 'hang'] }, {}], 'Dublin.', ['']);
  await worker.transcriber.start(signal());
  worker.config.timeoutMs = 1000;
  const diagnostics: TranscriptionDiagnostic[] = [];

  // A controlled clock makes the deadline independent of scheduling latency.
  // Only setTimeout is mocked, so this test polls using setImmediate.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const recorded = async (event: WorkerEvent['event'], count: number): Promise<WorkerEvent> => {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const matches = (await worker.events()).filter((item) => item.event === event);
      if (matches.length >= count) {
        return matches[count - 1];
      }
      await nextTurn();
    }
    throw Error(`Test worker did not record ${event} ${count}`);
  };
  // Settlement after the deadline also waits for the real child to be reaped,
  // so poll against real time. A wrongly restarted retry timeout never fires
  // on the mocked clock, so a generous bound cannot hide it.
  const settlesWithin = async (operation: Promise<unknown>, realMs: number): Promise<boolean> => {
    let settled = false;
    operation.then(
      () => (settled = true),
      () => (settled = true),
    );
    const deadline = performance.now() + realMs;
    while (!settled && performance.now() < deadline) {
      await nextTurn();
    }
    return settled;
  };

  const operation = worker.transcriber.transcribe(speech(), signal(), (entry) =>
    diagnostics.push(entry),
  );
  const rejected = assert.rejects(operation, /timed out/);

  // Spend 600 of the 1000 ms budget on the first pass, then release it.
  const first = await recorded('waiting', 1);
  context.mock.timers.tick(600);
  process.kill(first.pid, 'SIGUSR2');
  await recorded('request', 2);

  // A fresh retry timeout would expire at 1600 ms; the shared one at 1000 ms.
  context.mock.timers.tick(399);
  assert.equal(await settlesWithin(operation, 50), false, 'The deadline has not passed yet');
  context.mock.timers.tick(1);
  assert.equal(await settlesWithin(operation, 3000), true, 'The shared deadline ended the retry');
  await rejected;

  const sent = await requests(worker);
  assert.equal(sent.length, 2);
  assertReaped(sent[1].pid);
  assert.deepEqual(
    diagnostics.map((entry) => [entry.outcome, entry.emptyRetry]),
    [['error', 'error']],
  );
});

test('a throwing diagnostic observer cannot replace ASR results or worker errors', async (context) => {
  const worker = await fixture(context);
  const failure = await fixture(context, [{ request: 'inference-error' }]);
  const outcomes: string[] = [];
  const observe = (entry: TranscriptionDiagnostic) => {
    outcomes.push(entry.outcome);
    throw Error('Observer failed');
  };

  assert.equal(await worker.transcriber.transcribe(speech(), signal(), observe), 'Dublin.');
  assert.equal(await worker.transcriber.transcribe(new Float32Array(16000), signal(), observe), '');
  await assert.rejects(failure.transcriber.transcribe(speech(), signal(), observe), /ASR worker/);
  assert.deepEqual(outcomes, ['text', 'silence', 'error'], 'Each operation reports only once');

  // A diagnostic failure must not poison the resident worker's next request.
  assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Dublin.');
  assert.equal((await worker.events()).filter((entry) => entry.event === 'start').length, 1);
});

for (const phase of ['start', 'request'] as const) {
  for (const reason of ['cancel', 'timeout', 'close'] as const) {
    test(`${reason} during ${phase} settles and reaps the worker`, async (context) => {
      const worker = await fixture(context, [{ [phase]: 'hang' }, {}]);
      const controller = new AbortController();
      if (phase === 'request') {
        await worker.transcriber.start(signal());
      }
      if (reason === 'timeout') {
        worker.config.timeoutMs = 200;
      }
      const operation =
        phase === 'start'
          ? worker.transcriber.start(controller.signal)
          : worker.transcriber.transcribe(speech(), controller.signal);
      const rejected = assert.rejects(operation, /abort|timed out|closed/i);
      const event = await worker.waitFor(phase);
      if (reason === 'cancel') {
        controller.abort();
      } else if (reason === 'close') {
        await worker.transcriber.close();
      }
      await rejected;
      assertReaped(event.pid);
      assert.equal((await worker.events()).filter((item) => item.event === 'start').length, 1);

      if (reason !== 'close') {
        worker.config.timeoutMs = 3000;
        assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Dublin.');
        assert.equal((await worker.events()).filter((item) => item.event === 'start').length, 2);
      }
    });
  }
}

test('concurrent calls are rejected instead of creating a second queue', async (context) => {
  const worker = await fixture(context, [{ request: 'hang' }]);
  const controller = new AbortController();
  const active = worker.transcriber.transcribe(speech(), controller.signal);
  const rejected = assert.rejects(active, /abort/i);
  await worker.waitFor('request');
  await assert.rejects(worker.transcriber.transcribe(speech(), signal()), /active operation/);
  await assert.rejects(worker.transcriber.start(signal()), /active operation/);
  assert.equal((await worker.events()).filter((item) => item.event === 'start').length, 1);
  controller.abort();
  await rejected;
});

for (const action of [
  'exit',
  'eof',
  'malformed',
  'invalid-utf8',
  'oversized',
  'long-text',
  'double',
  'wrong-type',
  'inference-error',
]) {
  test(`${action} response fails once, reaps the worker and permits a later utterance`, async (context) => {
    const worker = await fixture(context, [{ request: action }, {}]);
    await assert.rejects(worker.transcriber.transcribe(speech(), signal()), (error: Error) => {
      assert.equal(error.message.includes('secret-transcript'), false);
      return true;
    });
    const failed = await worker.waitFor('request');
    assertReaped(failed.pid);
    assert.equal((await worker.events()).filter((item) => item.event === 'start').length, 1);
    assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Dublin.');
    const events = await worker.events();
    assert.equal(events.filter((item) => item.event === 'start').length, 2);
    assert.equal(events.filter((item) => item.event === 'request').length, 2);
  });
}

for (const action of ['exit', 'eof', 'malformed', 'oversized', 'wrong-type', 'model-error']) {
  test(`${action} during readiness fails with no audio sent`, async (context) => {
    const worker = await fixture(context, [{ start: action }, {}]);
    await assert.rejects(worker.transcriber.start(signal()), (error: Error) => {
      assert.equal(error.message.includes('secret-transcript'), false);
      return true;
    });
    const events = await worker.events();
    assert.equal(events.length, 1);
    assertReaped(events[0].pid);
    assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Dublin.');
  });
}

test('missing executable gives actionable setup error and close still settles', async (context) => {
  const worker = await fixture(context);
  worker.config.workerBinary = join(worker.directory, 'missing');
  await assert.rejects(worker.transcriber.start(signal()), /npm run asr:build/);
  await worker.transcriber.close();
});

test('stderr is drained without retaining or exposing native diagnostics', async (context) => {
  const worker = await fixture(context, [{ start: 'stderr', request: 'stderr' }]);
  assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Dublin.');
});

test('idle worker exit is recovered by the next utterance', async (context) => {
  const worker = await fixture(context);
  await worker.transcriber.start(signal());
  const first = await worker.waitFor('start');
  process.kill(first.pid, 'SIGKILL');
  // Observe OS reaping before calling again; this exercises idle failure,
  // independently of the in-flight exit test above.
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      process.kill(first.pid, 0);
    } catch {
      break;
    }
    await delay(10);
  }
  assertReaped(first.pid);
  assert.equal(await worker.transcriber.transcribe(speech(), signal()), 'Dublin.');
  assert.equal((await worker.events()).filter((item) => item.event === 'start').length, 2);
});

test('pause cancels real worker and pending frames; resume routes only new audio', async (context) => {
  const worker = await fixture(context, [{ request: 'hang' }, {}]);
  const pause = new PauseControl();
  const delivered: number[] = [];
  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'IGNORE' }) },
    () => {},
  );
  processor('IGNORE', async (frame) => {
    delivered.push(frame.id);
  }).subscribe(router);
  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async () => assert.fail('Replaced by the real transcriber'),
      }),
      transcriber: worker.transcriber,
      router,
    },
    () => {},
    signal(),
  );
  const active = speech();
  const pending = speech();
  pipeline.submit(active, pause.signal);
  pipeline.submit(pending, pause.signal);
  const event = await worker.waitFor('request');
  pause.toggle();
  await pipeline.idle();
  assertReaped(event.pid);
  assert.deepEqual(delivered, []);
  assert.ok(active.every((sample) => sample === 0));
  assert.ok(pending.every((sample) => sample === 0));
  pause.toggle();
  pipeline.submit(speech(), pause.signal);
  await pipeline.idle();
  assert.deepEqual(delivered, [3]);
  assert.equal(pipeline.failures, 0);
});

for (const retryText of ['', 'Dublin.']) {
  const recovered = retryText !== '';

  test(`pipeline ${recovered ? 'routes recovered text' : 'retains the original clip'} after an empty first pass`, async (context) => {
    const worker = await fixture(context, [{}], 'unused', ['', retryText]);
    const delivered: string[] = [];
    const logged: { stage: string; detail: string }[] = [];
    const recordings: {
      kind: string;
      samples: Float32Array;
      copy: Float32Array;
      clip?: unknown;
    }[] = [];
    const router = new UserSensorRouter(
      { detector: testDetector({ detect: async () => 'IGNORE' }) },
      () => {},
    );
    processor('IGNORE', async (frame) => {
      delivered.push(frame.utterance);
    }).subscribe(router);

    const pipeline = new SensorPipeline(
      {
        ...testSensors({
          capture: async () => screenshot,
          transcribe: async () => assert.fail('Replaced by the real transcriber'),
        }),
        transcriber: worker.transcriber,
        router,
      },
      (stage, detail) => {
        logged.push({ stage, detail });
      },
      signal(),
      {
        audioCaptured: async (_id, samples) => {
          recordings.push({ kind: 'audio', samples, copy: samples.slice() });
        },
        emptyAudioCaptured: async (clip) => {
          recordings.push({
            kind: 'empty',
            samples: clip.samples,
            copy: clip.samples.slice(),
            clip,
          });
          return 'synthetic-clip';
        },
      },
    );

    // 250 ms: long enough for the empty-clip duration floor of 128 ms.
    const samples = new Float32Array(4000).fill(0.1);
    const original = samples.slice();
    pipeline.submit(samples);
    await pipeline.idle();

    // Either way, storage receives the pipeline's own unpadded sample buffer
    // with its original contents; the pipeline clears it only afterwards.
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0].kind, recovered ? 'audio' : 'empty');
    assert.equal(recordings[0].samples, samples);
    assert.deepEqual(recordings[0].copy, original);
    assert.ok(samples.every((sample) => sample === 0));

    const asr = logged
      .filter((entry) => entry.stage === 'asr')
      .map((entry) => JSON.parse(entry.detail));
    assert.equal(asr.length, 1);
    assert.equal(asr[0].outcome, recovered ? 'text' : 'empty');
    assert.equal(asr[0].emptyRetry, recovered ? 'recovered' : 'empty');
    assert.deepEqual(delivered, recovered ? ['Dublin.'] : []);
    assert.equal(
      logged.some((entry) => entry.stage === 'asr-recorded'),
      !recovered,
      'Only a final empty result is retained as an empty clip',
    );
    if (!recovered) {
      const clip = recordings[0].clip as { diagnostic: TranscriptionDiagnostic };
      assert.equal(clip.diagnostic.emptyRetry, 'empty');
    }
    assert.equal(pipeline.failures, 0);
    assert.equal((await requests(worker)).length, 2);
  });
}

test('old Voxtype binary config is rejected with migration instructions', async (context) => {
  const worker = await fixture(context);
  const path = join(worker.directory, 'config.json');
  await writeFile(path, JSON.stringify({ asr: { binary: '/old/voxtype' } }));
  await assert.rejects(loadConfig(path), /asr.workerBinary.*asr:build/);
});

for (const startupHangs of [false, true]) {
  test(`audio CLI reaps its worker after ${startupHangs ? 'SIGTERM during startup' : 'a later startup failure'}`, async (context) => {
    const worker = await fixture(context, [{ start: startupHangs ? 'hang' : undefined }]);
    const path = join(worker.directory, 'cli.json');
    await writeFile(path, JSON.stringify({ asr: worker.config }));
    const preload = fileURLToPath(new URL('../fixtures/asr-cli.cjs', import.meta.url));
    const project = fileURLToPath(new URL('../../', import.meta.url));
    const cli = promisify(execFile)(
      process.execPath,
      ['--require', preload, '--import', 'tsx', 'src/cli.ts', '--no-desktop', '--config', path],
      { cwd: project, timeout: 10000 },
    );
    // Attach the rejection handler immediately while waiting for startup events.
    const outcome = cli.then(
      (result) => ({ ...result, code: 0 }),
      (error: { stdout: string; code: number }) => error,
    );
    context.after(() => {
      cli.child.kill('SIGKILL');
    });
    const event = await worker.waitFor('start');
    if (startupHangs) {
      cli.child.kill('SIGTERM');
    }
    const result = await outcome;
    assert.equal(result.code, startupHangs ? 0 : 1);
    assert.match(result.stdout, /Capture and processing stopped/);
    if (!startupHangs) {
      assert.match(result.stdout, /Synthetic screen failure/);
    }
    assertReaped(event.pid);
    assert.equal((await worker.events()).length, 1);
  });
}
