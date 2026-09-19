/** Public-fixture ASR benchmark only: no microphone, desktop, LLM or delivery. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { cpus, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadConfig } from '../../src/config.ts';
import { Transcriber } from '../../src/sensors/audio/transcriber.ts';
import { encodeWav } from '../../src/sensors/audio/segmenter.ts';
import { command } from '../../src/system/command.ts';

const config = await loadConfig();
const voxtype = process.env.COMPANION_BENCH_VOXTYPE ?? `${homedir()}/.local/bin/voxtype`;
const fixture = fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url));
const signal = AbortSignal.timeout(180000);
const directory = await mkdtemp(join(tmpdir(), 'companion-asr-bench-'));
const transcriber = new Transcriber(config.asr);
const run = promisify(execFile);

try {
  const version = (await command(voxtype, ['--version'], signal)).toString().trim();
  assert.equal(version, 'voxtype 1.0.1');

  const pcm = await command(
    'ffmpeg',
    ['-v', 'error', '-i', fixture, '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
    signal,
    16000 * 31 * 2,
  );
  const samples = new Float32Array(pcm.length / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = pcm.readInt16LE(index * 2) / 32768;
  }

  // Both paths receive precisely the same PCM16 quantization and model path.
  const wavPath = join(directory, 'fixture.wav');
  const configPath = join(directory, 'voxtype.toml');
  await writeFile(wavPath, encodeWav(samples));
  await writeFile(
    configPath,
    `engine = "parakeet"
state_file = "disabled"
[hotkey]
enabled = false
[audio]
pause_media = false
[parakeet]
model = ${JSON.stringify(config.asr.modelDir)}
[output]
mode = "file"
file_path = "/dev/null"
fallback_to_clipboard = false
auto_submit = false
wait_for_modifier_release = false
`,
  );

  const baselineMs: number[] = [];
  let expectedText: string | undefined;
  for (let iteration = 0; iteration < 3; iteration++) {
    const started = performance.now();
    const { stdout } = await run(
      voxtype,
      ['-q', '-c', configPath, 'transcribe', '--engine', 'parakeet', wavPath],
      { signal, timeout: config.asr.timeoutMs, maxBuffer: 128 * 1024 },
    );
    baselineMs.push(performance.now() - started);
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '').replaceAll('\r', '');
    assert.match(clean, /^Loading audio file:/m);
    assert.match(clean, /^Processing \d+ samples/m);
    const boundary = clean.indexOf('\n\n', clean.indexOf('Processing '));
    assert.ok(boundary >= 0);
    const text = clean.slice(boundary + 2).trim();
    assert.match(text, /Dublin/i);
    expectedText ??= text;
    assert.equal(text, expectedText);
  }

  const startup = performance.now();
  await transcriber.start(signal);
  const startupMs = performance.now() - startup;
  const warmMs: number[] = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    const started = performance.now();
    const text = await transcriber.transcribe(samples, signal);
    warmMs.push(performance.now() - started);
    assert.equal(text, expectedText, 'Persistent ASR changed the fixture transcript');
  }

  const modelFiles: Record<string, string> = {};
  for (const name of (await readdir(config.asr.modelDir)).sort()) {
    const bytes = await readFile(join(config.asr.modelDir, name));
    modelFiles[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const median = (values: number[]) =>
    values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

  console.log(
    JSON.stringify(
      {
        fixture: 'test/fixtures/speech.wav',
        fixtureSha256: createHash('sha256')
          .update(await readFile(fixture))
          .digest('hex'),
        audioSeconds: samples.length / 16000,
        cpu: cpus()[0].model,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        baseline: { engine: 'Voxtype 1.0.1, --engine parakeet', milliseconds: baselineMs },
        persistent: {
          engine: 'Parakeet TDT, parakeet-rs 0.3.5, CPU defaults',
          startupMs,
          warmMilliseconds: warmMs,
          startupPlusFirstMs: startupMs + warmMs[0],
        },
        medianSpeedup: median(baselineMs) / median(warmMs),
        transcript: expectedText,
        modelDir: config.asr.modelDir,
        modelFiles,
        note: 'Fresh-process baseline; OS file caches were not flushed. Warm calls share one process. Excludes VAD, ending silence, screenshot, LLM and delivery.',
      },
      null,
      2,
    ),
  );
} finally {
  await transcriber.close();
  await rm(directory, { recursive: true, force: true });
}
