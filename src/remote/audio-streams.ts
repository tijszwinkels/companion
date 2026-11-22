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
 * - Each device may send at most `audioRealTimeFactor` times real time on
 *   average, with bursts of up to `audioBurstSeconds` of sound. The budget
 *   is the device's (`rate`), so starting a new stream or taking one over
 *   does not refill it; the gateway forgets it with the device's last
 *   connection, as it does the request buckets. Every message costs at least
 *   `minimumAudioPieceBytes`. This is counted apart from the request rate
 *   limit (request-rate.ts): ten pieces a second would exhaust that bucket.
 *
 * Memory: one entry per stream, removed when it ends; one budget per
 * connected device that has streamed.
 */

import {
  audioBurstSeconds,
  audioBytesPerSecond,
  audioRealTimeFactor,
  maximumAudioStreams,
  minimumAudioPieceBytes,
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
  /** Each device's rate budget, shared by its streams one after another. */
  private readonly rates = new Map<string, AudioRate>();

  /** `now`: monotonic clock in milliseconds for the rate budgets; tests inject their own. */
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly maximumStreams = maximumAudioStreams,
  ) {}

  /** The device's rate budget; created full the first time the device streams. */
  rate(deviceId: string): AudioRate {
    let rate = this.rates.get(deviceId);
    if (!rate) {
      rate = new AudioRate(this.now);
      this.rates.set(deviceId, rate);
    }
    return rate;
  }

  /** Forget a device's budget once its last connection has closed. */
  forget(deviceId: string): void {
    this.rates.delete(deviceId);
  }

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
 * The rate bound of one device's audio: a token bucket in bytes of sound. It
 * holds `audioBurstSeconds` of real-time sound, starts full, and refills at
 * `audioRealTimeFactor` times real time. A message costs its size, but at
 * least `minimumAudioPieceBytes`. `now` is a monotonic clock in milliseconds.
 */
export class AudioRate {
  private readonly capacityBytes = audioBytesPerSecond * audioBurstSeconds;
  private readonly refillBytesPerMillisecond = (audioBytesPerSecond * audioRealTimeFactor) / 1000;
  private tokens = this.capacityBytes;
  private updatedAt: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.updatedAt = now();
  }

  /** Take one message of `bytes`; false (taking nothing) when it is over the rate. */
  take(bytes: number): boolean {
    const cost = Math.max(bytes, minimumAudioPieceBytes);
    const now = this.now();
    // A clock that goes back must not drain the bucket.
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(
      this.capacityBytes,
      this.tokens + elapsed * this.refillBytesPerMillisecond,
    );
    this.updatedAt = now;

    if (cost > this.tokens) {
      return false;
    }
    this.tokens -= cost;
    return true;
  }
}
