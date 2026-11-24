/**
 * Whether this browser's "Listen here" choice outlives the page.
 *
 * Rule (decided for now; the user has been asked): it is **not** remembered.
 * Every page starts with Listen here off, so a page never starts listening
 * by itself after a reload, a crash or a restored tab; the reader switches
 * it on. Nothing is written to the browser's storage.
 *
 * This file is the one place that rule lives: to remember the choice later,
 * read it in `initialChoice` and write it in `choiceChanged` (for example
 * one localStorage entry, like the Display switches), and nothing else in
 * listen-here.ts changes.
 */

/** Listen here's state when the page starts. */
export function initialChoice(): boolean {
  return false;
}

/** The reader (or the page itself, after a problem) changed the switch. */
export function choiceChanged(_on: boolean): void {
  // Not remembered: see the rule above.
}
