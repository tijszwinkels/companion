import type { Screenshot } from '../../core/frame.ts';
import { command } from '../../system/command.ts';

export type RunCommand = typeof command;

/** Only the fields needed from Hyprland's activewindow response. */
interface Window {
  address: string;
  class: string;
  title: string;
  at: [number, number];
  size: [number, number];
  monitor: number;
  mapped: boolean;
  hidden: boolean;
}

interface Monitor {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  transform: number;
}

/** Shared by screenshot capture and the processor's final focus check. */
export async function activeWindow(
  signal: AbortSignal,
  run: RunCommand = command,
): Promise<Window> {
  const window: Window = JSON.parse(
    (await run('hyprctl', ['-j', 'activewindow'], signal)).toString(),
  );

  // An empty desktop or an unavailable session can return no usable window.
  if (
    !/^0x[0-9a-f]+$/i.test(window.address) ||
    !window.mapped ||
    window.hidden ||
    typeof window.class !== 'string' ||
    typeof window.title !== 'string' ||
    ![window.at, window.size].every(
      (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite),
    )
  ) {
    throw Error('No visible active window; run Companion inside your Hyprland desktop session');
  }

  return window;
}

/** Capture the visible active-window rectangle, then verify it stayed stable. */
export async function captureActiveWindow(
  signal: AbortSignal,
  run: RunCommand = command,
): Promise<Screenshot> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const before = await activeWindow(deadline, run);

  const monitors: Monitor[] = JSON.parse(
    (await run('hyprctl', ['-j', 'monitors'], deadline)).toString(),
  );
  const monitor = monitors.find((m) => m.id === before.monitor);

  if (!monitor || !Number.isFinite(monitor.scale) || monitor.scale <= 0) {
    throw Error('Active monitor unavailable');
  }

  // Window positions are logical coordinates. Account for monitor rotation and
  // scaling before clipping, especially when a window extends beyond an edge.
  const rotated = monitor.transform % 2 === 1;
  const monitorWidth = (rotated ? monitor.height : monitor.width) / monitor.scale;
  const monitorHeight = (rotated ? monitor.width : monitor.height) / monitor.scale;
  const [windowX, windowY] = before.at;
  const [windowWidth, windowHeight] = before.size;

  const x = Math.ceil(Math.max(windowX, monitor.x));
  const y = Math.ceil(Math.max(windowY, monitor.y));
  const width = Math.floor(Math.min(windowX + windowWidth, monitor.x + monitorWidth)) - x;
  const height = Math.floor(Math.min(windowY + windowHeight, monitor.y + monitorHeight)) - y;

  if (![x, y, width, height].every(Number.isFinite) || width < 8 || height < 8) {
    throw Error('Active window is outside the monitor');
  }

  // Limit the image's longest side to 1280 pixels. Sending PNG on stdout avoids
  // writing screenshots to disk; grim may still include overlapping surfaces.
  const png = await run(
    'grim',
    [
      '-t',
      'png',
      '-s',
      String(Math.min(1, 1280 / Math.max(width, height))),
      '-g',
      `${x},${y} ${width}x${height}`,
      '-',
    ],
    deadline,
  );

  // Focus, geometry, or title may have changed while grim was capturing. In that
  // case, discard this observation instead of attaching mismatched window data.
  const after = await activeWindow(deadline, run);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw Error('Active window changed during capture; frame discarded');
  }

  if (
    png.length < 33 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw Error('Invalid screenshot');
  }

  return {
    png,
    capturedAt: Date.now(),
    window: { address: before.address, app: before.class, title: before.title },
    // PNG's IHDR header stores the final dimensions, including grim's scaling.
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}
