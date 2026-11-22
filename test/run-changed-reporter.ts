// A Node test reporter for `npm run test:changed`. run-changed.ts starts one `node --test`
// process per test file and gives it this reporter next to `spec`; the reporter writes one
// line of JSON that says how the file ran, so that run-changed.ts can decide whether the pass
// may be saved.
//
// The summary Node gives at the end does not show a failing hook, a failing test process or a
// skipped suite, so those are taken from the single events.
import type { TestEvent } from 'node:test/reporters';

export interface FileOutcome {
  /** Node's own verdict for the run, and no failing test, hook or process. */
  succeeded: boolean;
  /** Tests that passed, not counting skipped and todo tests. */
  passed: number;
  /** A test or suite was skipped, todo or cancelled: the file did not run completely. */
  partial: boolean;
}

export default async function* outcomeReporter(
  events: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
  let nodeSucceeded = false;
  let failedEvent = false;
  let passed = 0;
  let partial = false;

  for await (const event of events) {
    if (event.type === 'test:fail') {
      // A failing todo test does not fail the run; the file only counts as partly run.
      if (event.data.todo !== undefined) {
        partial = true;
      } else {
        failedEvent = true;
      }
    } else if (event.type === 'test:pass') {
      if (event.data.skip !== undefined || event.data.todo !== undefined) {
        partial = true;
      }
    } else if (event.type === 'test:summary' && event.data.file === undefined) {
      // The summary of the whole run, not the one of the single file.
      const { counts } = event.data;
      nodeSucceeded = event.data.success;
      passed = counts.passed;
      if (counts.skipped > 0 || counts.todo > 0 || counts.cancelled > 0) {
        partial = true;
      }
    }
  }

  const outcome: FileOutcome = { succeeded: nodeSucceeded && !failedEvent, passed, partial };
  yield JSON.stringify(outcome) + '\n';
}
