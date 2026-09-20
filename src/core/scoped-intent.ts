import type { IntentContext, UserSensorFrame } from './frame.ts';

/** Ephemeral routes captured per utterance, without mutating permanent intents. */
export interface ScopedIntent {
  readonly name: string;
  readonly instruction?: string;
  readonly exactUtterance?: string;
  process(frame: UserSensorFrame, signal: AbortSignal): Promise<void>;
}

export type ScopedIntentSource = (
  context: IntentContext,
  reservedPrefixes: readonly string[],
) => readonly ScopedIntent[];
