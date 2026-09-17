import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from './command.ts';
import { encodeWav } from './segmenter.ts';

export interface AsrConfig { binary: string; modelDir: string; timeoutMs: number }

export function parseVoxtype(stdout: string): string {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '').replaceAll('\r', '');
  if (clean.includes('No speech detected, skipping transcription.')) return '';
  if (!/^Loading audio file:/m.test(clean) || !/^Processing \d+ samples/m.test(clean)) throw Error('Unrecognized Voxtype output (expected 1.0.1)');
  const boundary = clean.indexOf('\n\n', clean.indexOf('Processing '));
  if (boundary < 0) throw Error('Voxtype transcript delimiter missing');
  const text = clean.slice(boundary + 2).trim();
  if (text.length > 4000) throw Error('Transcript exceeds 4000 characters');
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

export class Transcriber {
  constructor(private readonly config: AsrConfig) {}

  async transcribe(samples: Float32Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (samples.length > 16000 * 31) throw Error('Utterance exceeds 31 seconds');
    const energy = samples.reduce((sum, value) => sum + value * value, 0);
    if (!samples.length || Math.sqrt(energy / samples.length) < 0.0005) return '';
    const dir = await mkdtemp(join(tmpdir(), 'companion-asr-'));
    try {
      const configPath = join(dir, 'voxtype.toml');
      await writeFile(configPath, `engine = "parakeet"\nstate_file = "disabled"\n[hotkey]\nenabled = false\n[audio]\npause_media = false\n[parakeet]\nmodel = ${JSON.stringify(this.config.modelDir)}\n[output]\nmode = "file"\nfile_path = "/dev/null"\nfallback_to_clipboard = false\nauto_submit = false\nwait_for_modifier_release = false\n`);
      const wavPath = join(dir, 'utterance.wav');
      await writeFile(wavPath, encodeWav(samples));
      const stdout = await command(this.config.binary, ['-q', '-c', configPath, 'transcribe', '--engine', 'parakeet', wavPath],
        AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]), 128 * 1024);
      return parseVoxtype(stdout.toString());
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
}
