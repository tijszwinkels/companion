import { EventEmitter } from 'node:events';

import {
  hasScreenshot,
  isScreenlessProcessor,
  type Intent,
  type IntentContext,
  type Log,
  type SensorFrame,
  type UserSensorFrame,
  type UserSensorProcessor,
} from './frame.ts';
import { stripPrefix } from './prefix.ts';
import type { Activity } from './activity.ts';
import type { InspectableModule, RegisteredProcessor } from './module.ts';
import { DeliveryInterruptedError, IntentDisabledError } from './delivery-error.ts';
import type { ScopedIntent, ScopedIntentSource } from './scoped-intent.ts';
import { voiceLabel } from './voice-shortcut.ts';
import {
  isTextRoute,
  type InvalidReason,
  type TextRoute,
} from './transcription-cleanup/contract.ts';
import type {
  CleanupFallbackReason,
  TranscriptionCleanupRecord,
} from './transcription-cleanup/record.ts';

/** One json-cleanup-v1 detection: the intent plus, for a text route, its text. */
export interface CleanupDetection {
  intent: string;
  /** Cleaned text for a valid text-route answer; null otherwise. */
  text: string | null;
  /** Set when a text route's cleaned text broke the contract; use the raw text. */
  fallback: InvalidReason | null;
}
import { UtteranceSupersededError, type DispatchCommitment } from './utterance-continuation.ts';

/** Allows the router to use either the Pi detector or a test implementation. */
export interface Detector extends InspectableModule {
  detect(frame: UserSensorFrame, intents: readonly Intent[], signal: AbortSignal): Promise<string>;

  /**
   * Required only while transcription cleanup is on: one call that returns
   * the intent together with cleaned text. Throws, like `detect`, when the
   * response has no usable intent.
   */
  detectWithCleanup?(
    frame: UserSensorFrame,
    intents: readonly Intent[],
    signal: AbortSignal,
  ): Promise<CleanupDetection>;

  /**
   * Classify a frame without a screenshot (a listener without a desktop,
   * `--headless`): the same choice as `detect`, from the utterance and the
   * interaction context alone. Absent: such frames cannot be classified, and
   * the router refuses them with a reason instead of inventing a screen.
   */
  // A function property, so strict parameter checks reject an implementation
  // that accepts only frames with a screenshot.
  detectWithoutScreenshot?: (
    frame: SensorFrame,
    intents: readonly Intent[],
    signal: AbortSignal,
  ) => Promise<string>;

  /**
   * True when a provisional speech attempt must not start this detector's
   * request (bare-name or inferred cleanup) until SPEECH_QUIET_MS have passed
   * since the latest speech: the Groq request profile. Absent or false, the
   * request starts as soon as the transcript is ready, as before.
   */
  readonly startsAfterSpeechQuiet?: boolean;
}

/** Result of cleaning an explicit shortcut's text. The route is never part of it. */
export type FixedRouteCleanup =
  { kind: 'cleaned'; text: string } | { kind: 'raw-text'; reason: CleanupFallbackReason };

/** The cleanup-only call for explicit shortcuts, or a test implementation. */
export interface TextCleaner extends InspectableModule {
  /**
   * Never throws for a failed model call (it returns `raw-text`); throws only
   * when `signal` was aborted, in which case nothing may be delivered.
   */
  clean(
    route: TextRoute,
    text: string,
    frame: UserSensorFrame,
    signal: AbortSignal,
  ): Promise<FixedRouteCleanup>;
}

/** Read once per routed utterance; see TranscriptionCleanupSetting. */
export interface CleanupSwitch {
  readonly enabled: boolean;
}

/** Cleanup stays off unless a switch is supplied. */
const CLEANUP_OFF: CleanupSwitch = { enabled: false };

export type IntentMode = 'inference' | 'shortcut';

/** Portable UI data derived from the same registrations used for dispatch. */
export interface IntentState {
  name: string;
  label: string;
  /** Compatibility summary for older clients; each route has its own switch. */
  enabled: boolean;
  supportsInference: boolean;
  inferenceEnabled: boolean;
  shortcutEnabled: boolean;
  toggleable: boolean;
  inferenceAvailable: boolean;
  prefixes: readonly string[];
  prefixAvailable: boolean;
  acceptsEmptyPrefix?: boolean;
}

/** Owns subscriptions and dispatches each frame to exactly one processor. */
export class UserSensorRouter extends EventEmitter implements InspectableModule {
  readonly label = 'Intent router';

  private readonly registeredProcessors = new Map<string, UserSensorProcessor>();
  private readonly prefixes: { prefix: string; processor: UserSensorProcessor }[] = [];
  // Disabling aborts pending delivery, and re-enabling starts a new generation.
  // An old model response cannot become actionable again after an off/on click.
  private readonly intentControllers = new Map<string, Record<IntentMode, AbortController>>();
  private readonly scopedSources: ScopedIntentSource[] = [];

  /**
   * `dependencies.cleaner` performs the explicit-shortcut cleanup call. The
   * cleanup switch is read once at the start of each `route` call; while it is
   * off, neither the cleaner nor `detectWithCleanup` is used and routing is
   * exactly the bare-name behavior.
   */
  constructor(
    readonly dependencies: { readonly detector: Detector; readonly cleaner?: TextCleaner },
    private readonly log: Log,
    private readonly activity: Activity = {},
    readonly id = 'router',
    private readonly cleanup: CleanupSwitch = CLEANUP_OFF,
  ) {
    super();

    if (cleanup !== CLEANUP_OFF && !dependencies.cleaner) {
      throw Error('Transcription cleanup requires a text cleaner');
    }
  }

  intentStates(context: IntentContext = {}): IntentState[] {
    return [...this.registeredProcessors].map(([name, processor]) => ({
      name,
      label: processor.label,
      enabled:
        (processor.instruction !== undefined &&
          !this.intentControllers.get(name)!.inference.signal.aborted) ||
        (this.prefixes.some((route) => route.processor === processor) &&
          !this.intentControllers.get(name)!.shortcut.signal.aborted),
      supportsInference: processor.instruction !== undefined,
      inferenceEnabled: !this.intentControllers.get(name)!.inference.signal.aborted,
      shortcutEnabled: !this.intentControllers.get(name)!.shortcut.signal.aborted,
      toggleable: name !== 'IGNORE',
      inferenceAvailable:
        processor.instruction !== undefined && (processor.availableForInference?.(context) ?? true),
      prefixes: this.prefixes
        .filter((route) => route.processor === processor)
        .map((route) => route.prefix),
      prefixAvailable:
        this.prefixes.some((route) => route.processor === processor) &&
        (processor.availableForPrefix?.(context) ?? true),
      ...(processor.acceptsEmptyPrefix ? { acceptsEmptyPrefix: true } : {}),
    }));
  }

  /** Permanent commands retain their namespace even when switched off. */
  reservedPrefixes(): readonly string[] {
    return this.prefixes.map(({ prefix }) => prefix);
  }

  registerScoped(source: ScopedIntentSource): void {
    this.scopedSources.push(source);
  }

  private scopedIntents(context: IntentContext): readonly ScopedIntent[] {
    return this.scopedSources.flatMap((source) => source(context, this.reservedPrefixes()));
  }

  /** Validate before persisting a UI request, so invalid clicks never reach disk. */
  validateEnabled(name: string, enabled: boolean, mode?: IntentMode): void {
    const processor = this.registeredProcessors.get(name);
    if (!processor) {
      throw Error(`Unknown intent: ${name}`);
    }
    if (mode === 'inference' && processor.instruction === undefined) {
      throw Error('This processor has no intent recognition');
    }
    if (mode === 'shortcut' && !this.prefixes.some((route) => route.processor === processor)) {
      throw Error('This processor has no voice shortcut');
    }
    if (name === 'IGNORE' && !enabled) {
      throw Error('IGNORE is the required no-action fallback');
    }
  }

  /** Omitted mode retains the old combined control for older desktop clients. */
  setEnabled(name: string, enabled: boolean, mode?: IntentMode): void {
    this.validateEnabled(name, enabled, mode);
    const controllers = this.intentControllers.get(name)!;
    const modes: IntentMode[] = mode ? [mode] : ['inference', 'shortcut'];
    let changed = false;

    for (const route of modes) {
      const controller = controllers[route];
      if (enabled === !controller.signal.aborted) {
        continue;
      }
      if (enabled) {
        controllers[route] = new AbortController();
      } else {
        controller.abort(new IntentDisabledError());
      }
      changed = true;
    }
    if (changed) {
      this.emit('change');
    }
  }

  private skip(frame: SensorFrame, name: string, reason: string): string {
    this.log('skipped', reason, frame.id);
    this.activity.intentRecognized?.(frame.id, name);
    this.activity.outcome?.(frame.id, 'skipped');
    return name;
  }

  private async dispatch(
    processor: UserSensorProcessor,
    frame: SensorFrame,
    signal: AbortSignal,
    intentSignal: AbortSignal,
    route: IntentMode,
  ): Promise<void> {
    const processorSignal = AbortSignal.any([signal, intentSignal]);
    try {
      // A frame without a screenshot (no desktop) reaches only a processor
      // that never reads one. Prefix routing and the model's choices already
      // leave the others out (see `handles`); this keeps the type honest.
      if (hasScreenshot(frame)) {
        await processor.process(frame, processorSignal, route);
      } else if (isScreenlessProcessor(processor)) {
        await processor.process(frame, processorSignal, route);
      } else {
        throw Error(`${processor.name} needs a screenshot of the computer's screen`);
      }
    } catch (error) {
      // Preserve partial-delivery uncertainty. Cancellation before typing is a
      // normal user control, even though the overall listener remains active.
      if (intentSignal.aborted && !(error instanceof DeliveryInterruptedError)) {
        throw new IntentDisabledError();
      }
      throw error;
    }
  }

  /**
   * Whether `processor` can handle `frame`: always with a screenshot (every
   * frame with a desktop); without one only a screenless processor can.
   */
  private handles(processor: UserSensorProcessor, frame: SensorFrame): boolean {
    return hasScreenshot(frame) || isScreenlessProcessor(processor);
  }

  /**
   * Return an inspection snapshot without exposing mutable registration tables.
   * Read prefixes from the validated routes used for dispatch, and eligibility
   * from the same instruction field used when building the next LLM request.
   */
  get processors(): ReadonlyMap<string, RegisteredProcessor> {
    const registrations = new Map<string, RegisteredProcessor>();

    for (const [name, processor] of this.registeredProcessors) {
      const prefixes = this.prefixes
        .filter((route) => route.processor === processor)
        .map((route) => route.prefix);

      registrations.set(name, {
        processor,
        prefixes,
        llmEligible: processor.instruction !== undefined,
      });
    }

    return registrations;
  }

  register(processor: UserSensorProcessor): void {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(processor.name)) {
      throw Error('Processor requires an intent identifier (letters, digits, and underscores)');
    }

    if (this.registeredProcessors.has(processor.name)) {
      throw Error(`Duplicate intent: ${processor.name}`);
    }

    if (processor.instruction !== undefined && !processor.instruction.trim()) {
      throw Error('Processor instruction must not be blank');
    }
    if (processor.instructionForInference && processor.instruction === undefined) {
      throw Error('A contextual instruction requires a default instruction');
    }

    const prefixes = (processor.prefixes ?? []).map((prefix) => prefix.trim().toLowerCase());
    if (processor.instruction === undefined && prefixes.length === 0) {
      throw Error('Processor requires an instruction or a prefix');
    }

    // Validate the whole subscription before adding anything to the registry.
    // This prevents a failed registration from leaving some prefixes active.
    const occupied = new Set(this.prefixes.map((route) => route.prefix));
    for (const prefix of prefixes) {
      if (!prefix) {
        throw Error('Processor prefix must not be blank');
      }
      if (occupied.has(prefix)) {
        throw Error(`Duplicate prefix: ${prefix}`);
      }
      occupied.add(prefix);
    }

    this.registeredProcessors.set(processor.name, processor);
    this.intentControllers.set(processor.name, {
      inference: new AbortController(),
      shortcut: new AbortController(),
    });
    for (const prefix of prefixes) {
      this.prefixes.push({ prefix, processor });
    }

    // A specific command such as "insert code" wins over "insert", regardless
    // of subscription order. Sorting happens once, outside the routing path.
    this.prefixes.sort((left, right) => right.prefix.length - left.prefix.length);
    this.emit('change');
  }

  /**
   * Choose and run exactly one action for a frame. A provisional speech attempt
   * passes its commitment; each path awaits it immediately before its first
   * decision (dispatch or skip), so resumed speech can still replace the
   * attempt until then. Typed input and direct callers pass none.
   */
  async route(
    frame: SensorFrame,
    signal: AbortSignal,
    commitment?: DispatchCommitment,
  ): Promise<string> {
    signal.throwIfAborted();

    // Decide cleanup once for this utterance. A click on the switch while it
    // is processed applies to the next utterance, never halfway through.
    const cleanupEnabled = this.cleanup.enabled;

    // Report exactly one cleanup record per routed utterance. With cleanup on,
    // text routes report theirs just before dispatch, so the stored record is
    // committed before any delivery side effect starts (typing can take long,
    // or the process can die mid-delivery). Every other path, and every path
    // while cleanup is off, reports in `finally` below.
    let cleanupReported = false;
    const reportCleanup = (record: TranscriptionCleanupRecord): void => {
      if (cleanupReported) {
        return;
      }
      cleanupReported = true;
      this.activity.transcriptionCleanup?.(frame.id, record);
    };

    try {
      return await this.routeFrame(frame, signal, commitment, cleanupEnabled, reportCleanup);
    } catch (error) {
      // Resumed speech replaced this provisional attempt before any decision.
      // Its history row keeps the neutral "superseded" outcome, so it gets no
      // cleanup record at all (the columns stay NULL, meaning unknown). An
      // aborted detector request surfaces its own error, so the route signal's
      // abort reason is checked too.
      const superseded =
        error instanceof UtteranceSupersededError ||
        signal.reason instanceof UtteranceSupersededError;
      if (superseded) {
        cleanupReported = true;
      }

      throw error;
    } finally {
      reportCleanup(cleanupEnabled ? { enabled: true, status: 'no-text' } : { enabled: false });
    }
  }

  /**
   * Clean an explicit shortcut's text with the separate cleanup-only call.
   * Returns the text to deliver: cleaned, or the raw text when cleanup failed.
   * The processor was already chosen by the prefix; nothing here can change it.
   */
  private async cleanShortcutText(
    route: TextRoute,
    text: string,
    frame: SensorFrame,
    signal: AbortSignal,
    intentSignal: AbortSignal,
    reportCleanup: (record: TranscriptionCleanupRecord) => void,
  ): Promise<string> {
    this.log('cleanup', `Cleaning ${route} shortcut text`, frame.id);

    // Cleanup is never switched on without a desktop (src/cli.ts).
    if (!hasScreenshot(frame)) {
      throw Error('Transcription cleanup needs a screenshot');
    }

    let result: FixedRouteCleanup;
    try {
      result = await this.dependencies.cleaner!.clean(
        route,
        text,
        frame,
        AbortSignal.any([signal, intentSignal]),
      );
    } catch (error) {
      // Disabling the route during cleanup is the same user control as
      // disabling it before delivery; shutdown/pause errors pass through.
      if (intentSignal.aborted && !signal.aborted) {
        throw new IntentDisabledError();
      }
      throw error;
    }

    if (result.kind === 'raw-text') {
      this.log('cleanup', `Using raw text (${result.reason})`, frame.id);
      reportCleanup({ enabled: true, status: 'fallback', reason: result.reason });
      return text;
    }

    this.log(
      'cleanup',
      `Cleaned text (${text.length} → ${result.text.length} characters)`,
      frame.id,
    );
    reportCleanup({ enabled: true, status: 'cleaned', text: result.text });
    return result.text;
  }

  private async routeFrame(
    frame: SensorFrame,
    signal: AbortSignal,
    commitment: DispatchCommitment | undefined,
    cleanupEnabled: boolean,
    reportCleanup: (record: TranscriptionCleanupRecord) => void,
  ): Promise<string> {
    // Prefixes resolve locally before any inference. The existing pipeline still
    // awaits the action, preserving utterance order and avoiding racing keystrokes.
    for (const { prefix, processor } of this.prefixes) {
      const utterance = stripPrefix(frame.utterance, prefix);
      if (utterance === undefined) {
        continue;
      }

      // Shortcuts have no inference time in which a pause can be bridged. Like
      // inference, they commit only after the speech quiet floor (800 ms since
      // the latest speech), so "go to session ‹pause› three" still merges.
      await commitment?.commit('shortcut', signal);

      const intentSignal = this.intentControllers.get(processor.name)!.shortcut.signal;
      if (
        intentSignal.aborted ||
        processor.availableForPrefix?.(frame) === false ||
        !this.handles(processor, frame)
      ) {
        // Consume a disabled explicit command instead of reinterpreting it as
        // dictation, or as a shorter prefix owned by another processor.
        return this.skip(frame, processor.name, 'Intent is disabled or unavailable here');
      }

      this.log('prefix', `${JSON.stringify(prefix)} → ${processor.name} (LLM bypassed)`, frame.id);
      this.activity.intentRecognized?.(frame.id, processor.name);
      if (!utterance.trim() && !processor.acceptsEmptyPrefix) {
        this.log('skipped', 'Prefix has no following text', frame.id);
        this.activity.outcome?.(frame.id, 'skipped');
        return processor.name;
      }

      // With cleanup on, text routes get their text cleaned by a separate
      // call first. Other prefix commands (labels, navigation…) take no text.
      let text = utterance;
      if (cleanupEnabled && isTextRoute(processor.name)) {
        text = await this.cleanShortcutText(
          processor.name,
          utterance,
          frame,
          signal,
          intentSignal,
          reportCleanup,
        );
        signal.throwIfAborted();
      }

      this.log('dispatch', processor.name, frame.id);
      await this.dispatch(
        processor,
        { ...frame, utterance: text },
        signal,
        intentSignal,
        'shortcut',
      );
      return processor.name;
    }

    // Exact contextual labels run after permanent prefixes and before inference.
    // Capture routes once: a replacement during detection cannot redirect them.
    const scoped = this.scopedIntents(frame);
    const exact = scoped.find(
      (intent) =>
        intent.exactUtterance !== undefined &&
        voiceLabel(intent.exactUtterance) === voiceLabel(frame.utterance),
    );
    if (exact) {
      await commitment?.commit('shortcut', signal);
      this.log(
        'shortcut',
        `${JSON.stringify(exact.exactUtterance)} → ${exact.name} (LLM bypassed)`,
        frame.id,
      );
      this.activity.intentRecognized?.(frame.id, exact.name);
      await exact.process(frame, signal);
      return exact.name;
    }

    // Groq profile only: a provisional speech attempt sends its classifier
    // request once the user has been quiet for 800 ms since the latest speech
    // (the inference commitment floor), not at the 224 ms provisional
    // endpoint. The transcript is already ready here, so the request starts at
    // max(speech end + 800 ms, transcript ready); a slow ASR adds no extra wait.
    // Resumed speech during the wait holds it, and a continuation rejects it
    // with UtteranceSupersededError, so a replaced attempt never sends anything.
    // Typed input and direct callers pass no commitment and never wait.
    // Waiting before the eligible intents are collected below lets the request
    // reflect intent switches as they are when it is actually sent.
    //
    // Resuming after the await takes a microtask, in which a VAD onset (or a
    // rejected burst that moves the deadline) can still arrive. The loop
    // therefore re-checks synchronously, and from that check to the detector
    // call below nothing is awaited: the request starts only while the attempt
    // is still quiet. Keep it that way when editing the code in between.
    if (commitment && this.dependencies.detector.startsAfterSpeechQuiet) {
      const quietWaitStarted = performance.now();
      do {
        await commitment.speechQuiet(signal);
      } while (!commitment.isSpeechQuiet());
      signal.throwIfAborted();

      const waitedMs = Math.round(performance.now() - quietWaitStarted);
      this.log('quiet', `Classifier request waited ${waitedMs} ms for speech quiet`, frame.id);
    }

    // Keep the prompt's choices and the dispatch targets consistent, even if a
    // new processor subscribes while this model call is in flight.
    const eligibleProcessors = new Map<string, UserSensorProcessor>();
    const intentSignals = new Map<string, AbortSignal>();
    const intents: Intent[] = [];
    for (const processor of this.registeredProcessors.values()) {
      if (
        processor.instruction !== undefined &&
        !this.intentControllers.get(processor.name)!.inference.signal.aborted &&
        (processor.availableForInference?.(frame) ?? true) &&
        this.handles(processor, frame)
      ) {
        // Resolve once from the captured frame. Keep the result local instead
        // of mutating registration state shared by UI reads and later frames.
        let instruction = processor.instruction;
        if (processor.instructionForInference) {
          instruction = processor.instructionForInference(frame);
        }
        if (!instruction.trim()) {
          throw Error('Processor instruction must not be blank');
        }

        eligibleProcessors.set(processor.name, processor);
        intentSignals.set(
          processor.name,
          this.intentControllers.get(processor.name)!.inference.signal,
        );
        intents.push({ name: processor.name, instruction });
      }
    }

    const scopedByName = new Map(
      scoped
        .filter((intent) => intent.instruction !== undefined)
        .map((intent) => [intent.name, intent]),
    );
    for (const intent of scopedByName.values()) {
      if (this.registeredProcessors.has(intent.name)) {
        throw Error(`Scoped intent collides with permanent intent: ${intent.name}`);
      }
      intents.push({ name: intent.name, instruction: intent.instruction! });
    }

    if (!eligibleProcessors.has('IGNORE')) {
      throw Error('Register an IGNORE processor with an instruction before LLM routing');
    }

    this.log('detect', 'Determining intent', frame.id);
    const started = performance.now();

    // Off: today's bare-name request, unchanged. On: one json-cleanup-v1
    // request that returns the intent and the cleaned text together.
    let name: string;
    let detection: CleanupDetection | undefined;
    // Without a screenshot (no desktop) the detector classifies from the
    // utterance and its interaction context alone; cleanup is never on then.
    const detector = this.dependencies.detector;
    if (!hasScreenshot(frame)) {
      if (!detector.detectWithoutScreenshot) {
        throw Error('This intent detector needs a screenshot');
      }
      name = await detector.detectWithoutScreenshot(frame, intents, signal);
    } else if (cleanupEnabled) {
      if (!detector.detectWithCleanup) {
        throw Error('This intent detector cannot clean up transcriptions');
      }
      detection = await detector.detectWithCleanup(frame, intents, signal);
      name = detection.intent;
    } else {
      name = await detector.detect(frame, intents, signal);
    }

    // Cancellation during inference must prevent the processor's side effect.
    signal.throwIfAborted();

    // Commit once 800 ms have passed since the latest speech; a slower answer
    // commits at once. If the user resumed speaking, wait until that speech is
    // either merged into a new attempt (this one is then superseded) or
    // rejected as noise. The same point covers cleanup on and off.
    await commitment?.commit('inference', signal);

    const contextual = scopedByName.get(name);
    if (contextual) {
      this.log('intent', `${name} (${Math.round(performance.now() - started)} ms)`, frame.id);
      this.activity.intentRecognized?.(frame.id, name);
      await contextual.process(frame, signal);
      return name;
    }

    // Prefix-only commands are not valid model responses, even if a detector
    // implementation returns one. In particular, inference cannot press Enter.
    const processor = eligibleProcessors.get(name);
    if (!processor) {
      throw Error(`Unregistered intent: ${JSON.stringify(name)}`);
    }

    const intentSignal = intentSignals.get(name)!;
    if (intentSignal.aborted) {
      return this.skip(frame, name, 'Intent was disabled during detection');
    }

    this.log('intent', `${name} (${Math.round(performance.now() - started)} ms)`, frame.id);
    this.activity.intentRecognized?.(frame.id, name);

    // A text route delivers the cleaned text, or the raw text when the model's
    // text broke the contract. Nothing partially cleaned is ever delivered.
    let routedFrame = frame;
    if (detection && isTextRoute(name)) {
      if (detection.text !== null) {
        this.log(
          'cleanup',
          `Cleaned text (${frame.utterance.length} → ${detection.text.length} characters)`,
          frame.id,
        );
        reportCleanup({ enabled: true, status: 'cleaned', text: detection.text });
        routedFrame = { ...frame, utterance: detection.text };
      } else {
        // A detector must name why it has no text; never invent a reason.
        if (detection.fallback === null) {
          throw Error('Cleanup detection returned a text route without text or a reason');
        }
        this.log('cleanup', `Using raw text (${detection.fallback})`, frame.id);
        reportCleanup({ enabled: true, status: 'fallback', reason: detection.fallback });
      }
    }

    this.log('dispatch', name, frame.id);

    await this.dispatch(processor, routedFrame, signal, intentSignal, 'inference');

    return name;
  }
}
