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
 *   start still in progress is cancelled first (see below), then
 *   `companion-phone stop` runs. It stops only companion-phone's own
 *   transient unit (which may have been started earlier by hand; `--phone`
 *   means "phone access follows this listener"). If it fails or times out,
 *   the listener still exits and logs that phone access may still be on.
 *
 * Cancelling a start safely (review finding H2): killing only the direct
 * child could leave its `systemd-run` running, or a request systemd already
 * accepted, so a gateway could appear after stop reported "off". Therefore:
 * - every companion-phone runs in its own process group, so a Ctrl+C in the
 *   listener's terminal never interrupts it half-way;
 * - cancellation is SIGTERM to companion-phone itself, which stops between
 *   steps, lets an in-flight `systemd-run` finish (bounded at 20 s) and stops
 *   a unit it created, then exits;
 * - only if it does not exit within the grace period is its whole process
 *   group killed; stop then runs twice, the second time after a settle
 *   period, to catch a start request systemd accepted from the killed client.
 * The same cancellation ends a start that overruns its own time limit, and
 * is followed by the same stop, so it cannot come up later either.
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
  /** Environment for companion-phone (default: this process's). */
  environment?: NodeJS.ProcessEnv;
  /** Upper bound for `companion-phone start` (default 120 s: it waits up to 90 s). */
  startTimeoutMilliseconds?: number;
  /** Upper bound for `companion-phone stop` (default 30 s: the unit stops within 10 s). */
  stopTimeoutMilliseconds?: number;
  /** How long a cancelled start may take to finish its step (default 30 s; systemd-run is bounded at 20 s). */
  cancelGraceMilliseconds?: number;
  /** After a forced kill, wait this long before the confirming second stop (default 3 s). */
  settleMilliseconds?: number;
}

interface Finished {
  code: number | null;
  timedOut: boolean;
}

interface Run {
  child: ChildProcess;
  finished: Promise<Finished>;
  /** True once the run has exited (its process group may still hold descendants). */
  exited: boolean;
}

export class PhoneAccessHook {
  /** The background start, kept until it has exited (also while being cancelled). */
  private starting?: Run;

  /**
   * The one cancel-then-stop operation in progress, if any. A start that
   * overruns its time limit and a listener shutdown share it, so shutdown
   * never runs a second stop beside it, nor returns before it finished.
   */
  private stopping?: Promise<boolean>;

  constructor(private readonly options: PhoneAccessHookOptions) {}

  /** Start phone access in the background; never throws. */
  start(): void {
    const run = this.run(['start']);
    this.starting = run;

    const limit = this.options.startTimeoutMilliseconds ?? 120_000;
    const timer = setTimeout(() => {
      if (this.starting !== run || run.exited) {
        return;
      }
      this.options.log('Phone access did not start in time; cancelling it');
      void this.cancelAndStop();
    }, limit);
    timer.unref();

    void run.finished.then(({ code }) => {
      clearTimeout(timer);
      // A cancelled start reports through its stop; nothing to add here.
      if (code === 0 || this.stopping !== undefined) {
        return;
      }
      this.options.log(
        `Phone access did not start (exit ${code ?? 'signal'}); the desktop is unaffected. ` +
          'See `companion-phone status`.',
      );
    });
  }

  /**
   * Stop phone access before the listener goes away. Resolves true only when
   * `companion-phone stop` confirmed it is off, after any start in progress
   * can no longer create the service; never throws.
   */
  stop(): Promise<boolean> {
    return this.cancelAndStop();
  }

  /**
   * Cancel a start still in progress, then stop and confirm. Concurrent
   * callers share the operation already under way; a later call (after it
   * finished) runs a fresh stop, because something may have started since.
   */
  private cancelAndStop(): Promise<boolean> {
    if (this.stopping === undefined) {
      const operation = (async () => {
        let forced = false;
        const run = this.starting;
        if (run !== undefined && !run.exited) {
          this.options.log('Cancelling the phone access start that is still in progress');
          forced = await this.cancel(run);
        }
        return this.stopConfirmed(forced);
      })();
      this.stopping = operation;
      void operation.finally(() => {
        if (this.stopping === operation) {
          this.stopping = undefined;
        }
      });
    }
    return this.stopping;
  }

  /**
   * Cancel a start: SIGTERM, then wait for it to finish its current step. If
   * it overruns the grace period, kill its whole process group and wait until
   * the group is gone. Resolves whether it had to be killed.
   */
  private async cancel(run: Run): Promise<boolean> {
    signalProcess(run.child, 'SIGTERM', false);
    const grace = this.options.cancelGraceMilliseconds ?? 30_000;
    if (!(await overruns(run.finished, grace))) {
      return false;
    }

    this.options.log('The phone access start did not stop in time; killing it');
    signalProcess(run.child, 'SIGKILL', true);
    await run.finished;
    await groupGone(run.child, 5000);
    return true;
  }

  /**
   * Run `companion-phone stop`. After a forced kill, a start request might
   * still reach systemd a moment later, so wait and stop once more; only
   * the second result counts.
   */
  private async stopConfirmed(forced: boolean): Promise<boolean> {
    let stopped = await this.stopOnce();
    if (forced) {
      await delay(this.options.settleMilliseconds ?? 3000);
      stopped = await this.stopOnce();
    }
    return stopped;
  }

  private async stopOnce(): Promise<boolean> {
    const run = this.run(['stop']);
    const limit = this.options.stopTimeoutMilliseconds ?? 30_000;
    const timedOut = await overruns(run.finished, limit);
    if (timedOut) {
      signalProcess(run.child, 'SIGKILL', true);
    }
    const { code } = await run.finished;

    if (!timedOut && code === 0) {
      return true;
    }
    const reason = timedOut ? 'timed out' : `exit ${code ?? 'signal'}`;
    this.options.log(
      `Phone access may still be on (companion-phone stop: ${reason}); ` +
        'run `companion-phone stop` and check `companion-phone status`.',
    );
    return false;
  }

  /**
   * Run companion-phone in its own process group (detached), forwarding its
   * output lines to the log.
   */
  private run(args: string[]): Run {
    const child = spawn(this.options.executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: this.options.environment ?? process.env,
    });

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

    const run: Run = {
      child,
      finished: Promise.resolve({ code: null, timedOut: false }),
      exited: false,
    };
    run.finished = new Promise<Finished>((resolve) => {
      child.once('error', (error) => {
        run.exited = true;
        this.options.log(`Could not run ${this.options.executable}: ${error.message}`);
        resolve({ code: 127, timedOut: false });
      });
      // 'exit', not 'close': a descendant that keeps our output pipes open
      // must not keep the listener waiting.
      child.once('exit', (code) => {
        run.exited = true;
        resolve({ code, timedOut: false });
      });
    });
    return run;
  }
}

/** Signal the process, or (group = true) its whole process group. Never throws. */
function signalProcess(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(group ? -child.pid : child.pid, signal);
  } catch {
    // Already gone.
  }
}

/** Wait (bounded) until no process of the child's group is left. */
async function groupGone(child: ChildProcess, milliseconds: number): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0);
    } catch {
      return;
    }
    await delay(50);
  }
}

/**
 * Plain delay. Deliberately not unref'd: the listener awaits these during
 * shutdown, and an unref'd timer would let the process exit mid-way.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * True when `work` has not settled within `milliseconds`. The timer is
 * cleared as soon as `work` settles, so it never keeps the process alive.
 */
async function overruns(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), milliseconds);
  });
  try {
    return await Promise.race([work.then(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
