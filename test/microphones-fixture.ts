import { SensorPipeline } from '../src/core/pipeline.ts';
import type { PauseControl } from '../src/core/pause-control.ts';
import { UserSensorRouter } from '../src/core/router.ts';
import type { DesktopRuntime } from '../src/desktop/runtime.ts';
import { BrowserMicrophones } from '../src/sensors/audio/browser-microphones.ts';
import {
  ComputerMicrophoneSwitch,
  listenWhileSwitchedOn,
} from '../src/sensors/audio/computer-microphone.ts';
import { listen } from '../src/sensors/audio/listener.ts';
import { listenToMicrophone } from '../src/sensors/audio/microphone-loop.ts';
import { NetworkAudioSource } from '../src/sensors/audio/network-source.ts';
import { SpeechIndicator } from '../src/sensors/audio/speech-indicator.ts';
import type { VoiceActivityDetector } from '../src/sensors/audio/vad.ts';
import { computerMicrophone } from '../src/core/pipeline.ts';
import { processor, screenshot, testDetector, testSensors } from './helpers.ts';

/**
 * The listener's microphones, composed as src/cli.ts composes them, around a
 * real DesktopRuntime (and its control socket):
 *
 * - the computer's microphone: the unchanged `listenToMicrophone` loop, with
 *   the computer's switch in front of each period. Its "recorder" is a
 *   synthetic source the test speaks into (`computer.say`); every period
 *   opens a new one, as every period opens a new recorder;
 * - listening browsers (`BrowserMicrophones`), reached through the runtime's
 *   `audio-start`/`audio-chunk`/`audio-stop` actions;
 * - one SensorPipeline with the test recogniser: audio is a square wave whose
 *   amplitude is a marker, transcribed as that marker's word (0.3 → "w3").
 *   Every utterance is dispatched (SEND) and recorded.
 *
 * The voice detector is synthetic too: a frame is speech when its level is
 * above 0.05. No microphone, model, provider or network is used.
 */

/** Samples per second of every stream. */
const sampleRate = 16_000;

/** A synthetic voice detector: speech when the frame's level is above 0.05. */
export class LevelDetector {
  closed = false;
  /** Resolves pending `probability` calls; set to hold the detector back. */
  gate?: Promise<void>;
  /** Frames currently held back by `gate`. */
  held = 0;

  async probability(frame: Float32Array): Promise<number> {
    if (this.gate) {
      this.held++;
      await this.gate;
      this.held--;
    }
    let peak = 0;
    for (const sample of frame) {
      peak = Math.max(peak, Math.abs(sample));
    }
    return peak > 0.05 ? 0.95 : 0;
  }

  reset(): void {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * 16-bit little-endian samples: `speechMs` of a square wave at `marker`'s
 * amplitude, then `silenceMs` of silence (enough to end the utterance).
 */
export function utterance(marker: number, speechMs = 640, silenceMs = 480): Buffer {
  const speechSamples = (sampleRate * speechMs) / 1000;
  const silenceSamples = (sampleRate * silenceMs) / 1000;
  const bytes = Buffer.alloc((speechSamples + silenceSamples) * 2);
  const level = Math.round(marker * 32767);

  for (let index = 0; index < speechSamples; index++) {
    bytes.writeInt16LE(index % 2 === 0 ? level : -level, index * 2);
  }
  return bytes;
}

/** Split sound into pieces of `pieceBytes` (100 ms by default), as a browser sends it. */
export function pieces(bytes: Buffer, pieceBytes = 3200): Buffer[] {
  const result: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += pieceBytes) {
    result.push(bytes.subarray(offset, offset + pieceBytes));
  }
  return result;
}

/** The test recogniser: each marker level in the audio becomes one word. */
function transcriptFor(samples: Float32Array): string {
  const words: string[] = [];
  for (const sample of samples) {
    const marker = Math.round(Math.abs(sample) * 10);
    if (marker === 0) {
      continue;
    }
    const word = `w${marker}`;
    if (words.at(-1) !== word) {
      words.push(word);
    }
  }
  return words.join(' ');
}

export interface Dispatch {
  utterance: string;
}

export interface MicrophonesFixtureOptions {
  /** How far a stream's sound may fall behind real time before it ends as `stalled`. */
  maximumLagMs?: number;
  /** Browser voice detectors finish loading only once this settles. */
  detectorsLoaded?: Promise<void>;
}

export function microphonesFixture(
  runtime: DesktopRuntime,
  pause: PauseControl,
  options: MicrophonesFixtureOptions = {},
) {
  const controller = new AbortController();
  const dispatched: Dispatch[] = [];
  const detectors: LevelDetector[] = [];
  const logs: { stage: string; detail: string }[] = [];
  const log = (stage: string, detail: string) => {
    logs.push({ stage, detail });
  };

  const router = new UserSensorRouter(
    { detector: testDetector({ detect: async () => 'SEND' }) },
    () => {},
  );
  processor('IGNORE').subscribe(router);
  const activity = runtime.activity;
  processor('SEND', async (frame) => {
    dispatched.push({ utterance: frame.utterance });
    // As a real processor does, so the runtime publishes the Activity entry.
    activity.outcome?.(frame.id, 'sent');
  }).subscribe(router);

  const pipeline = new SensorPipeline(
    {
      ...testSensors({
        capture: async () => screenshot,
        transcribe: async (samples) => transcriptFor(samples),
      }),
      router,
    },
    log,
    controller.signal,
    activity,
  );

  const createDetector = async () => {
    await options.detectorsLoaded;
    const detector = new LevelDetector();
    detectors.push(detector);
    return detector as unknown as VoiceActivityDetector;
  };

  const computer = new ComputerMicrophoneSwitch();
  const speech = new SpeechIndicator((speaking) => activity.speechChanged?.(speaking));
  const computerActivity = { ...activity, speechChanged: speech.reporter(computerMicrophone) };
  const browsers = new BrowserMicrophones({
    pipeline,
    pause,
    signal: controller.signal,
    createVad: createDetector,
    activity,
    speech,
    log,
    maximumLagMs: options.maximumLagMs,
  });
  runtime.connectMicrophones({ computer, browsers });

  // The computer's "recorder" of the current period; undefined between periods.
  let computerSource: NetworkAudioSource | undefined;
  let computerPeriods = 0;
  const computerDetector = new LevelDetector();

  const loop = listenToMicrophone({
    signal: controller.signal,
    pause,
    vad: computerDetector as unknown as VoiceActivityDetector,
    listen: (listeningSignal, handoff) =>
      listenWhileSwitchedOn(computer, listeningSignal, handoff, (periodEnd) => {
        const source = new NetworkAudioSource(60_000);
        computerSource = source;
        computerPeriods++;
        return listen(
          computerDetector as unknown as VoiceActivityDetector,
          pipeline,
          log,
          listeningSignal,
          { source: (signal) => source.frames(signal), handoff: periodEnd },
          computerActivity,
        ).finally(() => {
          if (computerSource === source) {
            computerSource = undefined;
          }
        });
      }),
    idle: () => pipeline.idle(),
    log,
  }).catch(() => {
    // The loop ends only by throwing, at shutdown.
  });

  return {
    pipeline,
    computer,
    browsers,
    detectors,
    dispatched,
    logs,
    /** Periods the computer's microphone has started so far. */
    get computerPeriods() {
      return computerPeriods;
    },
    /** Whether the computer's microphone has a running period now. */
    get computerListening() {
      return computerSource !== undefined;
    },
    /** Speak into the computer's microphone; lost when it has no period. */
    sayOnComputer(bytes: Buffer): boolean {
      const source = computerSource;
      if (!source) {
        return false;
      }
      for (const piece of pieces(bytes)) {
        source.push(piece);
      }
      return true;
    },
    async close() {
      controller.abort();
      await browsers.close();
      await loop;
      await pipeline.idle();
    },
  };
}
