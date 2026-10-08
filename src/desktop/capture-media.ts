import { crc32 } from 'node:zlib';

import { SAMPLE_RATE } from '../sensors/audio/segmenter.ts';

/**
 * Checks that a saved original capture is complete enough to be used as a
 * labeled example (docs/capture-storage.md). They are structural, bounded
 * checks of the formats Companion itself writes, not general decoders: a
 * file truncated, cut to its signature or with a damaged chunk is refused.
 */

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The most chunks a screenshot may have; real ones have a handful. */
const maximumPngChunks = 100_000;

/**
 * A complete PNG: the signature, an IHDR chunk with a nonzero size first,
 * at least one nonempty IDAT, and an IEND chunk, every chunk within the file
 * and with a matching CRC. Bytes after IEND are ignored, as decoders do.
 */
export function completePng(file: Buffer): boolean {
  if (file.length < pngSignature.length || !file.subarray(0, 8).equals(pngSignature)) {
    return false;
  }

  let offset = pngSignature.length;
  let chunks = 0;
  let imageData = false;

  while (chunks < maximumPngChunks) {
    // Length, type, data and CRC must all lie inside the file.
    if (offset + 12 > file.length) {
      return false;
    }
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > file.length) {
      return false;
    }

    const typeAndData = file.subarray(offset + 4, offset + 8 + length);
    if (crc32(typeAndData) !== file.readUInt32BE(offset + 8 + length)) {
      return false;
    }

    if (chunks === 0) {
      const width = length === 13 ? file.readUInt32BE(offset + 8) : 0;
      const height = length === 13 ? file.readUInt32BE(offset + 12) : 0;
      if (type !== 'IHDR' || width === 0 || height === 0) {
        return false;
      }
    }
    if (type === 'IDAT' && length > 0) {
      imageData = true;
    }
    if (type === 'IEND') {
      return imageData;
    }

    offset = end;
    chunks++;
  }

  return false;
}

/**
 * A complete WAV as Companion records it: RIFF/WAVE, a PCM `fmt ` chunk for
 * 16 kHz mono 16-bit audio, and a nonempty `data` chunk of whole samples that
 * lies inside the file. The RIFF size may not claim more than the file holds.
 */
export function completeWav(file: Buffer): boolean {
  if (
    file.length < 12 ||
    file.toString('latin1', 0, 4) !== 'RIFF' ||
    file.toString('latin1', 8, 12) !== 'WAVE' ||
    file.readUInt32LE(4) + 8 > file.length
  ) {
    return false;
  }

  let offset = 12;
  let format = false;

  while (offset + 8 <= file.length) {
    const type = file.toString('latin1', offset, offset + 4);
    const length = file.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > file.length) {
      return false;
    }

    if (type === 'fmt ') {
      format =
        length >= 16 &&
        file.readUInt16LE(start) === 1 &&
        file.readUInt16LE(start + 2) === 1 &&
        file.readUInt32LE(start + 4) === SAMPLE_RATE &&
        file.readUInt16LE(start + 14) === 16;
    }
    if (type === 'data') {
      return format && length > 0 && length % 2 === 0;
    }

    // Chunks are padded to an even length.
    offset = end + (length % 2);
  }

  return false;
}
