import { Type } from '@earendil-works/pi-ai';

import { parseChoices } from './choices.ts';

export const choiceToolName = 'companion_choices';

/**
 * Native Pi tool; results travel on the owning process's existing RPC stream.
 * The Claude Code bridge reuses the same description, guideline and result text.
 *
 * The wording deliberately asks for the choices first and the answer as
 * visible text afterwards. Claude models told to answer before the call often
 * wrote that answer only in their thinking, which the user never sees, and
 * then ended the turn with a one-line pointer to the choices.
 */
export const choiceTool = {
  name: choiceToolName,
  label: 'Offer choices',
  promptSnippet:
    'Offer optional choices above the Companion conversation input, with clickable and spoken labels.',
  promptGuidelines: [
    'Use companion_choices when asking the user to choose among a few answers or next steps; always allow a freeform reply. Offer the choices first, then write your complete answer as visible text and finish your turn.',
  ],
  description:
    'Offer up to 8 optional next steps or answers above this Companion conversation’s input. ' +
    'Call with options such as ["[Tests] - Run the tests", "Yes", "No"], or objects with label and optional description. ' +
    'The label is an exact voice shortcut; selecting submits the description, or the label if no description. ' +
    'Each call replaces the previous choices; [] clears them. Freeform replies remain available. ' +
    'The user can select after your turn finishes, so offer the choices first and then write your complete answer as visible text. ' +
    'Do not wait or poll for a selection. Avoid the reserved label "stop" and permanent voice commands.',
  parameters: Type.Object({
    options: Type.Array(
      Type.Union([
        Type.String({ maxLength: 1065 }),
        Type.Object({
          label: Type.String({ minLength: 1, maxLength: 60 }),
          description: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
      ]),
      { maxItems: 8 },
    ),
  }),
  async execute(_id: string, parameters: { options: unknown }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const options = parseChoices(parameters.options);
    return {
      content: [
        {
          type: 'text' as const,
          text: options.length
            ? 'Choices offered. Now write your complete answer as visible text, unless you already wrote it as visible text earlier in this turn: the user never sees your thinking. The user can select a choice or reply freely.'
            : 'Choices cleared.',
        },
      ],
      details: { companionChoices: { version: 1, options } },
    };
  },
};

// This narrow structural API keeps Companion independent of Pi's CLI package.
// Pi loads the module with --extension and supplies its native ExtensionAPI.
export default function registerChoices(pi: { registerTool(tool: typeof choiceTool): void }): void {
  pi.registerTool(choiceTool);
}
