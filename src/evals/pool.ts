/**
 * Bounded worker pool for evaluation requests.
 *
 * Input: a number of items, a concurrency limit and an async task per item index.
 * Output: task results in item order, independent of completion order.
 *
 * At most `concurrency` tasks run at once. Workers claim the next unclaimed index
 * only after their previous task has settled, so in-flight work never exceeds the
 * limit and nothing is queued ahead of time.
 *
 * Cancellation and failure: when the caller's signal aborts, or any task throws,
 * the pool stops claiming new items and aborts the signal handed to every active
 * task. It then waits for all active tasks to settle (drain) before rejecting.
 * Callers can therefore rely on no request still running after rejection. Tasks
 * that want to record an ordinary per-item error must catch it themselves; a
 * thrown error is treated as fatal for the whole pool.
 */
export async function runBounded<Result>(
  itemCount: number,
  concurrency: number,
  signal: AbortSignal,
  task: (index: number, signal: AbortSignal) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw Error('Item count must be a nonnegative integer');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw Error('Concurrency must be a positive integer');
  }
  signal.throwIfAborted();

  // The pool owns this controller. It lets one fatal task stop its siblings
  // without aborting the caller's signal, which may be shared with other work.
  const poolController = new AbortController();
  const taskSignal = AbortSignal.any([signal, poolController.signal]);

  const results: Result[] = new Array<Result>(itemCount);
  let nextIndex = 0;
  // Every fatal task error, in the order they occurred. The first is reported.
  const fatalErrors: unknown[] = [];

  const worker = async (): Promise<void> => {
    while (true) {
      // Check before claiming, so no item is scheduled after cancellation.
      if (taskSignal.aborted) {
        return;
      }

      const index = nextIndex;
      if (index >= itemCount) {
        return;
      }
      nextIndex++;

      try {
        results[index] = await task(index, taskSignal);
      } catch (error) {
        fatalErrors.push(error);
        poolController.abort(error);
        return;
      }
    }
  };

  const workerCount = Math.min(concurrency, itemCount);
  const workers: Promise<void>[] = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
    workers.push(worker());
  }

  // Workers never reject, so this waits for every active task to settle.
  await Promise.all(workers);

  // Caller cancellation takes precedence: a task's error is then usually just
  // the abort propagating, not an independent failure.
  signal.throwIfAborted();
  if (fatalErrors.length > 0) {
    throw fatalErrors[0];
  }
  return results;
}
