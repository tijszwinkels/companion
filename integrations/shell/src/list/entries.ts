/**
 * What the conversation list shows for each open conversation, derived from
 * the phone panel's Store state with the phone panel's own rules:
 *
 * - order: the listener's (`state.order`); the number is the position in it,
 *   from 1, as in the rail and on the phone;
 * - icon: a leading emoji of the title, else "Q" and the number, as in
 *   the rail and on the phone (see `badgeOf`);
 * - working: the conversation's status is `starting` or `running` (the
 *   turning ring), as in the rail and on the phone;
 * - unread: the Store's `unread` set (the green dot and tint). The Store
 *   sets it when a turn completes out of view or when a conversation
 *   arrives from elsewhere, and clears it when this page selects or loses
 *   the conversation; see the README's "Markers";
 * - last line: the latest user or assistant text as one plain line
 *   (`lastText`, `plainPreview`).
 */

import type { AgentSession } from '../../../../src/agents/types.ts';
import { lastText, plainPreview, type AppState } from '../../../mobile/src/store.ts';

export interface ListEntry {
  id: string;
  /** Position in the listener's order, from 1. */
  number: number;
  /** The whole title (tooltip, chat bar, accessible name). */
  title: string;
  /** The icon: a leading emoji, or "Q" and the number. */
  glyph: string;
  /** Whether the icon is an emoji (then the number is drawn next to it). */
  emoji: boolean;
  /** The title without its leading emoji. */
  caption: string;
  /** The last user or assistant text, as one plain line. */
  lastLine: string;
  selected: boolean;
  working: boolean;
  unread: boolean;
}

/** A title's first character as the reader sees it (one grapheme cluster). */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Emoji, flags (regional indicators) and keycaps, as the phone's tab icon detects them. */
const emojiPattern = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

/**
 * The entry's icon and caption. A title that starts with an emoji shows that
 * emoji as its icon and the rest of the title as its caption; any other
 * title shows "Q" and the number, with the whole title as its caption.
 *
 * The emoji is the first grapheme cluster only, so flags, skin tones and
 * joined sequences stay whole, and a title whose emoji is not followed by a
 * space ("🧪Investigate") keeps its first word in the caption. (The rail
 * and the phone take the whole first word; with the usual "emoji, space,
 * words" titles the result is the same.)
 */
export function badgeOf(
  title: string,
  number: number,
): { glyph: string; caption: string; emoji: boolean } {
  const trimmed = title.trim();
  let first = '';
  for (const segment of graphemes.segment(trimmed)) {
    first = segment.segment;
    break;
  }
  if (first && emojiPattern.test(first)) {
    return { glyph: first, caption: trimmed.slice(first.length).trim(), emoji: true };
  }
  return { glyph: `Q${number}`, caption: trimmed, emoji: false };
}

/** Whether a conversation's agent is working on a turn. */
export function isWorking(session: AgentSession): boolean {
  return session.status === 'starting' || session.status === 'running';
}

/** The open conversations in the listener's order, as the list shows them. */
export function listEntries(state: AppState): ListEntry[] {
  const entries: ListEntry[] = [];
  for (const id of state.order) {
    const session = state.sessions.get(id);
    if (!session) {
      continue;
    }
    const number = entries.length + 1;
    const title = session.title || 'Untitled';
    const { glyph, caption, emoji } = badgeOf(title, number);
    entries.push({
      id,
      number,
      title,
      glyph,
      emoji,
      caption,
      lastLine: plainPreview(lastText(session)),
      selected: state.selected === id && !state.showingPrevious,
      working: isWorking(session),
      unread: state.unread.has(id),
    });
  }
  return entries;
}

/**
 * The accessible name of an entry: number, title and markers, like the
 * phone's tab ("2. Login timeout, working, new answer").
 */
export function entryLabel(entry: ListEntry): string {
  let label = `${entry.number}. ${entry.title}`;
  if (entry.working) {
    label += ', working';
  }
  if (entry.unread) {
    label += ', new answer';
  }
  return label;
}
