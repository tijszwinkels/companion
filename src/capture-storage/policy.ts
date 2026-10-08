import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

import type { CaptureStoragePreference } from './preference.ts';

/**
 * Permission for one observation (an utterance, a typed Activity request, an
 * empty-ASR attempt or a conversation's first screenshot) to have its
 * captured audio/screenshot archived by Companion.
 *
 * It is decided once, when the capture is admitted, and only ever weakens:
 * the policy rechecks it immediately before each file is published. A later
 * Off revokes it for good. Turning storage on again starts a new generation,
 * so an admission from before (or during) an Off period is never revived.
 */
export interface CaptureAdmission {
  /** The policy generation this admission belongs to. */
  readonly generation: number;
  /** True only if storage was on for the whole captured span. */
  readonly eligible: boolean;
}

/** Never eligible: used where no admission was made (fail closed). */
export const notAdmitted: CaptureAdmission = Object.freeze({ generation: -1, eligible: false });

/** What desktop clients display; contains no capture content. */
export interface CaptureStorageState {
  /** Effective state: whether newly started captures may be saved. */
  enabled: boolean;
  /** A change the user requested that has not been acknowledged yet. */
  pending: '' | 'enabling' | 'disabling';
  /**
   * False when the effective state may differ from the saved preference: a
   * failed Off save (a restart could reload an older "on"), or a missing
   * file that could not be read. Missing files are normal and count as saved.
   */
  saved: boolean;
  /** Short, content-free explanation when `saved` is false; otherwise empty. */
  warning: string;
}

/** Shown when the preference file exists but cannot be used. */
const unreadableWarning =
  'The capture storage setting could not be read, so captures are not saved. Turn it on or off to save it again.';

/** Shown when the user turned storage off but the choice was not saved. */
const unsavedOffWarning =
  'Capture storage is off for now, but this choice could not be saved. After a restart Companion may save captures again.';

/** Shown when a failed enable may still have left "on" in the saved file. */
const failedEnableWarning =
  'Capture storage stays off, but the saved setting may now say on. After a restart Companion may save captures. Turn it off again to save off.';

/**
 * The one capture-specific storage gate shared by every automatic writer of
 * Companion-owned audio and screenshots (Activity WAV/PNG, empty-ASR
 * diagnostics and conversation screenshots) and by labeling.
 *
 * Ordering rules, which the tests exercise:
 *
 * - Startup: `load()` runs before any capture or agent request is accepted.
 *   Until it resolves (and whenever the file is missing or invalid) storage
 *   is off; it is never transiently enabled.
 * - Enable: the "on" choice is saved durably first. Only then does a new
 *   generation open admission, and only for captures that start afterwards.
 *   A failed save leaves storage off.
 * - Disable: admission closes synchronously, which also revokes every earlier
 *   admission. The policy then waits for publications that already passed
 *   their final check (an atomic rename in progress) to settle, and saves
 *   "off". Only then is the Off acknowledged: after that point no stale
 *   callback can create or replace a capture file. A failed save keeps
 *   storage effectively off for this process and reports `saved: false`.
 * - Changes run one at a time in request order. An Off requested while an
 *   enable is still saving wins: the enable never opens admission.
 */
export class CaptureStoragePolicy extends EventEmitter {
  private effective = false;
  private generationNumber = 0;
  // Monotonic time at which the current "on" generation opened admission.
  private enabledAt = Number.POSITIVE_INFINITY;
  private savedState = true;
  private warningText = '';
  private enabling = false;
  private disablesPending = 0;
  // Incremented synchronously by every Off request, before it is queued.
  private offRequests = 0;
  private changes: Promise<unknown> = Promise.resolve();
  private readonly publications = new Set<Promise<void>>();

  /**
   * `preference` is absent for a fixed, in-memory policy (tests, and modes
   * that never persist). `now` is a monotonic millisecond clock.
   */
  constructor(
    private readonly preference?: CaptureStoragePreference,
    private readonly now: () => number = () => performance.now(),
  ) {
    super();
  }

  /** A policy that is on from the start, without a preference file (tests). */
  static enabledForTesting(now?: () => number): CaptureStoragePolicy {
    const policy = new CaptureStoragePolicy(undefined, now);
    policy.open(Number.NEGATIVE_INFINITY);
    return policy;
  }

  /** Read the saved choice once, before accepting any capture. */
  async load(): Promise<void> {
    if (!this.preference) {
      return;
    }

    const saved = await this.preference.load();

    if (saved.status === 'saved') {
      if (saved.enabled) {
        // Saved before this process started, so no capture can predate it.
        this.open(Number.NEGATIVE_INFINITY);
      }
      return;
    }

    if (saved.status === 'invalid') {
      this.savedState = false;
      this.warningText = unreadableWarning;
    }
  }

  get enabled(): boolean {
    return this.effective;
  }

  get generation(): number {
    return this.generationNumber;
  }

  get state(): CaptureStorageState {
    let pending: CaptureStorageState['pending'] = '';
    if (this.disablesPending > 0) {
      pending = 'disabling';
    } else if (this.enabling) {
      pending = 'enabling';
    }

    return {
      enabled: this.effective,
      pending,
      saved: this.savedState,
      warning: this.warningText,
    };
  }

  /**
   * The policy's monotonic clock, in milliseconds. Capture sources stamp
   * their acquisition with it, so admission compares like with like.
   */
  time(): number {
    return this.now();
  }

  /**
   * Admit a capture whose earliest sample was acquired no earlier than
   * `capturedFrom` (on `time()`; default: now). It is eligible only if storage
   * was on, in the current generation, from that moment: speech that started
   * before an opt-in is never archived. Callers pass a conservative lower
   * bound; an earlier value only makes a capture less likely to be saved.
   */
  admit(capturedFrom: number = this.now()): CaptureAdmission {
    const eligible = this.effective && capturedFrom >= this.enabledAt;

    return Object.freeze({ generation: this.generationNumber, eligible });
  }

  /** Whether an admission still permits saving, right now. */
  allows(admission: CaptureAdmission | undefined): boolean {
    return (
      admission !== undefined &&
      admission.eligible &&
      this.effective &&
      admission.generation === this.generationNumber
    );
  }

  /**
   * Run one capture publication under the Off barrier. Returns undefined,
   * without calling `write`, when the admission no longer permits saving.
   *
   * `write` receives `current`, which it must call immediately before its
   * atomic publication step (the rename). If `current()` is false the writer
   * discards only its own temporary data and returns undefined. While `write`
   * runs it counts as in flight, and an Off acknowledgement waits for it.
   * Errors from `write` propagate unchanged: an I/O failure is not "off".
   */
  async publish<T>(
    admission: CaptureAdmission | undefined,
    write: (current: () => boolean) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    if (!this.allows(admission)) {
      return undefined;
    }

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.publications.add(settled);

    try {
      return await write(() => this.allows(admission));
    } finally {
      this.publications.delete(settled);
      settle();
    }
  }

  /**
   * Apply an explicit user choice. Resolves once the choice is acknowledged:
   * for Off, after the publication barrier and a durable save. Rejects with
   * a content-free message when it could not be fully applied; `state`
   * then tells the truth (still off, or off but not saved).
   */
  setEnabled(enabled: boolean): Promise<void> {
    // Any Off requested after this point overtakes this request.
    const offRequestsBefore = this.offRequests;
    if (!enabled) {
      // Close admission now, ahead of any change that is still queued.
      this.offRequests++;
      this.disablesPending++;
      this.close();
      this.emit('change');
    }

    const change = this.changes.then(() =>
      enabled ? this.enable(offRequestsBefore) : this.disable(),
    );
    this.changes = change.catch(() => {});
    return change;
  }

  private async enable(offRequestsBefore: number): Promise<void> {
    // Already overtaken by an Off requested after this enable: do nothing.
    if (this.offRequests !== offRequestsBefore) {
      throw Error('Capture storage was turned off again before it could be turned on');
    }

    this.enabling = true;
    this.emit('change');

    try {
      try {
        await this.preference?.save(true);
      } catch {
        // The save can fail after the new file was renamed into place (for
        // example while syncing its directory). Never claim that the old
        // "off" is still what a restart would load unless the file says so.
        await this.checkAfterFailedEnable();
        throw Error('Capture storage could not be saved, so it stays off');
      }

      // A later Off arrived (before or while saving): it is queued behind
      // this change and will save "off" again. Never open admission.
      if (this.offRequests !== offRequestsBefore) {
        throw Error('Capture storage was turned off again before it could be turned on');
      }

      this.savedState = true;
      this.warningText = '';
      if (!this.effective) {
        this.open(this.now());
      }
    } finally {
      this.enabling = false;
      this.emit('change');
    }
  }

  private async disable(): Promise<void> {
    try {
      // Admission closed when the request arrived. Wait for publications that
      // had already passed their final check; nothing new can start.
      while (this.publications.size > 0) {
        await Promise.all([...this.publications]);
      }

      try {
        await this.preference?.save(false);
      } catch {
        this.savedState = false;
        this.warningText = unsavedOffWarning;
        throw Error('Capture storage is off, but the choice could not be saved');
      }

      this.savedState = true;
      this.warningText = '';
    } finally {
      this.disablesPending--;
      this.emit('change');
    }
  }

  /**
   * After a failed enable, compare the file with the effective "off" state.
   * A file that still says off (or is missing) matches it; anything else,
   * including a file that cannot be read now, may load "on" after a restart.
   */
  private async checkAfterFailedEnable(): Promise<void> {
    let saved: Awaited<ReturnType<CaptureStoragePreference['load']>> = { status: 'invalid' };
    try {
      saved = (await this.preference?.load()) ?? { status: 'invalid' };
    } catch {
      // Treated as unknown below.
    }

    const matchesOff = saved.status === 'missing' || (saved.status === 'saved' && !saved.enabled);
    if (matchesOff) {
      return;
    }
    this.savedState = false;
    this.warningText = failedEnableWarning;
  }

  /** Start a new "on" generation for captures that begin at or after `since`. */
  private open(since: number): void {
    this.effective = true;
    this.generationNumber++;
    this.enabledAt = since;
  }

  /** Revoke admission and every earlier admission, synchronously. */
  private close(): void {
    if (!this.effective) {
      return;
    }
    this.effective = false;
    this.generationNumber++;
    this.enabledAt = Number.POSITIVE_INFINITY;
  }
}
