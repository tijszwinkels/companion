import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command } from '../../system/command.ts';
import { encodeWav } from './segmenter.ts';

export interface AsrConfig {
  binary: string;
  modelDir: string;
  timeoutMs: number;
}

/** Extract the transcript from the output format of Voxtype 1.0.1. */
export function parseVoxtype(stdout: string): string {
  // Strip terminal decoration before checking the expected output boundaries.
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '').replaceAll('\r', '');

  if (clean.includes('No speech detected, skipping transcription.')) {
    return '';
  }

  if (!/^Loading audio file:/m.test(clean) || !/^Processing \d+ samples/m.test(clean)) {
    throw Error('Unrecognized Voxtype output (expected 1.0.1)');
  }

  // Status lines precede a blank line; only the following text is speech.
  const boundary = clean.indexOf('\n\n', clean.indexOf('Processing '));
  if (boundary < 0) {
    throw Error('Voxtype transcript delimiter missing');
  }

  const text = clean.slice(boundary + 2).trim();
  if (text.length > 4000) {
    throw Error('Transcript exceeds 4000 characters');
  }

  // Punctuation-only output is not a usable utterance.
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

/** Converts one segmented utterance to text using local Parakeet transcription. */
export class Transcriber {
  constructor(private readonly config: AsrConfig) {}

  async transcribe(samples: Float32Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();

    if (samples.length > 16000 * 31) {
      throw Error('Utterance exceeds 31 seconds');
    }

    // Silero is the primary speech filter. This cheap energy check also prevents
    // digital silence from causing a model load or a hallucinated transcript.
    const energy = samples.reduce((sum, value) => sum + value * value, 0);
    if (!samples.length || Math.sqrt(energy / samples.length) < 0.0005) {
      return '';
    }

    const dir = await mkdtemp(join(tmpdir(), 'companion-asr-'));

    try {
      const configPath = join(dir, 'voxtype.toml');

      // Use Voxtype only for transcription. Its own hotkeys and output delivery
      // must stay disabled because the router's selected processor owns typing.
      await writeFile(
        configPath,
        `engine = "parakeet"
state_file = "disabled"
[hotkey]
enabled = false
[audio]
pause_media = false
[parakeet]
model = ${JSON.stringify(this.config.modelDir)}
[output]
mode = "file"
file_path = "/dev/null"
fallback_to_clipboard = false
auto_submit = false
wait_for_modifier_release = false
`,
      );

      const wavPath = join(dir, 'utterance.wav');
      await writeFile(wavPath, encodeWav(samples));

      const stdout = await command(
        this.config.binary,
        ['-q', '-c', configPath, 'transcribe', '--engine', 'parakeet', wavPath],
        AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
        128 * 1024,
      );

      return parseVoxtype(stdout.toString());
    } finally {
      // The command helper settles after child exit, so deletion cannot race
      // Voxtype still reading the WAV. This also cleans up timeout/cancel paths.
      await rm(dir, { recursive: true, force: true });
    }
  }
}
