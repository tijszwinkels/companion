import { EventEmitter } from 'node:events';

import type { Intent, IntentContext, Log, UserSensorFrame, UserSensorProcessor } from './frame.ts';
import { stripPrefix } from './prefix.ts';
import type { Activity } from './activity.ts';
import type { InspectableModule, RegisteredProcessor } from './module.ts';
import { DeliveryInterruptedError, IntentDisabledError } from './delivery-error.ts';

/** Allows the router to use either the Pi detector or a test implementation. */
export interface Detector extends InspectableModule {
  detect(frame: UserSensorFrame, intents: readonly Intent[], signal: AbortSignal): Promise<string>;
}

/** Portable UI data derived from the same registrations used for dispatch. */
export interface IntentState {
  name: string;
  label: string;
  enabled: boolean;
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
  private readonly intentControllers = new Map<string, AbortController>();

  constructor(
    readonly dependencies: { readonly detector: Detector },
    private readonly log: Log,
    private readonly activity: Activity = {},
    readonly id = 'router',
  ) {
    super();
  }

  intentStates(context: IntentContext = {}): IntentState[] {
    return [...this.registeredProcessors].map(([name, processor]) => ({
      name,
      label: processor.label,
      enabled: !this.intentControllers.get(name)!.signal.aborted,
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

  setEnabled(name: string, enabled: boolean): void {
    const controller = this.intentControllers.get(name);
    if (!controller) {
      throw Error(`Unknown intent: ${name}`);
    }
    if (name === 'IGNORE' && !enabled) {
      throw Error('IGNORE is the required no-action fallback');
    }
    if (enabled === !controller.signal.aborted) {
      return;
    }
    if (enabled) {
      this.intentControllers.set(name, new AbortController());
    } else {
      controller.abort(new IntentDisabledError());
    }
    this.emit('change');
  }

  private skip(frame: UserSensorFrame, name: string, reason: string): string {
    this.log('skipped', reason, frame.id);
    this.activity.intentRecognized?.(frame.id, name);
    this.activity.outcome?.(frame.id, 'skipped');
    return name;
  }

  private async dispatch(
    processor: UserSensorProcessor,
    frame: UserSensorFrame,
    signal: AbortSignal,
    intentSignal: AbortSignal,
  ): Promise<void> {
    try {
      await processor.process(frame, AbortSignal.any([signal, intentSignal]));
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
    this.intentControllers.set(processor.name, new AbortController());
    for (const prefix of prefixes) {
      this.prefixes.push({ prefix, processor });
    }

    // A specific command such as "insert code" wins over "insert", regardless
    // of subscription order. Sorting happens once, outside the routing path.
    this.prefixes.sort((left, right) => right.prefix.length - left.prefix.length);
    this.emit('change');
  }

  async route(frame: UserSensorFrame, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();

    // Prefixes resolve locally before any inference. The existing pipeline still
    // awaits the action, preserving utterance order and avoiding racing keystrokes.
    for (const { prefix, processor } of this.prefixes) {
      const utterance = stripPrefix(frame.utterance, prefix);
      if (utterance === undefined) {
        continue;
      }

      const intentSignal = this.intentControllers.get(processor.name)!.signal;
      if (intentSignal.aborted || processor.availableForPrefix?.(frame) === false) {
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

      this.log('dispatch', processor.name, frame.id);
      await this.dispatch(processor, { ...frame, utterance }, signal, intentSignal);
      return processor.name;
    }

    // Keep the prompt's choices and the dispatch targets consistent, even if a
    // new processor subscribes while this model call is in flight.
    const eligibleProcessors = new Map<string, UserSensorProcessor>();
    const intentSignals = new Map<string, AbortSignal>();
    const intents: Intent[] = [];
    for (const processor of this.registeredProcessors.values()) {
      if (
        processor.instruction !== undefined &&
        !this.intentControllers.get(processor.name)!.signal.aborted &&
        (processor.availableForInference?.(frame) ?? true)
      ) {
        eligibleProcessors.set(processor.name, processor);
        intentSignals.set(processor.name, this.intentControllers.get(processor.name)!.signal);
        intents.push({ name: processor.name, instruction: processor.instruction });
      }
    }

    if (!eligibleProcessors.has('IGNORE')) {
      throw Error('Register an IGNORE processor with an instruction before LLM routing');
    }

    this.log('detect', 'Determining intent', frame.id);
    const started = performance.now();
    const name = await this.dependencies.detector.detect(frame, intents, signal);

    // Cancellation during inference must prevent the processor's side effect.
    signal.throwIfAborted();

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
    this.log('dispatch', name, frame.id);

    await this.dispatch(processor, frame, signal, intentSignal);

    return name;
  }
}
