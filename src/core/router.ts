import type { Intent, Log, UserSensorFrame, UserSensorProcessor } from './frame.ts';
import { stripPrefix } from './prefix.ts';
import type { Activity } from './activity.ts';
import type { InspectableModule, RegisteredProcessor } from './module.ts';

/** Allows the router to use either the Pi detector or a test implementation. */
export interface Detector extends InspectableModule {
  detect(frame: UserSensorFrame, intents: readonly Intent[], signal: AbortSignal): Promise<string>;
}

/** Owns subscriptions and dispatches each frame to exactly one processor. */
export class UserSensorRouter implements InspectableModule {
  readonly label = 'Intent router';

  private readonly registeredProcessors = new Map<string, UserSensorProcessor>();
  private readonly prefixes: { prefix: string; processor: UserSensorProcessor }[] = [];

  constructor(
    readonly dependencies: { readonly detector: Detector },
    private readonly log: Log,
    private readonly activity: Activity = {},
    readonly id = 'router',
  ) {}

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
    for (const prefix of prefixes) {
      this.prefixes.push({ prefix, processor });
    }

    // A specific command such as "insert code" wins over "insert", regardless
    // of subscription order. Sorting happens once, outside the routing path.
    this.prefixes.sort((left, right) => right.prefix.length - left.prefix.length);
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

      this.log('prefix', `${JSON.stringify(prefix)} → ${processor.name} (LLM bypassed)`, frame.id);
      this.activity.intentRecognized?.(frame.id, processor.name);
      if (!utterance.trim()) {
        this.log('skipped', 'Prefix has no following text', frame.id);
        this.activity.outcome?.(frame.id, 'skipped');
        return processor.name;
      }

      this.log('dispatch', processor.name, frame.id);
      await processor.process({ ...frame, utterance }, signal);
      return processor.name;
    }

    // Keep the prompt's choices and the dispatch targets consistent, even if a
    // new processor subscribes while this model call is in flight.
    const eligibleProcessors = new Map<string, UserSensorProcessor>();
    const intents: Intent[] = [];
    for (const processor of this.registeredProcessors.values()) {
      if (processor.instruction !== undefined) {
        eligibleProcessors.set(processor.name, processor);
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

    this.log('intent', `${name} (${Math.round(performance.now() - started)} ms)`, frame.id);
    this.activity.intentRecognized?.(frame.id, name);
    this.log('dispatch', name, frame.id);

    await processor.process(frame, signal);

    return name;
  }
}
