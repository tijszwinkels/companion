import type { InspectableModule } from './module.ts';

/**
 * One keyboard output queue shared by automatic sends and manual recovery.
 * Recovery can supersede automatic work until its final, synchronous claim
 * immediately before typing. Once typing starts, recovery of that frame fails.
 * Different utterances wait their turn and recheck focus inside the queue.
 */
export class DeliveryControl implements InspectableModule {
  readonly label = 'Keyboard delivery queue';
  readonly dependencies = {};

  private tail = Promise.resolve();
  private readonly recovered = new Set<number>();
  private readonly typing = new Set<number>();

  constructor(readonly id = 'keyboard-delivery') {}

  async automatic(
    frameId: number,
    signal: AbortSignal,
    deliver: (claim: () => boolean) => Promise<boolean>,
  ): Promise<boolean> {
    try {
      return await this.serialize(signal, () =>
        deliver(() => {
          if (this.recovered.has(frameId)) {
            return false;
          }

          this.typing.add(frameId);
          return true;
        }),
      );
    } finally {
      this.typing.delete(frameId);
    }
  }

  async recover<T>(
    frameId: number | undefined,
    signal: AbortSignal,
    deliver: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();

    if (frameId !== undefined) {
      if (this.typing.has(frameId)) {
        throw Error('This utterance is already being delivered');
      }

      // Reserve before awaiting the queue, including while automatic delivery
      // is checking focus. Its claim will then fail without starting wtype.
      this.recovered.add(frameId);
    }

    return this.serialize(signal, deliver);
  }

  finish(frameId: number): void {
    this.recovered.delete(frameId);
  }

  private async serialize<T>(signal: AbortSignal, deliver: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await previous;
      signal.throwIfAborted();
      return await deliver();
    } finally {
      // The delivery promise settles only after the keyboard process is reaped,
      // including on cancellation. The next writer cannot overlap that process.
      release();
    }
  }
}
