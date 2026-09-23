/**
 * Loaded only by the offline model-discovery process, never by a conversation.
 * Pi resolves its global enabledModels, globs and effort suffixes itself.
 * Emit just its scoped identifiers; no tools, prompts or settings writes.
 */
import { writeSync } from 'node:fs';

export default function modelPinsExtension(pi: {
  on(
    event: 'session_start',
    handler: (
      event: unknown,
      context: {
        scopedModels: readonly { model: { provider: string; id: string } }[];
      },
    ) => void,
  ): void;
}): void {
  pi.on('session_start', (_event, context) => {
    // Pi redirects extension stdout to stderr in RPC mode. A separate inherited
    // pipe keeps this bounded metadata distinct from both RPC and diagnostic logs.
    writeSync(
      3,
      JSON.stringify({
        type: 'companion-model-pins',
        pinned: context.scopedModels.map(({ model }) => `${model.provider}/${model.id}`),
      }) + '\n',
    );
  });
}
