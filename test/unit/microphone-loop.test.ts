import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DictationController,
  type DictationAppendRequest,
  type DictationCapture,
  type DictationSummary,
} from '../../src/core/dictation/controller.ts';
import { PauseControl } from '../../src/core/pause-control.ts';
import { CaptureLostError } from '../../src/sensors/audio/capture.ts';
import {
  CaptureRetryDelay,
  FIRST_RETRY_DELAY_MS,
  HEALTHY_CAPTURE_MS,
  MAX_RETRY_DELAY_MS,
  type RetryClock,
} from '../../src/sensors/audio/capture-retry.ts';
import { listenToMicrophone } from '../../src/sensors/audio/microphone-loop.ts';
import { chunk, vad } from '../dictation-fixture.ts';
import { deferred } from '../helpers.ts';

// The live microphone loop with a scripted microphone and fake time. No
// recorder process, VAD, ASR, provider or real timer is involved: each
// ordinary listening period is a promise the test ends, and each retry wait
// is a promise the test elapses.

/** One ordinary listening period the test ends like a recorder would. */
interface Period {
  signal: AbortSignal;
  handoff?: AbortSignal;
  /** The recorder exited successfully (live EOF). */
  eof(): void;
  /** The period failed with `error`, like a dead recorder or a VAD failure. */
  fail(error: unknown): void;
}

/**
 * Shared microphone ownership across ordinary listening and manual recording.
 * Fails the test if two captures would ever run at once.
 */
class Microphone {
  readonly periods: Period[] = [];
  active = 0;
  maxActive = 0;
  private started = deferred<Period>();

  take(): void {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    assert.equal(this.active, 1, 'At most one capture owns the microphone');
  }

  release(): void {
    this.active--;
  }

  /** The `listen` callback for the loop. */
  readonly listen = (signal: AbortSignal, handoff: AbortSignal | undefined): Promise<void> => {
    this.take();

    return new Promise<void>((resolve, reject) => {
      let ended = false;
      const end = (outcome: () => void) => {
        if (ended) {
          return;
        }
        ended = true;
        this.release();
        outcome();
      };

      // Like `listen`: pause and shutdown reject, a handoff ends normally.
      signal.addEventListener('abort', () => end(() => reject(signal.reason)), { once: true });
      handoff?.addEventListener('abort', () => end(resolve), { once: true });

      const period: Period = {
        signal,
        handoff,
        eof: () => end(resolve),
        fail: (error) => end(() => reject(error)),
      };
      this.periods.push(period);
      const started = this.started;
      this.started = deferred<Period>();
      started.resolve(period);
    });
  };

  /** Resolves with the next period the loop opens. */
  nextPeriod(): Promise<Period> {
    return this.started.promise;
  }
}

/** One requested retry wait. */
interface Sleep {
  durationMs: number;
  signal: AbortSignal;
  /** Let the fake time pass, ending the wait. */
  elapse(): void;
}

/** Fake monotonic time. Waits end only when the test elapses them or they abort. */
class FakeClock implements RetryClock {
  nowMs = 0;
  readonly sleeps: Sleep[] = [];
  private requested = deferred<Sleep>();

  now(): number {
    return this.nowMs;
  }

  sleep(durationMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };

      if (signal.aborted) {
        finish();
      }
      signal.addEventListener('abort', finish, { once: true });

      const sleep: Sleep = {
        durationMs,
        signal,
        elapse: () => {
          this.nowMs += durationMs;
          finish();
        },
      };
      this.sleeps.push(sleep);
      const requested = this.requested;
      this.requested = deferred<Sleep>();
      requested.resolve(sleep);
    });
  }

  /** Resolves with the next wait the loop requests. */
  nextSleep(): Promise<Sleep> {
    return this.requested.promise;
  }
}

function lost(message = 'pw-record exited 1: synthetic failure') {
  return new CaptureLostError(message);
}

/** Let promise continuations run, without real timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function setup(
  options: {
    dictation?: boolean;
    capture?: DictationCapture;
    /** Fake time that passes while cancelled pipeline work settles. */
    idleDurationMs?: number;
  } = {},
) {
  const shutdown = new AbortController();
  const pause = new PauseControl();
  const microphone = new Microphone();
  const clock = new FakeClock();
  const logs: string[] = [];
  let idleCalls = 0;

  const appends: DictationAppendRequest[] = [];
  const summaries: DictationSummary[] = [];
  let dictation: DictationController | undefined;

  if (options.dictation) {
    dictation = new DictationController(
      async (samples) => `chunk ${samples[0]}`,
      pause,
      () => {},
      shutdown.signal,
      options.capture,
    );
    dictation.on('finished', (summary: DictationSummary) => summaries.push(summary));
  }

  const loop = listenToMicrophone({
    signal: shutdown.signal,
    pause,
    dictation,
    vad,
    listen: microphone.listen,
    idle: async () => {
      idleCalls++;
      clock.nowMs += options.idleDurationMs ?? 0;
    },
    log: (stage, detail) => logs.push(`${stage} ${detail}`),
    clock,
  });
  // The loop only ends by throwing; tests that do not stop it still observe it.
  const outcome = loop.then(
    () => assert.fail('The microphone loop never completes normally'),
    (error: unknown) => error,
  );

  const record = () =>
    dictation!.start({
      clientId: 1,
      sessionId: 'conversation',
      draftLength: 0,
      append: async (request) => {
        appends.push(request);
        return { outcome: 'appended', length: request.text.length };
      },
    });

  return {
    shutdown,
    pause,
    microphone,
    clock,
    logs,
    outcome,
    appends,
    summaries,
    record,
    idleCalls: () => idleCalls,
    dictation,
  };
}

for (const ending of ['eof', 'exit'] as const) {
  test(`live capture ${ending === 'eof' ? 'EOF' : 'failure'} reopens the microphone in the same process`, async () => {
    const h = setup();
    const first = await h.microphone.nextPeriod();

    const reopened = h.microphone.nextPeriod();
    const waiting = h.clock.nextSleep();
    if (ending === 'eof') {
      first.eof();
    } else {
      first.fail(lost('pw-record exited 1: Host is down'));
    }

    const sleep = await waiting;
    assert.equal(sleep.durationMs, FIRST_RETRY_DELAY_MS);
    assert.equal(h.microphone.periods.length, 1, 'No new recorder before the delay');
    assert.match(
      h.logs.join('\n'),
      ending === 'eof'
        ? /Capture lost \(The microphone recorder ended unexpectedly\); recording again in 500 ms/
        : /Capture lost \(pw-record exited 1: Host is down\); recording again in 500 ms/,
    );

    sleep.elapse();
    const second = await reopened;
    assert.equal(h.microphone.periods.length, 2);
    assert.equal(second.signal.aborted, false);
    assert.ok(h.logs.includes('microphone Opening the microphone again'));
    assert.equal(h.microphone.maxActive, 1);

    h.shutdown.abort(Error('shutdown'));
    assert.match(String(await h.outcome), /shutdown/);
  });
}

test('repeated losses wait longer each time up to the cap, and healthy capture resets the delay', async () => {
  const h = setup();
  const delays: number[] = [];

  // Six recorders that die at once: 500, 1000, 2000, 4000, 5000, 5000 ms.
  for (let attempt = 0; attempt < 6; attempt++) {
    const period = await h.microphone.nextPeriod();
    const waiting = h.clock.nextSleep();
    period.fail(lost());
    const sleep = await waiting;
    delays.push(sleep.durationMs);
    sleep.elapse();
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS]);

  // A recorder that ran just short of the healthy threshold keeps the cap.
  let period = await h.microphone.nextPeriod();
  h.clock.nowMs += HEALTHY_CAPTURE_MS - 1;
  let waiting = h.clock.nextSleep();
  period.fail(lost());
  let sleep = await waiting;
  assert.equal(sleep.durationMs, MAX_RETRY_DELAY_MS);
  sleep.elapse();

  // One that ran for the threshold proves the microphone works again.
  period = await h.microphone.nextPeriod();
  h.clock.nowMs += HEALTHY_CAPTURE_MS;
  waiting = h.clock.nextSleep();
  period.eof();
  sleep = await waiting;
  assert.equal(sleep.durationMs, FIRST_RETRY_DELAY_MS);
  sleep.elapse();

  period = await h.microphone.nextPeriod();
  waiting = h.clock.nextSleep();
  period.fail(lost());
  assert.equal((await waiting).durationMs, 2 * FIRST_RETRY_DELAY_MS);

  assert.equal(h.microphone.maxActive, 1, 'Never two recorders at once');
  h.shutdown.abort(Error('shutdown'));
  assert.match(String(await h.outcome), /shutdown/);
});

for (const [capturedMs, drainMs] of [
  [0, HEALTHY_CAPTURE_MS],
  [HEALTHY_CAPTURE_MS - 1, 1],
] as const) {
  test(`time spent settling a pause is not healthy capture (${capturedMs} ms captured, ${drainMs} ms settling)`, async () => {
    const h = setup({ idleDurationMs: drainMs });

    // Grow the delay to its cap with recorders that die at once.
    let delayMs = 0;
    while (delayMs !== MAX_RETRY_DELAY_MS) {
      const period = await h.microphone.nextPeriod();
      const waiting = h.clock.nextSleep();
      period.fail(lost());
      const sleep = await waiting;
      delayMs = sleep.durationMs;
      sleep.elapse();
    }

    // A recorder runs just short of healthy, then a pause takes time to settle.
    let period = await h.microphone.nextPeriod();
    h.clock.nowMs += capturedMs;
    h.pause.toggle();
    await settle();
    assert.equal(h.idleCalls(), 1);

    const reopened = h.microphone.nextPeriod();
    h.pause.toggle();
    period = await reopened;

    const waiting = h.clock.nextSleep();
    period.fail(lost());
    assert.equal(
      (await waiting).durationMs,
      MAX_RETRY_DELAY_MS,
      'Neither recorder ran long enough to reset the delay',
    );

    h.shutdown.abort(Error('shutdown'));
    assert.match(String(await h.outcome), /shutdown/);
  });
}

test('the delay policy on its own: doubling, cap and reset', () => {
  const retry = new CaptureRetryDelay();
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    retry.captureLasted(0);
    delays.push(retry.lost());
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);

  retry.captureLasted(HEALTHY_CAPTURE_MS);
  assert.equal(retry.lost(), FIRST_RETRY_DELAY_MS);
});

test('a failure that is not lost capture still ends the listener without a retry', async () => {
  const h = setup();
  const period = await h.microphone.nextPeriod();
  period.fail(Error('VAD failed'));

  assert.match(String(await h.outcome), /VAD failed/);
  assert.equal(h.clock.sleeps.length, 0);
  assert.equal(h.microphone.periods.length, 1);
  assert.ok(!h.logs.some((line) => line.includes('Capture lost')));
});

test('pause during the retry wait ends it; resume opens the microphone at once, without resetting the delay', async () => {
  const h = setup();
  let period = await h.microphone.nextPeriod();
  let waiting = h.clock.nextSleep();
  period.fail(lost());
  const sleep = await waiting;

  h.pause.toggle();
  assert.equal(sleep.signal.aborted, true, 'Pause interrupts the wait');
  await settle();
  assert.equal(h.idleCalls(), 1, 'Cancelled work settles before anything else');
  assert.equal(h.microphone.periods.length, 1, 'No recorder while paused');

  const reopened = h.microphone.nextPeriod();
  h.pause.toggle();
  period = await reopened;
  assert.equal(h.clock.sleeps.length, 1, 'Resume opens the microphone without another wait');

  waiting = h.clock.nextSleep();
  period.fail(lost());
  assert.equal((await waiting).durationMs, 2 * FIRST_RETRY_DELAY_MS, 'Delay kept growing');

  h.shutdown.abort(Error('shutdown'));
  assert.match(String(await h.outcome), /shutdown/);
});

test('shutdown during the retry wait ends the loop and opens no recorder', async () => {
  const h = setup({ dictation: true });
  const period = await h.microphone.nextPeriod();
  const waiting = h.clock.nextSleep();
  period.fail(lost());
  const sleep = await waiting;

  h.shutdown.abort(Error('shutdown'));
  assert.equal(sleep.signal.aborted, true);
  assert.match(String(await h.outcome), /shutdown/);
  assert.equal(h.microphone.periods.length, 1);
  assert.equal(h.microphone.active, 0);
});

test('pause while listening is not lost capture and is never retried', async () => {
  const h = setup();
  const period = await h.microphone.nextPeriod();

  h.pause.toggle();
  await settle();
  assert.equal(period.signal.aborted, true);
  assert.equal(h.idleCalls(), 1);
  assert.equal(h.clock.sleeps.length, 0);
  assert.ok(!h.logs.some((line) => line.includes('Capture lost')));

  h.shutdown.abort(Error('shutdown'));
  assert.match(String(await h.outcome), /shutdown/);
});

/**
 * A manual recording whose capture is lost: it shares the microphone with
 * ordinary listening (one capture at a time), keeps its captured words in
 * the draft, and ends with the `microphone` reason.
 */
function lossyRecording(microphone: () => Microphone) {
  const calls = { count: 0 };
  const capture: DictationCapture = async (_vad, sink) => {
    calls.count++;
    microphone().take();
    await Promise.resolve();
    sink.accept(chunk(1));
    microphone().release();
    sink.captureEnded(new CaptureLostError('pw-record exited 1: synthetic failure'));
  };
  return { capture, calls };
}

test('Record during the retry wait runs at once; its lost capture ends it gracefully and is not re-armed', async () => {
  let microphone: Microphone | undefined;
  const recording = lossyRecording(() => microphone!);
  const h = setup({ dictation: true, capture: recording.capture });
  microphone = h.microphone;

  const period = await h.microphone.nextPeriod();
  let waiting = h.clock.nextSleep();
  period.fail(lost());
  const sleep = await waiting;

  // The user presses Record while ordinary listening waits to retry.
  const reopened = h.microphone.nextPeriod();
  h.record();
  assert.equal(sleep.signal.aborted, true, 'Record interrupts the wait');

  // The recording loses capture too. Ordinary listening takes over again,
  // without another wait; the recording itself is not restarted.
  const next = await reopened;
  await settle();
  assert.equal(recording.calls.count, 1, 'The recording is not re-armed');
  assert.equal(h.dictation!.waitingForMicrophone, false);
  assert.equal(h.summaries.length, 1);
  assert.equal(h.summaries[0].reason, 'microphone');
  assert.equal(h.summaries[0].complete, false);
  assert.deepEqual(
    h.appends.map((request) => request.text),
    ['chunk 1'],
    'Captured words reach the draft once; nothing is sent',
  );
  assert.equal(h.clock.sleeps.length, 1);

  // A later loss of ordinary listening keeps the grown delay.
  waiting = h.clock.nextSleep();
  next.fail(lost());
  assert.equal((await waiting).durationMs, 2 * FIRST_RETRY_DELAY_MS);
  assert.equal(h.microphone.maxActive, 1, 'Recording and listening never overlap');

  h.shutdown.abort(Error('shutdown'));
  assert.match(String(await h.outcome), /shutdown/);
});

test('a handoff to manual recording while listening is not lost capture', async () => {
  let microphone: Microphone | undefined;
  const recording = lossyRecording(() => microphone!);
  const h = setup({ dictation: true, capture: recording.capture });
  microphone = h.microphone;

  const period = await h.microphone.nextPeriod();
  const reopened = h.microphone.nextPeriod();
  h.record();
  assert.equal(period.handoff?.aborted, true);

  await reopened;
  assert.equal(recording.calls.count, 1);
  assert.equal(h.clock.sleeps.length, 0, 'No retry wait after a handoff');
  assert.ok(!h.logs.some((line) => line.includes('Capture lost')));

  h.shutdown.abort(Error('shutdown'));
  assert.match(String(await h.outcome), /shutdown/);
});
