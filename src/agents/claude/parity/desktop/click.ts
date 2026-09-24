/**
 * `click_active_window`: one left click at a window-relative point, following
 * the Pi `active-window` extension's `click.mjs`.
 *
 * The caller must pass the address and region of a fresh screenshot. The
 * window is checked against both before the cursor moves and again after,
 * and the cursor position is verified before the click is sent. The click
 * itself comes from the configured `pointer-click` helper (Wayland virtual
 * pointer). These checks are not atomic with compositor input, so they are a
 * staleness guard, not a security boundary.
 */
import {
  readActiveWindow,
  readHyprland,
  windowRegion,
  type DesktopCommand,
  type HyprlandWindow,
} from './hyprland.ts';

/** Deadline of each `hyprctl` and helper call. */
const commandTimeoutMilliseconds = 5000;

export interface ClickParameters {
  x: number;
  y: number;
  window_address: string;
  expected_region: string;
  dry_run?: boolean;
}

/**
 * Click, or with `dry_run` only validate. `pointerHelper` is the absolute
 * path of the helper; without it only dry runs are possible.
 */
export async function clickActiveWindow(
  parameters: ClickParameters,
  pointerHelper: string | undefined,
  run: DesktopCommand,
  signal: AbortSignal,
): Promise<string> {
  const { x, y, window_address: address, expected_region: expectedRegion } = parameters;
  const dryRun = parameters.dry_run === true;
  signal.throwIfAborted();

  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
    throw Error('Coordinates must be non-negative integer logical pixels relative to the window.');
  }

  if (!/^0x[0-9a-f]+$/i.test(address ?? '') || typeof expectedRegion !== 'string') {
    throw Error('Provide window_address and expected_region from a fresh screenshot.');
  }

  const options = { signal, timeoutMilliseconds: commandTimeoutMilliseconds };

  // The same window, at the same place and size, as in the screenshot the
  // model chose its coordinates from; and the point inside it.
  const check = (window: HyprlandWindow) => {
    if (windowRegion(window) !== expectedRegion || window.address !== address) {
      throw Error('Active window or geometry changed. Take a fresh screenshot before clicking.');
    }

    const [width, height] = window.size as [number, number];
    if (x >= width || y >= height) {
      throw Error('Click is outside the active window.');
    }
  };

  const window = await readActiveWindow(run, signal, commandTimeoutMilliseconds);
  check(window);
  const [left, top] = window.at as [number, number];
  const target = { x: left + x, y: top + y };

  if (!dryRun) {
    if (!pointerHelper) {
      throw Error(
        'Clicking needs the pointer-click helper: set desktop.pointerHelper in claude-tools.json. No input was sent.',
      );
    }

    // Fails early, before moving the cursor, when the compositor lacks the
    // virtual-pointer protocol.
    await run(pointerHelper, ['--check'], options);

    // Hyprland 0.56 Lua dispatch syntax; the coordinates are validated integers.
    const moved = await run(
      'hyprctl',
      ['dispatch', `hl.dsp.cursor.move({ x = ${target.x}, y = ${target.y} })`],
      options,
    );
    if (moved.trim() !== 'ok') {
      throw Error(`Cursor move failed: ${moved.slice(0, 512)}`);
    }

    check(await readActiveWindow(run, signal, commandTimeoutMilliseconds));
    const cursor = (await readHyprland(run, 'cursorpos', signal, commandTimeoutMilliseconds)) as {
      x?: unknown;
      y?: unknown;
    } | null;
    if (cursor?.x !== target.x || cursor?.y !== target.y) {
      throw Error('Cursor moved or target is not reachable; click cancelled.');
    }

    signal.throwIfAborted();
    await run(pointerHelper, ['--left'], options);
  }

  const action = dryRun ? 'Dry run: would left-click' : 'Sent left click';
  const followUp = dryRun
    ? ' No input sent.'
    : ' Take a fresh screenshot to verify the result; do not blindly retry.';
  return `${action} at window-relative (${x}, ${y}), global (${target.x}, ${target.y}).${followUp}`;
}
