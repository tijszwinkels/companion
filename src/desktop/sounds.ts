import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UtteranceDestination, UtteranceOutcome } from '../core/activity.ts';
import type { Log } from '../core/frame.ts';
import { encodeWav } from '../sensors/audio/segmenter.ts';
import { command } from '../system/command.ts';

export const soundCues = [
  'processing',
  'sent',
  'agent-sent',
  'agent-started',
  'ignored',
  'agent-completed',
] as const;
export type SoundCue = (typeof soundCues)[number];

/** Emit only after delivery/acceptance; classification and failed actions stay silent. */
export function outcomeSound(
  outcome: UtteranceOutcome,
  destination?: UtteranceDestination,
): SoundCue | undefined {
  if (outcome === 'started') {
    return destination === 'new-agent-session' ? 'agent-started' : 'agent-sent';
  }
  if (outcome === 'sent' || outcome === 'labeled') {
    return 'sent';
  }
  if (outcome === 'ignored') {
    return 'ignored';
  }
  return undefined;
}

/** Brief, quiet synthesized cues need no downloaded or licensed sound assets. */
export function soundSamples(cue: SoundCue): Float32Array {
  const frequencies = {
    processing: [660],
    sent: [660, 880],
    'agent-sent': [1046.5, 783.99],
    'agent-started': [523.25, 659.25, 783.99],
    ignored: [440, 330],
    'agent-completed': [880, 1174.66],
  }[cue];
  const noteSamples = 960; // 60 ms at 16 kHz; real-VAD tests cover each complete cue.
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
  private playback = new AbortController();

  constructor(
    private readonly log: Log,
    private readonly signal: AbortSignal,
    private playbackAllowed = true,
    private readonly run = command,
  ) {}

  get enabled(): boolean {
    return this.playbackAllowed;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.playbackAllowed) {
      return;
    }

    this.playbackAllowed = enabled;

    // Each unmuted period owns its cues. Muting stops the current player and
    // permanently cancels its queue, even if sounds are immediately re-enabled.
    this.playback.abort();
    this.playback = new AbortController();
  }

  async initialize(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'companion-sounds-'));

    for (const cue of soundCues) {
      await writeFile(join(this.directory, `${cue}.wav`), encodeWav(soundSamples(cue)));
    }
  }

  play(cue: SoundCue): void {
    const directory = this.directory;

    if (!directory || !this.enabled || this.signal.aborted) {
      return;
    }

    const playbackSignal = this.playback.signal;

    // Preserve cue order and keep cues from masking one another.
    this.playing = this.playing
      .then(async () => {
        if (playbackSignal.aborted || this.signal.aborted) {
          return;
        }

        await this.run(
          'pw-play',
          [join(directory, `${cue}.wav`)],
          AbortSignal.any([this.signal, playbackSignal, AbortSignal.timeout(2000)]),
        );
      })
      .catch((error) => {
        if (!this.signal.aborted && !playbackSignal.aborted) {
          this.log('sound', String(error));
        }
      });
  }

  async close(): Promise<void> {
    this.setEnabled(false);
    await this.playing;

    if (this.directory) {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}
