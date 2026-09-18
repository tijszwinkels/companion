// Opt-in: records ~1 s of microphone audio, opens two fields, calls the local LLM,
// and types only into those fields. --prefix-only skips audio and the model.
// Run inside the Hyprland desktop session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { command } from '../../src/system/command.ts';
import { loadConfig } from '../../src/config.ts';
import { activeWindow, captureActiveWindow } from '../../src/sensors/screen/capture.ts';
import { audioFrames } from '../../src/sensors/audio/capture.ts';
import { VoiceActivityDetector } from '../../src/sensors/audio/vad.ts';
import { Segmenter } from '../../src/sensors/audio/segmenter.ts';
import { Transcriber } from '../../src/sensors/audio/transcriber.ts';
import { IntentDetector } from '../../src/core/intent-detector.ts';
import { testDetector } from '../helpers.ts';
import { UserSensorRouter } from '../../src/core/router.ts';
import { DeliveryInterruptedError } from '../../src/core/delivery-error.ts';
import { SendTextToApplication } from '../../src/processors/send-text-to-application.ts';
import { EnterTextToApplication } from '../../src/processors/enter-text-to-application.ts';
import { Ignore } from '../../src/processors/ignore.ts';
import type { Log } from '../../src/core/frame.ts';

const prefixOnly = process.argv.includes('--prefix-only');
const signal = AbortSignal.timeout(60000);
const previous = await activeWindow(signal);
const directory = await mkdtemp(join(tmpdir(), 'companion-live-'));
const gui = spawn(
  '/usr/bin/python',
  [fileURLToPath(new URL('./text-field.py', import.meta.url)), directory],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let guiError = '';
gui.stderr.on('data', (chunk) => {
  guiError += chunk;
});
gui.on('error', (error) => {
  guiError += error.message;
});
const closed = new Promise<void>((resolve) => gui.once('close', () => resolve()));
const log: Log = (stage, message) => console.log(`${stage}: ${message}`);
const focusArgs = (address: string) => {
  assert.match(address, /^0x[0-9a-f]+$/i);
  return ['dispatch', `hl.dsp.focus({ window = "address:${address}" })`];
};
const focus = async (address: string) => {
  await command('hyprctl', focusArgs(address), signal);
  await delay(150, undefined, { signal });
  assert.equal((await activeWindow(signal)).address, address);
};
let vad: VoiceActivityDetector | undefined;
let transcriber: Transcriber | undefined;
try {
  let windows: { title: string; address: string; mapped: boolean; hidden: boolean }[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const clients = JSON.parse(
      (await command('hyprctl', ['-j', 'clients'], signal)).toString(),
    ) as typeof windows;
    windows = clients.filter(
      (client) => client.title.endsWith(directory) && client.mapped && !client.hidden,
    );
    if (windows.length === 2) {
      break;
    }
    await delay(100, undefined, { signal });
  }
  assert.equal(windows.length, 2, `Test windows unavailable: ${guiError}`);
  const a = windows.find((window) => window.title.startsWith('Companion test A'))!;
  const b = windows.find((window) => window.title.startsWith('Companion test B'))!;
  await focus(a.address);
  const texts = () => readFile(join(directory, 'text.json'), 'utf8').then(JSON.parse);
  let expectedText = '';

  if (!prefixOnly) {
    const config = await loadConfig();
    let microphoneFrames = 0;
    for await (const _frame of audioFrames(signal)) {
      if (++microphoneFrames === 32) {
        break;
      }
    }
    console.log(`PASS microphone: ${microphoneFrames} PCM frames`);

    vad = await VoiceActivityDetector.create(config.vadModel);
    const segmenter = new Segmenter();
    const segments: Float32Array[] = [];
    for await (const frame of audioFrames(signal, {
      file: fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url)),
    })) {
      const segment = segmenter.push(await vad.probability(frame), frame);
      if (segment) {
        segments.push(segment.samples);
      }
    }
    const tail = segmenter.finish();
    if (tail) {
      segments.push(tail.samples);
    }
    assert.ok(segments.length > 0);
    transcriber = new Transcriber(config.asr);
    await transcriber.start(signal);
    const speech = await transcriber.transcribe(segments[0], signal);
    assert.match(speech, /Dublin/i);
    console.log(`PASS VAD + ASR: ${JSON.stringify(speech)}`);

    const screenshot = await captureActiveWindow(signal);
    const detector = new IntentDetector(config.llm);
    const router = new UserSensorRouter({ detector }, log);
    new SendTextToApplication(log).subscribe(router);
    new Ignore(log).subscribe(router);
    assert.equal(
      await router.route({ id: 1, observedAt: Date.now(), utterance: speech, screenshot }, signal),
      'IGNORE',
    );

    const utterance = 'Please type this message: Hello from Companion.';
    const frame = { id: 2, observedAt: Date.now(), utterance, screenshot };
    assert.equal(await router.route(frame, signal), 'SEND_TEXT_TO_APPLICATION');
    await delay(200, undefined, { signal });
    assert.deepEqual(await texts(), { A: utterance, B: '' });
    console.log('PASS actual text delivery: exact utterance, no Enter');

    const switchedRouter = new UserSensorRouter(
      {
        detector: testDetector({
          detect: async (...args) => {
            const name = await detector.detect(...args);
            await focus(b.address);
            return name;
          },
        }),
      },
      log,
    );
    new SendTextToApplication(log).subscribe(switchedRouter);
    new Ignore(log).subscribe(switchedRouter);
    assert.equal(
      await switchedRouter.route({ ...frame, id: 3 }, signal),
      'SEND_TEXT_TO_APPLICATION',
    );
    await delay(200, undefined, { signal });
    assert.deepEqual(await texts(), { A: utterance, B: '' });
    console.log('PASS focus change after inference: neither field receives text');
    expectedText = utterance;
  }

  // A detector that fails if called proves that the shortcuts do not need a
  // working model. Real screenshots and wtype still exercise the desktop path.
  const noInference = { detect: async () => assert.fail('Prefix called the LLM') };
  const prefixRouter = new UserSensorRouter({ detector: testDetector(noInference) }, log);
  new SendTextToApplication(log).subscribe(prefixRouter);
  new EnterTextToApplication(log).subscribe(prefixRouter);

  await focus(a.address);
  const screenshot = await captureActiveWindow(signal);
  const prefixFrame = { id: 4, observedAt: Date.now(), utterance: 'Insert, hello ', screenshot };
  assert.equal(await prefixRouter.route(prefixFrame, signal), 'SEND_TEXT_TO_APPLICATION');
  expectedText += 'hello ';
  await delay(200, undefined, { signal });
  assert.deepEqual(await texts(), { A: expectedText, B: '' });
  console.log('PASS insert prefix: command removed, exact payload, no Enter, no inference');

  await prefixRouter.route({ ...prefixFrame, id: 5, utterance: 'ENTER world' }, signal);
  expectedText += 'world\n';
  await delay(200, undefined, { signal });
  assert.deepEqual(await texts(), { A: expectedText, B: '' });
  console.log('PASS enter prefix: payload followed by one actual Enter, no inference');

  await focus(b.address);
  await prefixRouter.route({ ...prefixFrame, id: 6, utterance: 'enter must not appear' }, signal);
  await delay(200, undefined, { signal });
  assert.deepEqual(await texts(), { A: expectedText, B: '' });
  console.log('PASS prefix focus mismatch: no text and no Enter');

  // Move focus after the real text command has completed. The processor must
  // check again and suppress Return, leaving the second disposable field empty.
  await focus(a.address);
  const switchedEnter = new EnterTextToApplication(log, false, async (file, args, signal) => {
    const result = await command(file, args, signal);
    if (file === 'wtype' && args[0] === '--') {
      await focus(b.address);
    }
    return result;
  });
  const switchedPrefixRouter = new UserSensorRouter({ detector: testDetector(noInference) }, log);
  switchedEnter.subscribe(switchedPrefixRouter);
  await assert.rejects(
    switchedPrefixRouter.route({ ...prefixFrame, id: 7, utterance: 'enter stay here' }, signal),
    DeliveryInterruptedError,
  );
  expectedText += 'stay here';
  await delay(200, undefined, { signal });
  assert.deepEqual(await texts(), { A: expectedText, B: '' });
  console.log('PASS focus change during typing: text stays in A, no Enter in B');
} finally {
  gui.kill('SIGKILL');
  await closed;
  await transcriber?.close();
  await vad?.close();
  await command('hyprctl', focusArgs(previous.address), AbortSignal.timeout(3000)).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
