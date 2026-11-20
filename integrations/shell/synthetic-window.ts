/**
 * A synthetic "window" picture for the browser shell's demo and tests: a
 * PNG drawn in memory (a dark background, a title bar and a few lines of
 * placeholder text), so a kept screenshot has something to show without
 * capturing a screen or reading a file.
 */

import { crc32, deflateSync } from 'node:zlib';

/**
 * A synthetic window as a PNG (8-bit RGB): a dark background, a title bar
 * and a few lines of placeholder "text". Nothing is read from disk.
 */
export function syntheticWindowPng(width: number, height: number): Buffer {
  const background = [26, 27, 38];
  const titleBar = [41, 46, 66];
  const textLine = [115, 123, 156];
  const accent = [122, 162, 247];
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    // Each row starts with filter type 0 (none).
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      let colour = background;
      const lineIndex = Math.floor((y - 70) / 28);
      const lineLength = 520 - ((lineIndex * 97) % 260);
      if (y < 36) {
        colour = titleBar;
        if (x >= 16 && x < 28 && y >= 12 && y < 24) {
          colour = accent;
        }
      } else if (y >= 70 && (y - 70) % 28 < 10 && x >= 40 && x < 40 + lineLength) {
        colour = textLine;
      }
      row[1 + x * 3] = colour[0];
      row[2 + x * 3] = colour[1];
      row[3 + x * 3] = colour[2];
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, checksum]);
}
