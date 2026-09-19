import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.ts';
import { Transcriber } from '../../src/sensors/audio/transcriber.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { processor, screenshot, signal, testDetector, testSensors } from '../helpers.ts';

interface Plan {
  start?: string;
  request?: string;
}

interface WorkerEvent {
  event: 'start' | 'request';
  pid: number;
}

/** A real child process makes pipe handling and reaping part of the assertion. */
async function fixture(context: TestContext, plans: Plan[] = [{}], text = 'Dublin.') {
  const directory = await mkdtemp(join(tmpdir(), 'companion-asr-test-'));
  await writeFile(join(directory, 'worker.json'), JSON.stringify({ plans, text }));
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
    worker.transcriber.transcribe(new Float32Array(496001), signal()),
    /31 seconds/,
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
