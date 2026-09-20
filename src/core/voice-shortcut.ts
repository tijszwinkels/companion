/** Exact spoken labels tolerate ASR casing, spacing, and sentence endings only. */
export function voiceLabel(text: string): string {
  return text
    .trim()
    .replace(/[.!?]+$/u, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}
