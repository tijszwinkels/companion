/**
 * Rate limits per paired device, shared by all of its connections.
 *
 * Inputs:  one `take(deviceId)` call per message a connection receives from
 *          its client.
 * Outputs: whether that message may proceed now.
 *
 * The gateway keeps two independent instances of this class:
 * - requests and heartbeats: bursts of `requestBurst`, refilled at
 *   `requestsPerSecond`;
 * - draft edits (`draft-set`, one per keystroke): bursts of `draftEditBurst`,
 *   refilled at `draftEditsPerSecond`. Typing never uses up the request
 *   bucket, and a request never uses up the typing bucket.
 *
 * In each instance a device has one token bucket. A device may hold several
 * connections (browser tabs and a phone, at most
 * `maximumConnectionsPerDevice`), and they draw from the same bucket, so
 * opening more tabs never raises what one device may send.
 *
 * The gateway forgets a device's bucket when its last connection has closed,
 * including draining ones (revocation closes them all). A device that
 * reconnects after that starts with a full bucket, as a single reconnecting
 * phone always did. Memory is bounded by the number of live connections.
 */

/** Token bucket for one device's requests: short bursts, steady 10 per second. */
export const requestBurst = 30;
export const requestsPerSecond = 10;

/**
 * Token bucket for one device's draft edits. A chat page sends one edit per
 * keystroke, and one keyboard types into one tab at a time:
 * - holding a key down repeats it about 30 times per second on common
 *   systems, below the 40 per second refill, so even that is never refused;
 * - four tabs each typing at a fast 10 keystrokes per second (about 120
 *   words per minute) add up to the same 40 per second;
 * - a burst of 120 absorbs three seconds of all four at once, or edits
 *   queued during a short network stall.
 * A flood (a script, a stuck key handler) is refused after 120 edits and then
 * held to 40 per second; each refused edit is answered as not saved.
 */
export const draftEditBurst = 120;
export const draftEditsPerSecond = 40;

/** One token bucket's size and refill rate. */
export interface RateLimit {
  /** Most tokens the bucket holds; also what a new device starts with. */
  burst: number;
  /** Tokens added per second of the refill clock. */
  perSecond: number;
}

export const requestRateLimit: RateLimit = { burst: requestBurst, perSecond: requestsPerSecond };
export const draftEditRateLimit: RateLimit = {
  burst: draftEditBurst,
  perSecond: draftEditsPerSecond,
};

interface Bucket {
  tokens: number;
  /** Refill clock reading (`now`) at the last refill, in milliseconds. */
  updatedAt: number;
}

export class DeviceRequestRate {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * `now` is the refill clock in milliseconds. By default it is monotonic
   * (`performance.now()`), so setting the wall clock back, or correcting it
   * forward again, never changes how fast a bucket refills. Tests inject
   * their own clock. `limit` defaults to the request bucket.
   */
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly limit: RateLimit = requestRateLimit,
  ) {}

  /** Take one token for `deviceId`; false when its bucket is empty. */
  take(deviceId: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(deviceId);
    if (!bucket) {
      bucket = { tokens: this.limit.burst, updatedAt: now };
      this.buckets.set(deviceId, bucket);
    }

    // Guard for an injected clock that goes back: it must not drain the
    // bucket (negative refill) and stall the device. No time passed.
    const elapsedMilliseconds = Math.max(0, now - bucket.updatedAt);
    const refill = (elapsedMilliseconds / 1000) * this.limit.perSecond;
    bucket.tokens = Math.min(this.limit.burst, bucket.tokens + refill);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** Drop a device's bucket once its last connection has closed. */
  forget(deviceId: string): void {
    this.buckets.delete(deviceId);
  }
}
