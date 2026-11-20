/**
 * Request rate limit per paired device, shared by all of its connections.
 *
 * Inputs:  one `take(deviceId)` call per request or heartbeat a connection
 *          receives from its client.
 * Outputs: whether that message may proceed now.
 *
 * Each device has one token bucket: bursts of `requestBurst` messages, refilled
 * at `requestsPerSecond`. A device may hold several connections (browser tabs
 * and a phone, at most `maximumConnectionsPerDevice`), and they draw from the
 * same bucket, so opening more tabs never raises what one device may send.
 *
 * The gateway forgets a device's bucket when its last connection has closed,
 * including draining ones (revocation closes them all). A device that
 * reconnects after that starts with a full bucket, as a single reconnecting
 * phone always did. Memory is bounded by the number of live connections.
 */

/** Token bucket for one device's requests: short bursts, steady 10 per second. */
export const requestBurst = 30;
export const requestsPerSecond = 10;

interface Bucket {
  tokens: number;
  /** Clock reading of the last refill, in milliseconds. */
  updatedAt: number;
}

export class DeviceRequestRate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Take one token for `deviceId`; false when its bucket is empty. */
  take(deviceId: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(deviceId);
    if (!bucket) {
      bucket = { tokens: requestBurst, updatedAt: now };
      this.buckets.set(deviceId, bucket);
    }

    // A wall clock set back must not drain the bucket (negative refill) and
    // stall every connection of the device: no time passed, no refill.
    const elapsedMilliseconds = Math.max(0, now - bucket.updatedAt);
    const refill = (elapsedMilliseconds / 1000) * requestsPerSecond;
    bucket.tokens = Math.min(requestBurst, bucket.tokens + refill);
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
