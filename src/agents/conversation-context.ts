import type { AgentMessage, AgentSession } from './types.ts';

/** Plain-text evidence for routing; roles here are data, not model messages. */
export interface ConversationMessageExcerpt {
  readonly position: number;
  readonly role: 'user' | 'assistant';
  readonly state: AgentMessage['state'];
  readonly text: string;
  readonly truncated: boolean;
}

/** A bounded copy of one selected conversation at the speech-end boundary. */
export interface AgentConversationContext {
  readonly title: string;
  readonly titleTruncated: boolean;
  readonly totalMessages: number;
  readonly messages: readonly ConversationMessageExcerpt[];
}

const titleLimit = 200;
const messageLimit = 2000;
const messageBeginningLength = 1000;
const omissionMarker = '\n[... middle omitted ...]\n';

/**
 * Sample displayed user/assistant text, never tool results or provider history.
 * New objects contain only copied primitive values, so streaming updates, queued
 * turns and renames cannot change an observation while ASR/inference is pending.
 */
export function conversationContext(
  session: Pick<AgentSession, 'title' | 'messages'>,
): AgentConversationContext {
  const messages = session.messages.filter(
    (message): message is AgentMessage & { kind: 'user' | 'assistant' } =>
      (message.kind === 'user' || message.kind === 'assistant') && message.text.trim() !== '',
  );
  const excerpts: ConversationMessageExcerpt[] = [];

  for (const [index, message] of messages.entries()) {
    // Taking the union by position includes short conversations only once.
    if (index >= 2 && index < messages.length - 2) {
      continue;
    }

    // Count code points so clipping cannot split a surrogate pair. Preserve the
    // beginning and end of long messages, including the marker within the cap.
    const characters = [...message.text];
    const truncated = characters.length > messageLimit;
    let text = message.text;

    if (truncated) {
      const endingLength = messageLimit - messageBeginningLength - omissionMarker.length;
      text =
        characters.slice(0, messageBeginningLength).join('') +
        omissionMarker +
        characters.slice(-endingLength).join('');
    }

    excerpts.push({
      position: index + 1,
      role: message.kind,
      state: message.state,
      text,
      truncated,
    });
  }

  const titleCharacters = [...session.title];
  const titleTruncated = titleCharacters.length > titleLimit;
  const title = titleTruncated
    ? titleCharacters.slice(0, titleLimit - 1).join('') + '…'
    : session.title;

  return { title, titleTruncated, totalMessages: messages.length, messages: excerpts };
}
