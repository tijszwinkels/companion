import assert from 'node:assert/strict';
import test from 'node:test';
import { testDetector, testSensors } from '../helpers.ts';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.ts';
import { SensorPipeline } from '../../src/core/pipeline.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { listen } from '../../src/sensors/audio/listener.ts';
import { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';

// File decoding exercises the listener without opening a microphone. Controlled
// VAD results make pause/failure timing deterministic; native resources still
// follow the production create/reset/close lifetime.
for (const ending of ['silence', 'abort', 'failure', 'eof']) {
  test(`speech feedback clears after ${ending}, including sounds too short to process`, async (context) => {
    const config = await loadConfig();
    const vad = await VoiceActivityDetector.create(config.vadModel);
    const controller = new AbortController();
    const states: boolean[] = [];
    const logs: { stage: string; detail: string }[] = [];
    let frames = 0;

    context.mock.method(vad, 'probability', async () => {
      frames++;
      if (frames === 2 && ending === 'abort') {
        controller.abort();
      }
      if (frames === 2 && ending === 'failure') {
        throw Error('VAD failed');
      }
      return frames < 3 || ending === 'eof' ? 0.95 : 0;
    });

    const pipeline = new SensorPipeline(
      {
        ...testSensors({
          capture: async () => assert.fail('No capture expected in this listener test'),
          transcribe: async () => assert.fail('No transcription expected in this listener test'),
        }),
        router: new UserSensorRouter(
          { detector: testDetector({ detect: async () => assert.fail('No inference expected') }) },
          () => {},
        ),
      },
      () => {},
      controller.signal,
    );
    const submissions = context.mock.method(pipeline, 'submit', () => true);

    try {
      const listening = listen(
        vad,
        pipeline,
        (stage, detail) => logs.push({ stage, detail }),
        controller.signal,
        { file: fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url)) },
        { speechChanged: (speaking) => states.push(speaking) },
      );

      if (ending === 'abort' || ending === 'failure') {
        await assert.rejects(listening, /abort|VAD failed/i);
      } else {
        await listening;
      }

      assert.equal(states[0], true);
      assert.equal(states.at(-1), false);
      assert.equal(states.filter(Boolean).length, 1, 'Continuous speech emits one start');
      assert.equal(submissions.mock.callCount() > 0, ending === 'eof');
      const boundary = logs.find((entry) => entry.stage === 'audio-end');
      assert.equal(
        boundary?.detail,
        ending === 'abort' ? 'cancelled' : ending === 'failure' ? 'failed' : 'eof',
      );

      if (ending === 'silence') {
        const report = logs.find((entry) => entry.stage === 'vad');
        assert.ok(report);
        assert.equal(JSON.parse(report.detail).outcome, 'too-short');
      }
    } finally {
      controller.abort();
      await pipeline.idle();
      await vad.close();
    }
  });
}

// Each scripted VAD run opens one candidate at frame 10. The listener must
// report it, then either submit it or release the hold on every exit path:
// rejection, EOF, pause and failure. A leaked hold would stall dispatch.
//
// Each resolution carries the silence measured after the candidate's speech,
// from which the commitment floor counts: 224 ms after a silence endpoint,
// none when the input ended mid-speech. A release without a measurement
// (listening ended) leaves the held attempt's deadlines unchanged.
const candidateEndings = {
  rejected: { voiced: 2, expected: ['resumed', 'discarded after 224 ms'] },
  accepted: { voiced: 6, expected: ['resumed', 'submit after 224 ms'] },
  'eof-accepted': { voiced: Infinity, expected: ['resumed', 'submit after 0 ms'] },
  // A too-short tail still open at the end of the input is a rejected burst:
  // its measured trailing silence restarts the held attempt's floor.
  'eof-rejected': {
    voiced: Infinity,
    startAtEnd: true,
    expected: ['resumed', 'discarded after 0 ms'],
  },
  'eof-rejected-after-silence': {
    voiced: 2,
    onsetFromEnd: 5,
    expected: ['resumed', 'discarded after 96 ms'],
  },
  // Five voiced frames, then three silent frames (96 ms) before the input
  // ends: exactly the silence that was heard is credited, not 0 or 224 ms.
  'eof-after-silence': { voiced: 5, onsetFromEnd: 8, expected: ['resumed', 'submit after 96 ms'] },
  abort: { voiced: 6, stopAt: 13, expected: ['resumed', 'discarded'] },
  failure: { voiced: 6, stopAt: 13, expected: ['resumed', 'discarded'] },
} as const;

for (const [ending, script] of Object.entries(candidateEndings)) {
  test(`an open VAD candidate is always resolved for the pipeline (${ending})`, async (context) => {
    const config = await loadConfig();
    const vad = await VoiceActivityDetector.create(config.vadModel);
    const controller = new AbortController();
    const calls: string[] = [];
    const totalFrames = 157; // The five-second fixture, including its padded final frame.
    let onset = 10;
    if ('startAtEnd' in script) {
      onset = totalFrames - 2;
    } else if ('onsetFromEnd' in script) {
      onset = totalFrames - script.onsetFromEnd;
    }
    let frames = 0;

    context.mock.method(vad, 'probability', async () => {
      frames++;
      if ('stopAt' in script && frames === script.stopAt) {
        if (ending === 'abort') {
          controller.abort();
        } else {
          throw Error('VAD failed');
        }
      }
      return frames > onset && frames <= onset + script.voiced ? 0.95 : 0;
    });

    const pipeline = new SensorPipeline(
      {
        ...testSensors({
          capture: async () => assert.fail('No capture expected'),
          transcribe: async () => assert.fail('No transcription expected'),
        }),
        router: new UserSensorRouter(
          { detector: testDetector({ detect: async () => assert.fail('No inference expected') }) },
          () => {},
        ),
      },
      () => {},
      controller.signal,
    );
    context.mock.method(
      pipeline,
      'submit',
      (
        _samples: Float32Array,
        _signal: AbortSignal,
        _leadIn: Float32Array,
        trailingSilenceMs: number,
      ) => {
        calls.push(`submit after ${trailingSilenceMs} ms`);
        return true;
      },
    );
    context.mock.method(pipeline, 'speechResumed', () => {
      calls.push('resumed');
    });
    context.mock.method(pipeline, 'speechDiscarded', (burstTrailingSilenceMs?: number) => {
      // Releasing is idempotent; record only the first release after an onset.
      if (calls.at(-1) === 'resumed') {
        calls.push(
          burstTrailingSilenceMs === undefined
            ? 'discarded'
            : `discarded after ${burstTrailingSilenceMs} ms`,
        );
      }
    });

    try {
      await listen(vad, pipeline, () => {}, controller.signal, {
        file: fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url)),
      }).catch((error) => {
        if (!('stopAt' in script)) {
          throw error;
        }
      });

      assert.deepEqual(calls, script.expected);
    } finally {
      controller.abort();
      await pipeline.idle();
      await vad.close();
    }
  });
}
