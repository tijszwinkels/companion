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
 *   (`lastText`, `plainPreview`);
 * - draft: the conversation's unsent text as one line, while drafts are
 *   shared with the listener and the conversation is not the one shown
 *   (README, "Listener drafts"): the strip marks it with ✎ and the full
 *   list reads "Draft: …" instead of the last line.
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
  /**
   * The unsent text as one line, or '': none, not shared with the listener,
   * or the conversation is the one shown.
   */
  draft: string;
  selected: boolean;
  working: boolean;
  unread: boolean;
  /**
   * The running turn's start on the listener's clock, as the listener sent
   * it (present only while a turn runs); whether a timer is shown follows
   * ../times/turn-times.ts.
   */
  turnStartedAt?: number;
}

/**
 * A title's first character as the reader sees it: its first grapheme
 * cluster where the browser can segment text (`Intl.Segmenter`), else its
 * whole first word, the rail's rule. (Firefox before 125, a supported
 * target, has no Segmenter; the shell must still start there.)
 */
function firstCharacter(text: string): string {
  if (typeof Intl.Segmenter === 'function') {
    const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const segment of graphemes.segment(text)) {
      return segment.segment;
    }
    return '';
  }
  return text.split(/\s+/)[0] ?? '';
}

/** Pictographs and flag letters (regional indicators), as the phone's tab icon detects them. */
const emojiStart = /^(\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

/** A keycap ("1️⃣"): a digit or sign followed by the combining keycap mark. */
const keycapMark = '\u20e3';

/** Whether a title's first character is an emoji. */
function isEmoji(first: string): boolean {
  return emojiStart.test(first) || first.includes(keycapMark);
}

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
  const first = firstCharacter(trimmed);
  if (first && isEmoji(first)) {
    return { glyph: first, caption: trimmed.slice(first.length).trim(), emoji: true };
  }
  return { glyph: `Q${number}`, caption: trimmed, emoji: false };
}

/** Whether a conversation's agent is working on a turn. */
export function isWorking(session: AgentSession): boolean {
  return session.status === 'starting' || session.status === 'running';
}

/** Unsent text as one line: whitespace and line breaks collapsed. */
export function draftLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The open conversations in the listener's order, as the list shows them.
 * `draftOf` gives a conversation's unsent text for the list ('' for none);
 * without it no entry shows a draft.
 */
export function listEntries(state: AppState, draftOf?: (id: string) => string): ListEntry[] {
  const entries: ListEntry[] = [];
  for (const id of state.order) {
    const session = state.sessions.get(id);
    if (!session) {
      continue;
    }
    const number = entries.length + 1;
    const title = session.title || 'Untitled';
    const { glyph, caption, emoji } = badgeOf(title, number);
    const selected = state.selected === id && !state.showingPrevious;
    let draft = '';
    if (draftOf && !selected) {
      draft = draftLine(draftOf(id));
    }
    entries.push({
      id,
      number,
      title,
      glyph,
      emoji,
      caption,
      lastLine: plainPreview(lastText(session)),
      draft,
      selected,
      working: isWorking(session),
      unread: state.unread.has(id),
      turnStartedAt: session.turnStartedAt,
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
  if (entry.draft) {
    label += ', unsent draft';
  }
  return label;
}
