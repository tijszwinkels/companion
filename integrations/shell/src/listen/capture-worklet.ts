/**
 * The AudioWorklet of "Listen here", built on its own into
 * dist/listen-worklet.js (build.ts) and loaded by capture.ts from the
 * shell's own origin, as the page's `script-src 'self'` allows.
 *
 * It runs on the browser's audio thread. Input: the microphone, mixed down
 * to one channel by the node (capture.ts asks for one input channel).
 * Output: none to the speakers; each 100 ms piece of 16 kHz signed 16-bit
 * samples (pcm-pieces.ts) is posted to the page, its buffer transferred, not
 * copied. The page decides whether a piece is sent (listen-here.ts).
 */

import { PcmPieces } from './pcm-pieces.ts';

// The AudioWorklet global scope; not part of TypeScript's DOM library.
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class ListenHereCapture extends AudioWorkletProcessor {
  private readonly pieces = new PcmPieces(sampleRate, (piece) => {
    this.port.postMessage(piece, [piece]);
  });

  process(inputs: Float32Array[][]): boolean {
    // An input without channels: the microphone delivers nothing at this
    // moment (for example while the track is muted). Keep running.
    const channel = inputs[0]?.[0];
    if (channel) {
      this.pieces.push(channel);
    }
    // True keeps the processor alive until the page disconnects it.
    return true;
  }
}

registerProcessor('listen-here-capture', ListenHereCapture);
