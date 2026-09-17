import type { Screenshot, UserSensorFrame, UserSensorProcessor } from '../src/frame.ts';

export const screenshot: Screenshot = {
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  capturedAt: 1000, window: { address: '0xabc', app: 'editor', title: 'Document' }, width: 1, height: 1,
};
export const frame: UserSensorFrame = { id: 1, observedAt: 1000, utterance: 'Hello world', screenshot };
export const signal = () => new AbortController().signal;
export function processor(name: string, process: UserSensorProcessor['process'] = async () => {}): UserSensorProcessor {
  return { name, instruction: `Choose ${name}`, process, subscribe(router) { router.register(this); } };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
