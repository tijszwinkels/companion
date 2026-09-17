// Opt-in: records ~1 s of microphone audio, opens two fields, calls the local LLM,
// and types only into those fields. Run inside the Hyprland desktop session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { command } from '../src/command.ts';
import { loadConfig } from '../src/config.ts';
import { activeWindow, captureActiveWindow } from '../src/screen.ts';
import { audioFrames } from '../src/audio.ts';
import { VoiceActivityDetector } from '../src/vad.ts';
import { Segmenter } from '../src/segmenter.ts';
import { Transcriber } from '../src/asr.ts';
import { IntentDetector } from '../src/intent-detector.ts';
import { UserSensorRouter } from '../src/router.ts';
import { SendTextToApplication, Ignore } from '../src/processors.ts';
import type { Log } from '../src/frame.ts';

const config = await loadConfig();
const signal = AbortSignal.timeout(60000);
const previous = await activeWindow(signal);
const directory = await mkdtemp(join(tmpdir(), 'companion-live-'));
const gui = spawn('/usr/bin/python', [fileURLToPath(new URL('./text-field.py', import.meta.url)), directory], { stdio: ['ignore', 'ignore', 'pipe'] });
let guiError = '';
gui.stderr.on('data', chunk => { guiError += chunk; });
gui.on('error', error => { guiError += error.message; });
const closed = new Promise<void>(resolve => gui.once('close', () => resolve()));
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
try {
  let windows: { title: string; address: string; mapped: boolean; hidden: boolean }[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const clients = JSON.parse((await command('hyprctl', ['-j', 'clients'], signal)).toString()) as typeof windows;
    windows = clients.filter(client => client.title.endsWith(directory) && client.mapped && !client.hidden);
    if (windows.length === 2) break;
    await delay(100, undefined, { signal });
  }
  assert.equal(windows.length, 2, `Test windows unavailable: ${guiError}`);
  const a = windows.find(window => window.title.startsWith('Companion test A'))!;
  const b = windows.find(window => window.title.startsWith('Companion test B'))!;
  await focus(a.address);

  let microphoneFrames = 0;
  for await (const _frame of audioFrames(signal)) if (++microphoneFrames === 32) break;
  console.log(`PASS microphone: ${microphoneFrames} PCM frames`);

  vad = await VoiceActivityDetector.create(config.vadModel);
  const segmenter = new Segmenter(), segments: Float32Array[] = [];
  for await (const frame of audioFrames(signal, { file: fileURLToPath(new URL('./fixtures/speech.wav', import.meta.url)) })) {
    const segment = segmenter.push(await vad.probability(frame), frame);
    if (segment) segments.push(segment.samples);
  }
  const tail = segmenter.finish();
  if (tail) segments.push(tail.samples);
  assert.ok(segments.length > 0);
  const speech = await new Transcriber(config.asr).transcribe(segments[0], signal);
  assert.match(speech, /Dublin/i);
  console.log(`PASS VAD + ASR: ${JSON.stringify(speech)}`);

  const screenshot = await captureActiveWindow(signal);
  const detector = new IntentDetector(config.llm);
  const router = new UserSensorRouter(detector, log);
  new SendTextToApplication(log).subscribe(router); new Ignore(log).subscribe(router);
  assert.equal(await router.route({ id: 1, observedAt: Date.now(), utterance: speech, screenshot }, signal), 'IGNORE');

  const utterance = 'Please type this message: Hello from Companion.';
  const frame = { id: 2, observedAt: Date.now(), utterance, screenshot };
  assert.equal(await router.route(frame, signal), 'SEND_TEXT_TO_APPLICATION');
  await delay(200, undefined, { signal });
  const texts = () => readFile(join(directory, 'text.json'), 'utf8').then(JSON.parse);
  assert.deepEqual(await texts(), { A: utterance, B: '' });
  console.log('PASS actual text delivery: exact utterance, no Enter');

  const switchedRouter = new UserSensorRouter({ detect: async (...args) => {
    const name = await detector.detect(...args);
    await focus(b.address);
    return name;
  } }, log);
  new SendTextToApplication(log).subscribe(switchedRouter); new Ignore(log).subscribe(switchedRouter);
  assert.equal(await switchedRouter.route({ ...frame, id: 3 }, signal), 'SEND_TEXT_TO_APPLICATION');
  await delay(200, undefined, { signal });
  assert.deepEqual(await texts(), { A: utterance, B: '' });
  console.log('PASS focus change after inference: neither field receives text');
} finally {
  gui.kill('SIGKILL'); await closed;
  await vad?.close();
  await command('hyprctl', focusArgs(previous.address), AbortSignal.timeout(3000)).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
