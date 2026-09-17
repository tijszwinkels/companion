import type { Screenshot } from './frame.ts';
import { command } from './command.ts';

export type RunCommand = typeof command;
interface Window {
  address: string; class: string; title: string; at: [number, number]; size: [number, number];
  monitor: number; mapped: boolean; hidden: boolean;
}

export async function activeWindow(signal: AbortSignal, run: RunCommand = command): Promise<Window> {
  const window: Window = JSON.parse((await run('hyprctl', ['-j', 'activewindow'], signal)).toString());
  if (!/^0x[0-9a-f]+$/i.test(window.address) || !window.mapped || window.hidden ||
      typeof window.class !== 'string' || typeof window.title !== 'string' ||
      ![window.at, window.size].every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite))) {
    throw Error('No visible active window; run Companion inside your Hyprland desktop session');
  }
  return window;
}

export async function captureActiveWindow(signal: AbortSignal, run: RunCommand = command): Promise<Screenshot> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const before = await activeWindow(deadline, run);
  const monitors = JSON.parse((await run('hyprctl', ['-j', 'monitors'], deadline)).toString()) as
    { id: number; x: number; y: number; width: number; height: number; scale: number; transform: number }[];
  const monitor = monitors.find(m => m.id === before.monitor);
  if (!monitor || !Number.isFinite(monitor.scale) || monitor.scale <= 0) throw Error('Active monitor unavailable');
  const rotated = monitor.transform % 2 === 1;
  const mw = (rotated ? monitor.height : monitor.width) / monitor.scale;
  const mh = (rotated ? monitor.width : monitor.height) / monitor.scale;
  const [wx, wy] = before.at, [ww, wh] = before.size;
  const x = Math.ceil(Math.max(wx, monitor.x)), y = Math.ceil(Math.max(wy, monitor.y));
  const width = Math.floor(Math.min(wx + ww, monitor.x + mw)) - x;
  const height = Math.floor(Math.min(wy + wh, monitor.y + mh)) - y;
  if (![x, y, width, height].every(Number.isFinite) || width < 8 || height < 8) throw Error('Active window is outside the monitor');
  const png = await run('grim', ['-t', 'png', '-s', String(Math.min(1, 1280 / Math.max(width, height))),
    '-g', `${x},${y} ${width}x${height}`, '-'], deadline);
  const after = await activeWindow(deadline, run);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Active window changed during capture; frame discarded');
  if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw Error('Invalid screenshot');
  }
  return { png, capturedAt: Date.now(), window: { address: before.address, app: before.class, title: before.title },
    width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
