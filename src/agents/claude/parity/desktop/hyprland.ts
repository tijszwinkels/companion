/**
 * Hyprland access shared by the desktop parity tools (`list_windows`,
 * `focus_window`, `screenshot_active_window`, `click_active_window`).
 *
 * These tools reproduce the user's Pi `active-window` extension for Claude
 * Code conversations. Every compositor query goes through a `DesktopCommand`,
 * so tests replace `hyprctl`, `grim` and the pointer helper with synthetic
 * compositor state and never touch the real desktop.
 */
import { execFile } from 'node:child_process';

/** Options for one bounded desktop command. */
export interface DesktopCommandOptions {
  signal: AbortSignal;
  /** The command is killed after this many milliseconds. */
  timeoutMilliseconds: number;
}

/**
 * Run a program without a shell and return its standard output as text.
 * Rejects when the program fails, times out or the signal aborts.
 */
export type DesktopCommand = (
  file: string,
  args: string[],
  options: DesktopCommandOptions,
) => Promise<string>;

/** The Hyprland `clients`/`activewindow` fields the tools read. */
export interface HyprlandWindow {
  address?: unknown;
  class?: unknown;
  title?: unknown;
  pid?: unknown;
  workspace?: { id?: unknown; name?: unknown };
  monitor?: unknown;
  at?: unknown;
  size?: unknown;
  mapped?: unknown;
  hidden?: unknown;
  visible?: unknown;
  acceptsInput?: unknown;
}

/** Hyprland's JSON replies are small; this bounds a misbehaving reply. */
const maximumOutputBytes = 4 * 1024 * 1024;

/** The real command runner: `execFile`, UTF-8 output, bounded size and time. */
export const runDesktopCommand: DesktopCommand = (file, args, options) => {
  options.signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: maximumOutputBytes,
        timeout: options.timeoutMilliseconds,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (options.signal.aborted) {
          reject(options.signal.reason);
        } else if (error) {
          reject(Error(`${file}: ${error.message} ${stderr.slice(-300)}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
};

/**
 * A usable window address: `0x` followed by hex digits, but not the empty
 * address `0x0` that Hyprland reports when no window is active.
 */
export function validWindowAddress(address: unknown): address is string {
  return typeof address === 'string' && /^0x[0-9a-f]+$/i.test(address) && !/^0x0+$/i.test(address);
}

/**
 * The window's screen rectangle in grim's `x,y WxH` form, in logical pixels.
 * This string is the identity that screenshots hand to clicks, so the same
 * function formats it everywhere. Throws for a missing, hidden or unmapped
 * window and for invalid geometry.
 */
export function windowRegion(window: HyprlandWindow): string {
  if (
    !window.address ||
    window.address === '0x0' ||
    window.mapped === false ||
    window.hidden === true
  ) {
    throw Error('No visible active Hyprland window. Focus a window and retry.');
  }

  const at = Array.isArray(window.at) ? window.at : [];
  const size = Array.isArray(window.size) ? window.size : [];
  const values = [...at, ...size];
  const valid =
    values.length === 4 &&
    values.every((value) => Number.isSafeInteger(value)) &&
    values[2] > 0 &&
    values[3] > 0;

  if (!valid) {
    throw Error('Hyprland returned invalid window geometry.');
  }

  return `${values[0]},${values[1]} ${values[2]}x${values[3]}`;
}

/** Read one `hyprctl -j <kind>` reply as JSON. */
export async function readHyprland(
  run: DesktopCommand,
  kind: 'clients' | 'activewindow' | 'cursorpos',
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<unknown> {
  signal.throwIfAborted();
  const output = await run('hyprctl', ['-j', kind], { signal, timeoutMilliseconds });
  return JSON.parse(output) as unknown;
}

/** The active window, or an empty object when Hyprland reports something else. */
export async function readActiveWindow(
  run: DesktopCommand,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<HyprlandWindow> {
  const reply = await readHyprland(run, 'activewindow', signal, timeoutMilliseconds);
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
    return {};
  }

  return reply as HyprlandWindow;
}

/** An application name exactly as the tools report and compare it. */
export function windowApp(window: HyprlandWindow, maximumLength: number): string {
  return String(window.class ?? '').slice(0, maximumLength);
}

/**
 * Serializes desktop actions within one bridge process. Pi's guidance tells
 * the model to run focus, screenshot and click one after another; Claude Code
 * may still issue tool calls in parallel, so the bridge enforces the order it
 * receives them in. A failed action does not block the next one.
 */
export class DesktopActionQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<Result>(action: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(action, action);
    this.tail = result.catch(() => {});
    return result;
  }
}
