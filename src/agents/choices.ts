import { voiceLabel } from '../core/voice-shortcut.ts';

/** A label is spoken; the optional description is also the submitted follow-up. */
export interface AgentChoice {
  readonly label: string;
  readonly description: string;
}

export interface AgentChoiceSet {
  readonly revision: string;
  readonly options: readonly AgentChoice[];
}

/**
 * Shared tool/backend boundary. Accept short labels, bracketed display strings,
 * or explicit objects. No executable action or hidden payload is accepted.
 * Replacing a set is atomic: one invalid/ambiguous option rejects the whole set.
 */
export function parseChoices(value: unknown): readonly AgentChoice[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw Error('Choices must be an array of at most 8 options; use [] to clear them');
  }

  const seen = new Set<string>();
  const options = value.map((value): AgentChoice => {
    let label: unknown;
    let description: unknown = '';
    if (typeof value === 'string') {
      const bracketed = value.trim().match(/^\[([^\]\n]+)\](?:\s*-\s*(.+))?$/u);
      label = bracketed ? bracketed[1] : value;
      description = bracketed?.[2] ?? '';
    } else if (value && typeof value === 'object') {
      const option = value as Record<string, unknown>;
      label = option.label;
      description = option.description ?? '';
    }

    if (
      typeof label !== 'string' ||
      !voiceLabel(label) ||
      label.length > 60 ||
      /[\r\n\[\]]/u.test(label) ||
      typeof description !== 'string' ||
      description.length > 1000
    ) {
      throw Error(
        'Each choice needs a 1–60 character label and an optional description of at most 1000 characters',
      );
    }
    const normalized = voiceLabel(label);
    if (seen.has(normalized)) {
      throw Error(`Choice labels must be distinct when spoken: ${label}`);
    }
    seen.add(normalized);
    return Object.freeze({ label: label.trim(), description: description.trim() });
  });
  return Object.freeze(options);
}

export function choiceText(choice: AgentChoice): string {
  return choice.description || choice.label;
}
