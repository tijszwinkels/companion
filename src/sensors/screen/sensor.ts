import type { Screenshot } from '../../core/frame.ts';
import type { InspectableModule } from '../../core/module.ts';
import { captureActiveWindow, type RunCommand } from './capture.ts';
import { command } from '../../system/command.ts';

/** The named screen dependency used by the pipeline, including test sensors. */
export interface ScreenSensor extends InspectableModule {
  capture(
    signal: AbortSignal,
    observed?: (window: Screenshot['window']) => void,
  ): Promise<Screenshot>;
}

/**
 * Give the existing capture function an inspectable identity. Constructing the
 * sensor is inert; capture retains its original focus checks and cancellation.
 */
export class ActiveWindowSensor implements ScreenSensor {
  readonly label = 'Active window';
  readonly dependencies = {};

  constructor(
    private readonly run: RunCommand = command,
    readonly id = 'screen',
  ) {}

  capture(
    signal: AbortSignal,
    observed?: (window: Screenshot['window']) => void,
  ): Promise<Screenshot> {
    return captureActiveWindow(signal, this.run, observed);
  }
}
