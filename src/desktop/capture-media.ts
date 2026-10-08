import { crc32, inflateSync } from 'node:zlib';

import { SAMPLE_RATE } from '../sensors/audio/segmenter.ts';

/**
 * Checks that a saved original capture is complete enough to be used as a
 * labeled example (docs/capture-storage.md). They are bounded checks of the
 * formats Companion itself writes, not general decoders: a file that is
 * truncated, cut to its signature, has a damaged chunk or compressed stream,
 * or declares an unsupported encoding is refused.
 */

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The most chunks a screenshot may have; real ones have a handful. */
const maximumPngChunks = 100_000;

/**
 * The largest decompressed image accepted: a 16K × 4K RGBA screenshot is
 * about 256 MiB. Larger claims are refused before inflating anything.
 */
const maximumPngImageBytes = 256 * 1024 * 1024;

/** Allowed bit depths per PNG colour type, and its channels per pixel. */
const pngColourTypes = new Map<number, { depths: number[]; channels: number }>([
  [0, { depths: [1, 2, 4, 8, 16], channels: 1 }],
  [2, { depths: [8, 16], channels: 3 }],
  [3, { depths: [1, 2, 4, 8], channels: 1 }],
  [4, { depths: [8, 16], channels: 2 }],
  [6, { depths: [8, 16], channels: 4 }],
]);

/** Adam7 passes: x start, y start, x step, y step. */
const adam7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

interface PngHeader {
  width: number;
  height: number;
  bitsPerPixel: number;
  interlaced: boolean;
  palette: boolean;
  colourType: number;
  depth: number;
}

/** A valid IHDR body: supported size, depth/colour type and methods. */
function pngHeader(body: Buffer): PngHeader | undefined {
  if (body.length !== 13) {
    return undefined;
  }
  const width = body.readUInt32BE(0);
  const height = body.readUInt32BE(4);
  const depth = body[8];
  const colourType = pngColourTypes.get(body[9]);
  const compression = body[10];
  const filter = body[11];
  const interlace = body[12];

  if (
    width === 0 ||
    height === 0 ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    !colourType ||
    !colourType.depths.includes(depth) ||
    compression !== 0 ||
    filter !== 0 ||
    interlace > 1
  ) {
    return undefined;
  }

  return {
    width,
    height,
    bitsPerPixel: depth * colourType.channels,
    interlaced: interlace === 1,
    palette: body[9] === 3,
    colourType: body[9],
    depth,
  };
}

/** Scanline rows (width, height) of the image or of each Adam7 pass. */
function pngPasses(header: PngHeader): [number, number][] {
  if (!header.interlaced) {
    return [[header.width, header.height]];
  }
  const passes: [number, number][] = [];
  for (const [x, y, xStep, yStep] of adam7) {
    const width = Math.ceil((header.width - x) / xStep);
    const height = Math.ceil((header.height - y) / yStep);
    if (width > 0 && height > 0) {
      passes.push([width, height]);
    }
  }
  return passes;
}

/**
 * The decompressed image data must have exactly the size the header implies,
 * and every scanline must start with a known filter type (0–4).
 */
function pngImageDataComplete(header: PngHeader, compressed: Buffer): boolean {
  const passes = pngPasses(header);
  let expected = 0;
  for (const [width, height] of passes) {
    expected += height * (1 + Math.ceil((width * header.bitsPerPixel) / 8));
  }
  if (expected > maximumPngImageBytes) {
    return false;
  }

  let image: Buffer;
  try {
    // The zlib stream's own checksum is verified; output is capped at the
    // expected size plus one byte, so extra data is detected without growth.
    // Node's public `info` option returns both objects; the Buffer-only
    // overload in @types/node does not yet describe that return shape.
    const inflated = inflateSync(compressed, {
      maxOutputLength: expected + 1,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.engine.bytesWritten !== compressed.length) {
      return false;
    }
    image = inflated.buffer;
  } catch {
    return false;
  }
  if (image.length !== expected) {
    return false;
  }

  let offset = 0;
  for (const [width, height] of passes) {
    const rowBytes = 1 + Math.ceil((width * header.bitsPerPixel) / 8);
    for (let row = 0; row < height; row++) {
      if (image[offset] > 4) {
        return false;
      }
      offset += rowBytes;
    }
  }
  return true;
}

/**
 * A complete PNG: the signature; a valid IHDR first; a PLTE before the image
 * data when the colour type needs one; one run of consecutive IDAT chunks
 * whose zlib stream decompresses to exactly the image the header describes;
 * and an IEND. Every chunk lies inside the file with a matching CRC. Bytes
 * after IEND are ignored, as decoders do.
 */
export function completePng(file: Buffer): boolean {
  if (
    file.length > maximumPngImageBytes ||
    file.length < pngSignature.length ||
    !file.subarray(0, 8).equals(pngSignature)
  ) {
    return false;
  }

  let offset = pngSignature.length;
  let header: PngHeader | undefined;
  let palette = false;
  const imageData: Buffer[] = [];
  let imageDataEnded = false;

  for (let chunks = 0; chunks < maximumPngChunks; chunks++) {
    // Length, type, data and CRC must all lie inside the file.
    if (offset + 12 > file.length) {
      return false;
    }
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > file.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) {
      return false;
    }
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (crc32(file.subarray(offset + 4, offset + 8 + length)) !== file.readUInt32BE(end - 4)) {
      return false;
    }

    if (chunks === 0) {
      header = type === 'IHDR' ? pngHeader(body) : undefined;
      if (!header) {
        return false;
      }
    } else if (type === 'IHDR') {
      return false;
    }

    if (type === 'PLTE') {
      if (
        palette ||
        imageData.length > 0 ||
        header!.colourType === 0 ||
        header!.colourType === 4 ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768 ||
        (header!.palette && length / 3 > 2 ** header!.depth)
      ) {
        return false;
      }
      palette = true;
    }

    // Unknown critical chunks can change how the image must be decoded.
    // Ancillary metadata does not affect these original-media checks.
    if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
      return false;
    }

    if (type === 'IDAT') {
      // Image data must be one consecutive run of IDAT chunks.
      if (imageDataEnded || (header!.palette && !palette)) {
        return false;
      }
      imageData.push(body);
    } else if (imageData.length) {
      imageDataEnded = true;
    }

    if (type === 'IEND') {
      return (
        length === 0 &&
        imageData.length > 0 &&
        pngImageDataComplete(header!, Buffer.concat(imageData))
      );
    }

    offset = end;
  }

  return false;
}

/**
 * A complete WAV as Companion records it: RIFF/WAVE whose declared size fits
 * the file, and, inside that declared extent, a PCM `fmt ` chunk for 16 kHz
 * mono 16-bit audio followed by a nonempty `data` chunk of whole samples.
 */
export function completeWav(file: Buffer): boolean {
  if (
    file.length < 12 ||
    file.toString('latin1', 0, 4) !== 'RIFF' ||
    file.toString('latin1', 8, 12) !== 'WAVE'
  ) {
    return false;
  }

  // Chunks outside the RIFF container's declared size do not belong to it.
  const riffEnd = 8 + file.readUInt32LE(4);
  if (riffEnd < 12 || riffEnd > file.length || riffEnd % 2 !== 0) {
    return false;
  }

  let offset = 12;
  let format = false;
  let data = false;

  while (offset + 8 <= riffEnd) {
    const type = file.toString('latin1', offset, offset + 4);
    const length = file.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + (length % 2);
    if (paddedEnd > riffEnd) {
      return false;
    }

    if (type === 'fmt ') {
      if (format || data) {
        return false;
      }
      format =
        length >= 16 &&
        file.readUInt16LE(start) === 1 &&
        file.readUInt16LE(start + 2) === 1 &&
        file.readUInt32LE(start + 4) === SAMPLE_RATE &&
        file.readUInt32LE(start + 8) === SAMPLE_RATE * 2 &&
        file.readUInt16LE(start + 12) === 2 &&
        file.readUInt16LE(start + 14) === 16;
      if (!format) {
        return false;
      }
    }
    if (type === 'data') {
      if (!format || data || length === 0 || length % 2 !== 0) {
        return false;
      }
      data = true;
    }

    // Chunks are padded to an even length.
    offset = paddedEnd;
  }

  return offset === riffEnd && format && data;
}
