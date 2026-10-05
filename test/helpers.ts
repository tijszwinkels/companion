import type { Screenshot, UserSensorFrame, UserSensorProcessor } from '../src/core/frame.ts';
import type { Detector } from '../src/core/router.ts';
import type { PipelineDependencies } from '../src/core/pipeline.ts';
import type { ScreenSensor } from '../src/sensors/screen/sensor.ts';
import type { SpeechTranscriber } from '../src/sensors/audio/transcriber.ts';
import type { CommitClock } from '../src/core/utterance-continuation.ts';

/** A tiny PNG and a stable window identity; no desktop access is needed. */
export const screenshot: Screenshot = {
  png: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
  capturedAt: 1000,
  window: { address: '0xabc', app: 'editor', title: 'Document' },
  width: 1,
  height: 1,
};

export const frame: UserSensorFrame = {
  id: 1,
  observedAt: 1000,
  utterance: 'Hello world',
  screenshot,
};

export const signal = () => new AbortController().signal;

/** Register a test action using the same subscription interface as real processors. */
export function processor(
  name: string,
  process: UserSensorProcessor['process'] = async () => {},
): UserSensorProcessor {
  return {
    id: name,
    label: name,
    dependencies: {},
    name,
    instruction: `Choose ${name}`,
    process,
    subscribe(router) {
      router.register(this);
    },
  };
}

/** Attach inspection metadata to a controlled detector without changing its behavior. */
export function testDetector(implementation: Pick<Detector, 'detect'>): Detector {
  return {
    id: 'test-detector',
    label: 'Test detector',
    dependencies: {},
    detect: implementation.detect.bind(implementation),
  };
}

/** Use the same named sensor objects as production, with controlled operations. */
export function testSensors(operations: {
  capture: ScreenSensor['capture'];
  transcribe: SpeechTranscriber['transcribe'];
}): Pick<PipelineDependencies, 'screen' | 'transcriber'> {
  return {
    screen: {
      id: 'test-screen',
      label: 'Test screen',
      dependencies: {},
      capture: operations.capture,
    },
    transcriber: {
      id: 'test-transcriber',
      label: 'Test transcriber',
      dependencies: {},
      transcribe: operations.transcribe,
    },
  };
}

/** Lets a test pause one pipeline stage until it has checked concurrent behavior. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * A controlled monotonic clock for speech commitment deadlines. Time moves only
 * when a test calls `advance` or `advanceTo`, which run every timer that falls
 * due, in deadline order, with `now()` equal to that timer's deadline. Timer
 * callbacks usually resolve promises; let those continuations run afterwards.
 */
export class ManualClock implements CommitClock {
  private current = 0;
  private sequence = 0;
  private timers: { dueAt: number; sequence: number; callback: () => void }[] = [];

  now(): number {
    return this.current;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer = { dueAt: this.current + delayMs, sequence: this.sequence++, callback };
    this.timers.push(timer);

    return () => {
      this.timers = this.timers.filter((entry) => entry !== timer);
    };
  }

  /** Timers scheduled and neither run nor cancelled; zero when nothing is left behind. */
  get pendingTimers(): number {
    return this.timers.length;
  }

  advance(milliseconds: number): void {
    this.advanceTo(this.current + milliseconds);
  }

  advanceTo(time: number): void {
    if (time < this.current) {
      throw Error('A monotonic clock cannot go back');
    }

    for (;;) {
      const due = this.timers
        .filter((timer) => timer.dueAt <= time)
        .sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence)[0];
      if (!due) {
        break;
      }

      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = Math.max(this.current, due.dueAt);
      due.callback();
    }

    this.current = time;
  }
}
