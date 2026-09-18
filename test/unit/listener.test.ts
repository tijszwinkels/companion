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
        () => {},
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
    } finally {
      controller.abort();
      await pipeline.idle();
      await vad.close();
    }
  });
}
