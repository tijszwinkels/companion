import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Screenshot } from '../core/frame.ts';

/**
 * Save the detector's original PNG under its utterance UUID. Paths are relative
 * to the data root so moving ~/companion preserves every database reference.
 */
export async function saveScreenshot(
  directory: string,
  id: string,
  observedAt: number,
  screenshot: Screenshot,
): Promise<string> {
  const date = new Date(observedAt);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const relativePath = join('data', `${year}-${month}-${day}`, 'screenshots', `${id}.png`);
  const path = join(directory, relativePath);
  const temporary = `${path}.tmp`;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  try {
    // The sequential sensor worker owns this UUID. Publish only a complete PNG;
    // its database reference is written by the caller after this promise resolves.
    await writeFile(temporary, screenshot.png, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }

  return relativePath;
}
