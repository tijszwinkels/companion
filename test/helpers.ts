import type { Screenshot, UserSensorFrame, UserSensorProcessor } from '../src/core/frame.ts';

/** A tiny PNG and a stable window identity; no desktop access is needed. */
export const screenshot: Screenshot = {
  png: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
  capturedAt: 1000,
  window: { address: '0xabc', app: 'editor', title: 'Document' },
  width: 1,
  height: 1,
};

export const frame: UserSensorFrame = {
  id: 1,
  observedAt: 1000,
  utterance: 'Hello world',
  screenshot,
};

export const signal = () => new AbortController().signal;

/** Register a test action using the same subscription interface as real processors. */
export function processor(
  name: string,
  process: UserSensorProcessor['process'] = async () => {},
): UserSensorProcessor {
  return {
    name,
    instruction: `Choose ${name}`,
    process,
    subscribe(router) {
      router.register(this);
    },
  };
}

/** Lets a test pause one pipeline stage until it has checked concurrent behavior. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}
