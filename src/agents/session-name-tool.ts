import { Type } from '@earendil-works/pi-ai';

import { parseSessionName } from './session-name.ts';

export const sessionNameToolName = 'companion_name_session';

/** Instructions live with the tool, alongside Pi's discoverable prompt hints. */
export function sessionNameTool(setSessionName: (title: string) => void) {
  return {
    name: sessionNameToolName,
    label: 'Name this conversation',
    promptSnippet: 'Give this Companion conversation a short, recognizable tab name.',
    promptGuidelines: [
      'Early in the first turn of each new conversation, call companion_name_session with a concise name for the user’s topic. Prefer one relevant emoji followed by 2–4 short words. Rename later only if the topic changes substantially.',
    ],
    description:
      'Name your current Companion conversation so the user can recognize its small sidebar tab. ' +
      'Call early after starting a new conversation, once you understand the initial request. ' +
      'Prefer one relevant emoji followed by 2–4 short words, for example "🐛 Login fix" or "🌱 Garden ideas". ' +
      'Keep the entire name under 40 characters; shorter is better. Name the topic, not the current progress. ' +
      'Do not rename on every turn; update it only when the conversation’s topic changes substantially. ' +
      'This changes only your own conversation’s display name; its history and identity are preserved.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 40 }),
    }),
    async execute(_id: string, parameters: { title: unknown }, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const title = parseSessionName(parameters.title);
      setSessionName(title);
      return {
        content: [{ type: 'text' as const, text: `Conversation named ${title}.` }],
      };
    },
  };
}

/** Pi owns the name; Companion reads it through Pi's native get_state RPC. */
export default function registerSessionName(pi: {
  registerTool(tool: ReturnType<typeof sessionNameTool>): void;
  setSessionName(title: string): void;
}): void {
  pi.registerTool(sessionNameTool((title) => pi.setSessionName(title)));
}
