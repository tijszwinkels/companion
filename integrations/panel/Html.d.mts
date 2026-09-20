export const maxHtmlLength: number;
export const maxTextLength: number;
export interface HtmlBubble {
  version: 1;
  html: string;
  text: string;
}
export function normalizeHtml(source: unknown): string;
export function parseHtmlBubble(value: unknown): HtmlBubble;
export function renderHtml(
  source: string,
  scale: number,
  foreground: string,
  muted: string,
  accent: string,
  selection: string,
): string;

export function escapeText(value: string): string;
