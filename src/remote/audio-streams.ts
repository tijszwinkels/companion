/**
 * The gateway's audio streams: who may listen, and how fast.
 *
 * Inputs:  `claim(deviceId, holder)` when a connection asks to start a stream
 *          (`audio-start`), `release(holder)` when its stream ends;
 *          `AudioRate.take(bytes)` for each binary message of a stream.
 * Outputs: whether the stream may start, and whether a piece fits the rate.
 *
 * Rules (src/remote/README.md, "Listening browsers"):
 * - One stream per paired device. Two tabs of one browser would hear the
 *   same microphone, so a second connection of the same device that starts
 *   a stream takes it over: the earlier holder is told (`takenOver`) and
 *   must end its stream before `claim` returns.
 * - At most `maximumAudioStreams` streams in total, starting ones included.
 *   A new device over the limit is refused; nothing is taken from another
 *   device.
 * - Each stream may send at most `audioRealTimeFactor` times real time on
 *   average, with bursts of up to `audioBurstSeconds` of sound. This is
 *   counted apart from the request rate limit (request-rate.ts): ten pieces
 *   a second would exhaust that bucket.
 *
 * Memory: one entry per stream, removed when it ends.
 */

import {
  audioBurstSeconds,
  audioBytesPerSecond,
  audioRealTimeFactor,
  maximumAudioStreams,
} from './protocol.ts';

/** A connection that holds (or is starting) a stream. */
export interface AudioStreamHolder {
  /**
   * Another connection of the same device took the stream over. End this
   * stream now, synchronously, and tell the client why.
   */
  takenOver(): void;
}

export class AudioStreamRegistry {
  /** The holder of each device's stream. */
  private readonly holders = new Map<string, AudioStreamHolder>();
  /** The device of each holder. */
  private readonly devices = new Map<AudioStreamHolder, string>();

  constructor(private readonly maximumStreams = maximumAudioStreams) {}

  /** Streams held or starting now. */
  get size(): number {
    return this.holders.size;
  }

  /**
   * Let `holder` hold `deviceId`'s stream. The device's earlier holder, if
   * another, is taken over first. `total` when `maximumStreams` other devices
   * already hold one (nothing changes then).
   */
  claim(deviceId: string, holder: AudioStreamHolder): 'claimed' | 'total' {
    const current = this.holders.get(deviceId);
    if (current === holder) {
      return 'claimed';
    }

    if (!current && this.holders.size >= this.maximumStreams) {
      return 'total';
    }

    if (current) {
      // Release first: the earlier holder's own release is then a no-op.
      this.release(current);
      current.takenOver();
    }

    this.holders.set(deviceId, holder);
    this.devices.set(holder, deviceId);
    return 'claimed';
  }

  /** The holder's stream ended. Idempotent; a taken-over holder holds nothing. */
  release(holder: AudioStreamHolder): void {
    const deviceId = this.devices.get(holder);
    if (deviceId === undefined) {
      return;
    }

    this.devices.delete(holder);
    if (this.holders.get(deviceId) === holder) {
      this.holders.delete(deviceId);
    }
  }
}

/**
 * The rate bound of one stream: a token bucket in bytes of sound. It holds
 * `audioBurstSeconds` of real-time sound, starts full, and refills at
 * `audioRealTimeFactor` times real time. `now` is a monotonic clock in
 * milliseconds; tests inject their own.
 */
export class AudioRate {
  private readonly capacityBytes = audioBytesPerSecond * audioBurstSeconds;
  private readonly refillBytesPerMillisecond = (audioBytesPerSecond * audioRealTimeFactor) / 1000;
  private tokens = this.capacityBytes;
  private updatedAt: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.updatedAt = now();
  }

  /** Take `bytes`; false (taking nothing) when the stream is over its rate. */
  take(bytes: number): boolean {
    const now = this.now();
    // A clock that goes back must not drain the bucket.
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(
      this.capacityBytes,
      this.tokens + elapsed * this.refillBytesPerMillisecond,
    );
    this.updatedAt = now;

    if (bytes > this.tokens) {
      return false;
    }
    this.tokens -= bytes;
    return true;
  }
}
