import { Type } from '@earendil-works/pi-ai';

import { parseChoices } from './choices.ts';

export const choiceToolName = 'companion_choices';

/** Native Pi tool; results travel on the owning process's existing RPC stream. */
export const choiceTool = {
  name: choiceToolName,
  label: 'Offer choices',
  description:
    'Offer up to 8 optional next steps or answers above this Companion conversation’s input. ' +
    'Call with options such as ["[Tests] - Run the tests", "Yes", "No"], or objects with label and optional description. ' +
    'The label is an exact voice shortcut; selecting submits the description, or the label if no description. ' +
    'Each call replaces the previous choices; [] clears them. Freeform replies remain available. ' +
    'The user can select after your turn finishes, so finish your answer after offering choices. ' +
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
            ? 'Choices offered. Finish your answer; the user can select a choice or reply freely.'
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
