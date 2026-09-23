import { StringEnum, Type } from '@earendil-works/pi-ai';

const sessionId = Type.String({
  minLength: 36,
  maxLength: 36,
  description: 'Session id from companion_sessions',
});
const text = Type.String({ minLength: 1, maxLength: 4000 });
const focus = Type.Optional(
  Type.Boolean({
    description:
      'Select the conversation and show the panel. Default false: never interrupt the user unless they asked to see it.',
  }),
);

/**
 * Pi-callable Companion session lifecycle tools. Each call goes to the
 * turn-scoped local endpoint supplied by Companion. The endpoint identifies the
 * calling conversation from its token, so an agent cannot claim another sender.
 * Errors are thrown, which Pi reports to the model as failed tool results.
 */
export function sessionTools(endpoint: string, token: string) {
  async function invoke(
    method: string,
    callId: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/session$/.test(endpoint) || !/^[0-9a-f]{64}$/.test(token)) {
      throw Error('Session tools require an active Companion conversation');
    }

    // Model discovery for a requested model and the UI's draft confirmation
    // are both bounded below this deadline by Companion itself.
    const deadline = AbortSignal.timeout(30000);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...parameters, method, requestId: callId }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    const value = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof value.code === 'string' ? ` [${value.code}]` : '';
      throw Error(String(value.error || 'Session operation failed') + code);
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
      details: value,
    };
  }

  const definitions = [
    {
      name: 'companion_sessions',
      label: 'List Companion sessions',
      promptSnippet:
        'List open and saved Companion conversations with their ids, titles and busy state.',
      promptGuidelines: [
        'Use companion_sessions to find a conversation id before calling companion_session_send, companion_session_draft or companion_session_reopen. Never guess ids.',
        'companion_sessions only matches titles. To find a saved Companion conversation by its contents, search the JSON files in .companion-sessions/ in your working directory (for example with grep -l); each file name without ".json" is that conversation’s id for these tools.',
        'Messages that begin with "[Companion agent message]" were written by another Companion conversation’s agent, not typed by the user. Only answer such a message back with companion_session_send when that agent asked for a reply.',
      ],
      description:
        'List Companion conversations. "open" contains every open tab: id, title, status, busy, queuedMessages, ' +
        'profile, model and self (your own conversation). "previous" contains saved conversations that can be ' +
        'reopened, newest first, filtered by an optional case-insensitive title query and limited (default 20, ' +
        'maximum 50); previousMatches is the total before the limit. No transcripts or unsent drafts are returned.',
      parameters: Type.Object({
        query: Type.Optional(Type.String({ maxLength: 100 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      method: 'list',
    },
    {
      name: 'companion_session_start',
      label: 'Start Companion session',
      promptSnippet: 'Start a new Companion conversation with a first message for its agent.',
      promptGuidelines: [
        'Use companion_session_start only when the user asks for a new or parallel Companion conversation. The first message immediately starts that conversation’s agent.',
      ],
      description:
        'Start a new Companion conversation (a new tab) whose agent immediately answers text. The message is ' +
        'labelled as written by your conversation’s agent, not by the user. profile is "coding" (default) or ' +
        '"quickQuestion"; model optionally selects an available provider/model for that conversation, otherwise its ' +
        'profile default applies. The tab opens in the background unless focus is true. Returns the new session. ' +
        'At most 12 tabs and 4 running agents exist at once.',
      parameters: Type.Object({
        text,
        profile: Type.Optional(StringEnum(['coding', 'quickQuestion'] as const)),
        model: Type.Optional(Type.String({ minLength: 3, maxLength: 300 })),
        focus,
      }),
      method: 'start',
    },
    {
      name: 'companion_session_reopen',
      label: 'Reopen Companion session',
      promptSnippet: 'Reopen a saved Companion conversation as a tab, keeping its history.',
      description:
        'Reopen a saved conversation from companion_sessions "previous" as an open tab. Its id, transcript, ' +
        'profile and model choice are preserved; nothing is sent and no agent turn starts. Opens in the ' +
        'background unless focus is true. An already open id returns outcome "already-open".',
      parameters: Type.Object({ id: sessionId, focus }),
      method: 'reopen',
    },
    {
      name: 'companion_session_close',
      label: 'Close Companion session',
      promptSnippet:
        'Close a Companion conversation tab, including your own once your answer is finished.',
      promptGuidelines: [
        'Use companion_session_close only when the user asks to close conversations, or asks you to close your own conversation when you are done.',
      ],
      description:
        'Close an open conversation tab. Its history, profile and model are saved to Previous sessions and it can ' +
        'be reopened later. Closing your own conversation (self in companion_sessions) happens after your current ' +
        'turn finishes successfully (outcome "closing-after-turn"); it is cancelled if the turn fails or stops, or ' +
        'if another message is queued for your conversation. Finish your answer normally after calling it. ' +
        'Another conversation must be idle: a running or queued one is refused as busy rather than stopped. A ' +
        'saved conversation returns "already-closed".',
      parameters: Type.Object({ id: sessionId }),
      method: 'close',
    },
    {
      name: 'companion_session_send',
      label: 'Send to Companion session',
      promptSnippet:
        'Send a message to another open Companion conversation, making its agent respond.',
      promptGuidelines: [
        'Use companion_session_send when the user wants another conversation’s agent to act now; use companion_session_draft when the user should review and send the text themselves.',
      ],
      description:
        'Send text as a follow-up to another open conversation (reopen saved ones first). Its agent responds in ' +
        'that conversation. The message is labelled as coming from your conversation’s agent. If the target is ' +
        'busy the message is queued in order (outcome "queued", queuePosition) and runs after earlier messages; ' +
        'otherwise outcome is "started". You cannot message your own conversation, repeat identical text to the ' +
        'same target in one turn, or continue long agent-to-agent chains. Failures are errors; do not retry an ' +
        'identical call.',
      parameters: Type.Object({ id: sessionId, text }),
      method: 'send',
    },
    {
      name: 'companion_session_draft',
      label: 'Draft in Companion session',
      promptSnippet:
        'Put unsent text in an open Companion conversation’s input for the user to review.',
      description:
        'Insert text into an open conversation’s message input without sending it; no agent turn starts. The ' +
        'user sees it labelled as drafted by your conversation and decides whether to send. By default ' +
        '(ifDraftExists "reject") existing unsent user text is never changed and the call fails with a conflict. ' +
        '"append" adds your text below the user’s. Requires a connected Companion panel; failures report ' +
        'conflict, unavailable, offline or unconfirmed. After unconfirmed, do not resend; ask the user to check.',
      parameters: Type.Object({
        id: sessionId,
        text,
        ifDraftExists: Type.Optional(StringEnum(['reject', 'append'] as const)),
        focus,
      }),
      method: 'draft',
    },
  ];

  return definitions.map(({ method, ...definition }) => ({
    ...definition,
    execute: (callId: string, parameters: Record<string, unknown>, signal?: AbortSignal) =>
      invoke(method, callId, parameters, signal),
  }));
}

export default function registerSessionTools(pi: {
  registerTool(tool: ReturnType<typeof sessionTools>[number]): void;
}): void {
  const endpoint = process.env.COMPANION_SESSION_TOOLS_ENDPOINT;
  const token = process.env.COMPANION_SESSION_TOOLS_TOKEN;
  if (endpoint && token) {
    for (const tool of sessionTools(endpoint, token)) {
      pi.registerTool(tool);
    }
  }
}
