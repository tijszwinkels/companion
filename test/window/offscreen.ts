import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Offscreen Qt's default screen is 800 × 800 device pixels. The native host fits
// a Window to its screen before mapping, so that default would shrink the
// standard 620 × 780 Window, especially at 125%. Tests that are not about
// monitors run on one desktop-sized screen instead.
//
// Returns the QT_QPA_PLATFORM value; the configuration lives in `directory`.
export async function offscreenPlatform(directory: string): Promise<string> {
  const path = join(directory, 'offscreen-screens.json');
  const screen = { name: '', x: 0, y: 0, width: 1600, height: 1200 };

  await writeFile(path, JSON.stringify({ screens: [screen] }));

  return 'offscreen:configfile=' + path;
}
