import type { UtteranceOutcome } from './activity.ts';
import { UtteranceSupersededError } from './utterance-continuation.ts';

/** A keyboard process may have inserted a prefix before it failed or stopped. */
export class DeliveryInterruptedError extends Error {
  constructor(cause: unknown) {
    super('Text delivery was interrupted; some text may have been inserted', { cause });
  }
}

/** Explicitly disabling a route cancels its pending work without stopping capture. */
export class IntentDisabledError extends Error {
  constructor() {
    super('Intent disabled; pending routing aborted');
  }
}

/** Preserve delivery uncertainty even when a pause or shutdown also aborted. */
export function failureOutcome(error: unknown, signal: AbortSignal): UtteranceOutcome {
  if (error instanceof DeliveryInterruptedError) {
    return 'interrupted';
  }

  // Resumed speech replaced a provisional attempt before it committed to an
  // action. A pause or shutdown that aborted first keeps its own reason.
  if (signal.aborted && signal.reason instanceof UtteranceSupersededError) {
    return 'superseded';
  }

  return signal.aborted || error instanceof IntentDisabledError ? 'cancelled' : 'error';
}
