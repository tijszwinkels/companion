import type { Intent, Log, UserSensorFrame, UserSensorProcessor } from './frame.ts';
import type { Activity } from './activity.ts';

/** Allows the router to use either the Pi detector or a test implementation. */
export interface Detector {
  detect(frame: UserSensorFrame, intents: readonly Intent[], signal: AbortSignal): Promise<string>;
}

/** Owns subscriptions and dispatches each frame to exactly one processor. */
export class UserSensorRouter {
  private readonly processors = new Map<string, UserSensorProcessor>();

  constructor(
    private readonly detector: Detector,
    private readonly log: Log,
    private readonly activity: Activity = {},
  ) {}

  register(processor: UserSensorProcessor): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(processor.name) || !processor.instruction.trim()) {
      throw Error('Processor requires an uppercase intent name and an instruction');
    }

    if (this.processors.has(processor.name)) {
      throw Error(`Duplicate intent: ${processor.name}`);
    }

    this.processors.set(processor.name, processor);
  }

  async route(frame: UserSensorFrame, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();

    if (!this.processors.has('IGNORE')) {
      throw Error('Register an IGNORE processor before routing');
    }

    // Keep the prompt's choices and the dispatch targets consistent, even if a
    // new processor subscribes while this model call is in flight.
    const processors = new Map(this.processors);

    this.log('detect', 'Determining intent', frame.id);
    const started = performance.now();
    const name = await this.detector.detect(frame, [...processors.values()], signal);

    // Cancellation during inference must prevent the processor's side effect.
    signal.throwIfAborted();

    const processor = processors.get(name);
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
