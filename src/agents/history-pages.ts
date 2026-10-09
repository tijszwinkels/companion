import type { AgentMessage, AgentSession } from './types.ts';

/** Display budgets, not storage or model-context limits. One page is retained
 * by each reader; tool bodies continue to use the separate tool-page API. */
export const historyPageRows = 200;
export const historyPageText = 64 * 1024;

/** A position between UTF-16 units of input + text in an append-only row list.
 * At row boundaries offset is zero. Empty rows (tools/widgets) still advance. */
export interface HistoryPosition {
  index: number;
  offset: number;
}

export interface HistoryWindow {
  start: HistoryPosition;
  end: HistoryPosition;
  total: number;
  revision: number;
  /** Ordered retained IDs: deltas MUST prune everything not in this list. */
  ids: string[];
}

export interface HistoryPage {
  id: string;
  epoch: string;
  messages: AgentMessage[];
  history: HistoryWindow;
}

export interface HistoryPageRequest {
  id: string;
  epoch: string;
  direction: 'before' | 'after';
  index: number;
  offset: number;
  /** Jump directly to an origin's tool group without loading intermediate pages. */
  anchor?: string;
}

function size(message: AgentMessage): number {
  return message.input.length + message.text.length;
}

function fragment(message: AgentMessage, start: number, end: number): AgentMessage {
  if (start === 0 && end === size(message)) {
    return message;
  }
  const inputEnd = message.input.length;
  return {
    ...message,
    input: message.input.slice(start, Math.min(end, inputEnd)),
    text: message.text.slice(Math.max(0, start - inputEnd), Math.max(0, end - inputEnd)),
    // UI labels fragments explicitly. Copies copy only the displayed fragment.
    historyFragment: { start, end, total: size(message) },
  };
}

/** Read a bounded contiguous page from authoritative history. Positions remain
 * stable when new rows arrive. An epoch rejects cursors across close/reopen;
 * current revisions label older, potentially outdated reader snapshots. No page
 * is ever written back to storage. Giant individual messages span pages too. */
export function historyPage(
  session: AgentSession,
  revision: number,
  direction: 'before' | 'after' = 'before',
  position: HistoryPosition = { index: session.messages.length, offset: 0 },
): HistoryPage {
  const source = session.messages;
  let { index, offset } = position;
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > source.length ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (offset > 0 && (index === source.length || offset >= size(source[index])))
  ) {
    throw Error('History position changed; return to Latest or refresh the page');
  }

  const messages: AgentMessage[] = [];
  let remaining = historyPageText;
  const boundary = { index, offset };
  while (messages.length < historyPageRows && remaining > 0) {
    if (direction === 'before') {
      if (offset === 0) {
        if (index === 0) {
          break;
        }
        index--;
        offset = size(source[index]);
      }
      const start = Math.max(0, offset - remaining);
      messages.unshift(fragment(source[index], start, offset));
      remaining -= offset - start;
      offset = start;
    } else {
      if (index === source.length) {
        break;
      }
      const end = Math.min(size(source[index]), offset + remaining);
      messages.push(fragment(source[index], offset, end));
      remaining -= end - offset;
      offset = end;
      if (offset === size(source[index])) {
        index++;
        offset = 0;
      }
    }
  }
  const other = { index, offset };
  return {
    id: session.id,
    epoch: session.toolEpoch ?? '',
    messages,
    history: {
      start: direction === 'before' ? other : boundary,
      end: direction === 'before' ? boundary : other,
      total: source.length,
      revision,
      ids: messages.map((message) => message.id),
    },
  };
}
