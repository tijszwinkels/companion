import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EmptyAudioClip } from '../core/activity.ts';
import { encodeWav, SAMPLE_RATE } from '../sensors/audio/segmenter.ts';
import { recordingDate } from './artifacts.ts';

/**
 * Retain an eligible empty ASR attempt outside the successful recordings tree.
 * The pipeline owns the samples until this promise settles. A directory rename
 * publishes the WAV and its numeric metadata together; an interrupted write
 * can leave a .tmp directory, which readers must ignore. These clips contain
 * no screenshot, window context, transcript, or inferred intent.
 */
export async function saveEmptyAudioClip(directory: string, clip: EmptyAudioClip): Promise<string> {
  const id = randomUUID();
  const parent = join(directory, 'asr-empty', recordingDate(clip.observedAt));
  const destination = join(parent, id);
  const temporary = `${destination}.tmp`;

  const metadata = {
    version: 1,
    id,
    frameId: clip.id,
    observedAt: clip.observedAt,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    diagnostic: clip.diagnostic,
  };

  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });

  try {
    // Preserve the complete segment and the same PCM16 conversion used for
    // inference. Neither gain nor segmentation changes as part of retention.
    await writeFile(join(temporary, 'audio.wav'), encodeWav(clip.samples), {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(join(temporary, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  return id;
}
