import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Log } from '../core/frame.ts';
import { encodeWav } from '../sensors/audio/segmenter.ts';
import { command } from '../system/command.ts';

export type SoundCue = 'processing' | 'sent' | 'ignored';

/** Brief, quiet synthesized cues need no downloaded or licensed sound assets. */
export function soundSamples(cue: SoundCue): Float32Array {
  const frequencies = cue === 'processing' ? [660] : cue === 'sent' ? [660, 880] : [440, 330];
  const noteSamples = 960; // 60 ms at 16 kHz, safely below the VAD speech minimum.
  const gapSamples = 240;
  const samples = new Float32Array(frequencies.length * (noteSamples + gapSamples));

  for (const [note, frequency] of frequencies.entries()) {
    for (let index = 0; index < noteSamples; index++) {
      const envelope = Math.sin((Math.PI * index) / noteSamples) ** 2;
      samples[note * (noteSamples + gapSamples) + index] =
        0.12 * envelope * Math.sin((2 * Math.PI * frequency * index) / 16000);
    }
  }

  return samples;
}

/** Playback never blocks speech processing; failures are logged without losing text. */
export class SoundFeedback {
  private directory?: string;
  private playing = Promise.resolve();

  constructor(
    private readonly log: Log,
    private readonly signal: AbortSignal,
  ) {}

  async initialize(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'companion-sounds-'));

    for (const cue of ['processing', 'sent', 'ignored'] as const) {
      await writeFile(join(this.directory, `${cue}.wav`), encodeWav(soundSamples(cue)));
    }
  }

  play(cue: SoundCue): void {
    const directory = this.directory;

    if (!directory || this.signal.aborted) {
      return;
    }

    // Preserve cue order and keep cues from masking one another.
    this.playing = this.playing
      .then(async () => {
        await command(
          'pw-play',
          [join(directory, `${cue}.wav`)],
          AbortSignal.any([this.signal, AbortSignal.timeout(2000)]),
        );
      })
      .catch((error) => {
        if (!this.signal.aborted) {
          this.log('sound', String(error));
        }
      });
  }

  async close(): Promise<void> {
    await this.playing;

    if (this.directory) {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}
