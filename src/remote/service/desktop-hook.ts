/**
 * The listener's `--phone` option: phone access that starts and stops with
 * this desktop listener, using `companion-phone` (see docs/mobile-startup.md).
 *
 * Only a listener started with `--phone` creates this hook. Without it the
 * listener never runs `companion-phone`, so ordinary startup and shutdown can
 * never start or stop a phone gateway.
 *
 * Behavior, exactly:
 * - start(): once the listener's control socket is up, run
 *   `companion-phone start` in the background. The desktop does not wait for
 *   it and is unaffected by its failure; the outcome goes to the listener log.
 * - stop(): during listener shutdown, before the control socket closes. A
 *   start still in progress is terminated first, then `companion-phone stop`
 *   runs. It stops only companion-phone's own transient unit (which may have
 *   been started earlier by hand; `--phone` means "phone access follows this
 *   listener"). If it fails or times out, the listener still exits and logs
 *   that phone access may still be on.
 * - A listener that crashes (or is killed with SIGKILL) runs no hook: the
 *   gateway keeps running, phones see "listener unavailable", and the next
 *   `--phone` listener finds the running service and keeps it.
 *
 * Every child process is bounded in time and killed if it overruns.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface PhoneAccessHookOptions {
  /** Absolute path of `bin/companion-phone`. */
  executable: string;
  /** One line per call, without trailing newline. */
  log(detail: string): void;
  /** Upper bound for `companion-phone start` (default 120 s: it waits up to 90 s). */
  startTimeoutMilliseconds?: number;
  /** Upper bound for `companion-phone stop` (default 30 s: the unit stops within 10 s). */
  stopTimeoutMilliseconds?: number;
}

/** How long a terminated start may take to exit before it is killed. */
const terminateGraceMilliseconds = 5000;

interface Finished {
  code: number | null;
  timedOut: boolean;
}

export class PhoneAccessHook {
  private starting?: { child: ChildProcess; finished: Promise<Finished> };

  constructor(private readonly options: PhoneAccessHookOptions) {}

  /** Start phone access in the background; never throws. */
  start(): void {
    const run = this.run(['start'], this.options.startTimeoutMilliseconds ?? 120_000);
    this.starting = run;

    void run.finished.then(({ code, timedOut }) => {
      if (this.starting === run) {
        this.starting = undefined;
      }
      if (code === 0) {
        return;
      }
      const reason = timedOut ? 'timed out' : `exit ${code ?? 'signal'}`;
      this.options.log(
        `Phone access did not start (${reason}); the desktop is unaffected. ` +
          'See `companion-phone status`.',
      );
    });
  }

  /**
   * Stop phone access before the listener goes away. Resolves true only when
   * `companion-phone stop` confirmed it is off; never throws.
   */
  async stop(): Promise<boolean> {
    const starting = this.starting;
    this.starting = undefined;
    if (starting) {
      this.options.log('Stopping the phone access start that is still in progress');
      starting.child.kill('SIGTERM');
      const exited = await Promise.race([
        starting.finished.then(() => true),
        delay(terminateGraceMilliseconds).then(() => false),
      ]);
      if (!exited) {
        starting.child.kill('SIGKILL');
        await starting.finished;
      }
    }

    const { code, timedOut } = await this.run(
      ['stop'],
      this.options.stopTimeoutMilliseconds ?? 30_000,
    ).finished;
    if (code === 0) {
      return true;
    }
    const reason = timedOut ? 'timed out' : `exit ${code ?? 'signal'}`;
    this.options.log(
      `Phone access may still be on (companion-phone stop: ${reason}); ` +
        'run `companion-phone stop` and check `companion-phone status`.',
    );
    return false;
  }

  /** Run companion-phone, forwarding its output lines to the log. */
  private run(
    args: string[],
    timeoutMilliseconds: number,
  ): { child: ChildProcess; finished: Promise<Finished> } {
    const child = spawn(this.options.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const forward = (stream: NodeJS.ReadableStream | null) => {
      let buffered = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        buffered += chunk;
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) {
            this.options.log(line);
          }
        }
      });
    };
    forward(child.stdout);
    forward(child.stderr);

    const finished = new Promise<Finished>((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMilliseconds);

      child.once('error', (error) => {
        clearTimeout(timer);
        this.options.log(`Could not run ${this.options.executable}: ${error.message}`);
        resolve({ code: 127, timedOut: false });
      });
      // 'exit', not 'close': a grandchild that keeps our output pipes open
      // must not keep the listener waiting.
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut });
      });
    });

    return { child, finished };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref());
}
