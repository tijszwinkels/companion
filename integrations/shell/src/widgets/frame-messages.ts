/**
 * The messages between the shell and one inline widget frame
 * (integrations/shell/README.md, "Inline widgets", the messages rule). The
 * other end is integrations/widgets/host.js in its embedded mode.
 *
 * Frame → shell:
 *   { type: 'geometry', height: number }   the widget's content height, px
 *   { type: 'error', text: string }        its first state could not be drawn
 *
 * Shell → frame:
 *   { type: 'theme', theme: { foreground, background, accent, muted, scale } }
 *   { type: 'visible', visible: boolean }
 *
 * Nothing else crosses in either direction: no message can grant a
 * permission, name another view, or carry the device token or a
 * conversation ID. This file has no DOM access, so its rules are tested in
 * Node (test/shell/inline-widget-rules.test.ts).
 */

/**
 * The inline height bounds, in CSS pixels: the desktop sidebar's
 * (integrations/panel/WidgetSurface.qml, `minimumFitHeight` 100 and
 * `maximumFitHeight` 420 theme units), at the shell's theme unit and text
 * scale of 1.
 */
export const minimumFrameHeight = 100;
export const maximumFrameHeight = 420;

/** Longest error text the shell shows from a frame; the rest is cut off. */
export const maximumErrorText = 200;

/** Companion's text-scale range (src/widgets/types.ts), also checked by host.js. */
export const minimumThemeScale = 0.4;
export const maximumThemeScale = 6;

export type FrameMessage = { type: 'geometry'; height: number } | { type: 'error'; text: string };

/** The parts of a `message` event the shell's checks use. */
export interface ReceivedMessage {
  source: unknown;
  origin: string;
  data: unknown;
}

/** What one panel expects: its own iframe's window and its frame origin. */
export interface ExpectedSender {
  /** The iframe's `contentWindow`, or null when it is not in the page. */
  frameWindow: unknown;
  frameOrigin: string;
}

/**
 * The message as the shell may act on it, or null to ignore it. Accepted only
 * from the panel's own iframe window, with the frame origin as its origin,
 * and only in one of the two shapes with exactly their fields. A geometry
 * height that is not a finite number is ignored; any other height is clamped
 * to the inline bounds and rounded. An error text is cut to 200 characters.
 */
export function readFrameMessage(
  message: ReceivedMessage,
  expected: ExpectedSender,
): FrameMessage | null {
  if (expected.frameWindow === null || message.source !== expected.frameWindow) {
    return null;
  }
  if (message.origin !== expected.frameOrigin) {
    return null;
  }

  const data = message.data;
  if (!isPlainObject(data)) {
    return null;
  }

  if (data.type === 'geometry' && hasExactly(data, ['type', 'height'])) {
    const height = clampFrameHeight(data.height);
    if (height === null) {
      return null;
    }
    return { type: 'geometry', height: height };
  }

  if (data.type === 'error' && hasExactly(data, ['type', 'text'])) {
    if (typeof data.text !== 'string') {
      return null;
    }
    return { type: 'error', text: data.text.slice(0, maximumErrorText) };
  }

  return null;
}

/**
 * A reported content height within the inline bounds, in whole pixels, or
 * null when it is not a finite number. Negative and huge values are clamped.
 */
export function clampFrameHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return Math.max(minimumFrameHeight, Math.min(maximumFrameHeight, rounded));
}

/** The colours and text scale a frame is drawn with. Colours are `#rrggbb`. */
export interface FrameTheme {
  foreground: string;
  background: string;
  accent: string;
  muted: string;
  scale: number;
}

export function themeMessage(theme: FrameTheme): {
  type: 'theme';
  theme: FrameTheme;
} {
  return {
    type: 'theme',
    theme: {
      foreground: theme.foreground,
      background: theme.background,
      accent: theme.accent,
      muted: theme.muted,
      scale: theme.scale,
    },
  };
}

export function visibleMessage(visible: boolean): { type: 'visible'; visible: boolean } {
  return { type: 'visible', visible: visible };
}

/** The colours used when the page's own cannot be read (the chat's defaults). */
export const defaultFrameTheme: FrameTheme = {
  foreground: '#a9b1d6',
  background: '#1a1b26',
  accent: '#7aa2f7',
  muted: '#737b9c',
  scale: 1,
};

const hexColour = /^#[0-9a-fA-F]{6}$/;

/** How much of the foreground a message panel mixes into the background (`--tint`). */
const panelTint = 0.04;

/**
 * The page's theme for frames, from its CSS custom properties
 * (`--foreground` and so on, chat/styles.css). Each colour that is not a
 * plain `#rrggbb` value keeps its default, so nothing else reaches a frame.
 * The background is the message panel's (`--tint` over `--background`), so
 * the widget's page is drawn on the same colour as the panel around it.
 */
export function themeFromVariables(read: (name: string) => string): FrameTheme {
  const theme: FrameTheme = { ...defaultFrameTheme };
  for (const name of ['foreground', 'background', 'accent', 'muted'] as const) {
    const value = read('--' + name).trim();
    if (hexColour.test(value)) {
      theme[name] = value;
    }
  }
  theme.background = mixColours(theme.foreground, theme.background, panelTint);
  return theme;
}

/** `share` of `over` on top of `base`, both `#rrggbb`, as `#rrggbb`. */
export function mixColours(over: string, base: string, share: number): string {
  let mixed = '#';
  for (let start = 1; start < 7; start += 2) {
    const top = parseInt(over.slice(start, start + 2), 16);
    const bottom = parseInt(base.slice(start, start + 2), 16);
    const channel = Math.round(top * share + bottom * (1 - share));
    mixed += channel.toString(16).padStart(2, '0');
  }
  return mixed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  if (own.length !== keys.length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      return false;
    }
  }
  return true;
}
