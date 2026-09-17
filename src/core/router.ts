import type { Intent, Log, UserSensorFrame, UserSensorProcessor } from './frame.ts';
import { stripPrefix } from './prefix.ts';

/** Allows the router to use either the Pi detector or a test implementation. */
export interface Detector {
  detect(frame: UserSensorFrame, intents: readonly Intent[], signal: AbortSignal): Promise<string>;
}

/** Owns subscriptions and dispatches each frame to exactly one processor. */
export class UserSensorRouter {
  private readonly processors = new Map<string, UserSensorProcessor>();
  private readonly prefixes: { prefix: string; processor: UserSensorProcessor }[] = [];

  constructor(
    private readonly detector: Detector,
    private readonly log: Log,
  ) {}

  register(processor: UserSensorProcessor): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(processor.name)) {
      throw Error('Processor requires an uppercase intent name');
    }

    if (this.processors.has(processor.name)) {
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

    this.processors.set(processor.name, processor);
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
      if (!utterance.trim()) {
        this.log('skipped', 'Prefix has no following text', frame.id);
        return processor.name;
      }

      this.log('dispatch', processor.name, frame.id);
      await processor.process({ ...frame, utterance }, signal);
      return processor.name;
    }

    // Keep the prompt's choices and the dispatch targets consistent, even if a
    // new processor subscribes while this model call is in flight.
    const processors = new Map<string, UserSensorProcessor>();
    const intents: Intent[] = [];
    for (const processor of this.processors.values()) {
      if (processor.instruction !== undefined) {
        processors.set(processor.name, processor);
        intents.push({ name: processor.name, instruction: processor.instruction });
      }
    }

    if (!processors.has('IGNORE')) {
      throw Error('Register an IGNORE processor with an instruction before LLM routing');
    }

    this.log('detect', 'Determining intent', frame.id);
    const started = performance.now();
    const name = await this.detector.detect(frame, intents, signal);

    // Cancellation during inference must prevent the processor's side effect.
    signal.throwIfAborted();

    // Prefix-only commands are not valid model responses, even if a detector
    // implementation returns one. In particular, inference cannot press Enter.
    const processor = processors.get(name);
    if (!processor) {
      throw Error(`Unregistered intent: ${JSON.stringify(name)}`);
    }

    this.log('intent', `${name} (${Math.round(performance.now() - started)} ms)`, frame.id);
    this.log('dispatch', name, frame.id);

    await processor.process(frame, signal);

    return name;
  }
}
