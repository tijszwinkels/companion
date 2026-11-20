/**
 * What the conversation list shows for each open conversation, derived from
 * the phone panel's Store state with the phone panel's own rules:
 *
 * - order: the listener's (`state.order`); the number is the position in it,
 *   from 1, as in the rail and on the phone;
 * - icon: a leading emoji of the title, else "Q" and the number
 *   (`tabGlyph`, shared with the phone's Rail.tsx);
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
import { tabGlyph } from '../../../mobile/src/components/Rail.tsx';
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
    const { glyph, caption, emoji } = tabGlyph(title, number);
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
