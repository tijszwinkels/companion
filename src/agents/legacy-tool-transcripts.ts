import { createHash } from 'node:crypto';
import { chatMessage, type AgentMessage } from './types.ts';
import { toolPageUnits, type ToolPage, type ToolPageRequest } from './tool-transcripts.ts';

function identity(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Legacy recovery uses the existing archive, never a retained body-filled view. */
export function legacyToolSummary(owner: string, entries: AgentMessage[]): AgentMessage {
  return {
    ...chatMessage(identity(owner + '\0' + entries[0].id), 'tool', ''),
    state: entries.some((entry) => entry.state === 'error') ? 'error' : 'done',
    toolGroup: { count: entries.length, revision: identity(JSON.stringify(entries)), legacy: true },
  };
}

export function legacyToolGroups(
  owner: string,
  messages: AgentMessage[],
): Map<string, AgentMessage[]> {
  const groups = new Map<string, AgentMessage[]>();
  let entries: AgentMessage[] = [];
  const finish = () => {
    if (entries.length) {
      groups.set(legacyToolSummary(owner, entries).id, entries);
      entries = [];
    }
  };
  for (const message of messages) {
    if (message.kind !== 'tool' || message.toolGroup) {
      finish();
      continue;
    }
    if (
      typeof message.id !== 'string' ||
      typeof message.text !== 'string' ||
      typeof message.input !== 'string' ||
      typeof message.toolName !== 'string' ||
      !['queued', 'running', 'done', 'error'].includes(message.state)
    ) {
      throw Error('Invalid legacy tool details');
    }
    entries.push({
      ...chatMessage(message.id, 'tool', message.text),
      toolName: message.toolName,
      input: message.input,
      state: message.state === 'done' ? 'done' : 'error',
    });
  }
  finish();
  return groups;
}

export function legacyToolPage(request: ToolPageRequest, entries: AgentMessage[]): ToolPage {
  const summary = legacyToolSummary(request.id, entries);
  const message = entries[request.index];
  if (
    !Number.isSafeInteger(request.index) ||
    request.index < 0 ||
    !message ||
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0
  ) {
    throw Error('Invalid legacy tool detail position');
  }
  const callRevision = identity(JSON.stringify(message));
  if (
    request.callRevision
      ? request.callRevision !== callRevision
      : request.revision !== summary.toolGroup!.revision
  ) {
    throw Error('Tool output changed; reload this page');
  }
  const body = message.toolName + '\n\n' + message.input + '\n\n' + message.text;
  if (request.offset >= body.length) {
    throw Error('Invalid legacy tool detail offset');
  }
  let text = body.slice(request.offset, request.offset + toolPageUnits);
  const last = text.charCodeAt(text.length - 1);
  if (request.offset + text.length < body.length && last >= 0xd800 && last <= 0xdbff) {
    text = text.slice(0, -1);
  }
  const offset = request.offset + text.length;
  const next =
    offset < body.length
      ? { index: request.index, offset }
      : request.index + 1 < entries.length
        ? { index: request.index + 1, offset: 0 }
        : null;
  return {
    ...request,
    revision: summary.toolGroup!.revision,
    callRevision,
    text,
    state: message.state,
    next,
  };
}
