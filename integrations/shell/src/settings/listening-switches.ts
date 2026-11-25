/**
 * The Listening section of the settings screen, without DOM access: the
 * listener's own settings that the phone panel offers, shared with the
 * desktop and every other client (the shell README, "Settings").
 *
 * - **Sound feedback** (`soundsEnabled`), changed with `toggle-sounds`.
 * - One switch per **intent** the listener can decide from speech
 *   (`supportsInference`) and one per **shortcut** (an intent with spoken
 *   prefixes), changed with `set-intent-enabled` naming the intent, the
 *   mode and the new value. The order and wording are the phone's
 *   (integrations/mobile/src/components/Activity.tsx, "Intentions").
 *
 * Rule: a switch shows the listener's current value (also a change made
 * elsewhere, which arrives with the next state message) and is
 * **available** only while
 * - requests are admitted (connected, after this connection's snapshot);
 * - no request of the same switch awaits its answer;
 * - for Sound feedback: the listener is not in preview mode;
 * - for intents and shortcuts: the intent is toggleable and the listener
 *   reports independent switches (`inferenceEnabled` and `shortcutEnabled`,
 *   both booleans, on every intent).
 *
 * An older listener does not: it reports per intent only the combined
 * `enabled` that applies to deciding from speech and to its shortcut
 * together (and not `supportsInference`, so which routes an intent has is
 * not known). Each of its intents is shown as one read-only switch with
 * that value, with the phone's note.
 *
 * Nothing is shown as changed before the listener says so.
 */

import type { EngineState } from '../../../../src/remote/protocol.ts';

type Engine = Omit<EngineState, 'sessions' | 'previousSessions'>;
type Intent = Engine['intents'][number];

export type IntentMode = 'inference' | 'shortcut';

export interface ListeningSwitch {
  /** Unique per switch, also its key for pending requests: `sounds` or `intent:<name>:<mode>`. */
  key: string;
  /** `combined`: an older listener's one switch for an intent and its shortcut. */
  kind: 'sounds' | IntentMode | 'combined';
  /** The intent's name (for intents and shortcuts), else ''. */
  intent: string;
  label: string;
  /** The switch's accessible name: the label, and for intents and shortcuts which one. */
  name: string;
  /** One line under the label. */
  description: string;
  /** The listener's value now. */
  checked: boolean;
  /** Whether pressing it asks the listener for the change now. */
  available: boolean;
}

export interface ListeningView {
  switches: ListeningSwitch[];
  /** Short explanations of what cannot be changed now, in order. */
  notes: string[];
}

/** The phone's note for an older listener (Activity.tsx, Intentions). */
export const olderListenerNote =
  'Restart Companion to load independent intent and shortcut controls.';
export const notConnectedNote =
  'Shown as Companion last reported them. They can be changed while connected.';
export const previewNote = 'Preview mode: sound feedback cannot be changed.';
export const noEngineNote = "Companion's listening settings are shown once it is connected.";

/** The key of an intent's or shortcut's switch. */
export function intentSwitchKey(name: string, mode: IntentMode): string {
  return `intent:${name}:${mode}`;
}

/** Whether the listener reports independent intent and shortcut switches. */
export function independentSwitches(intents: readonly Intent[]): boolean {
  return intents.every(
    (intent) =>
      typeof intent.inferenceEnabled === 'boolean' && typeof intent.shortcutEnabled === 'boolean',
  );
}

/** Whether the listener reports both of an intent's own switches. */
function hasModeValues(intent: Intent): boolean {
  return (
    typeof intent.inferenceEnabled === 'boolean' && typeof intent.shortcutEnabled === 'boolean'
  );
}

/** Whether a mode of an intent is on, as the listener reports it. */
function modeEnabled(intent: Intent, mode: IntentMode): boolean {
  if (mode === 'inference') {
    return intent.inferenceEnabled === true;
  }
  return intent.shortcutEnabled === true;
}

/** An older listener's intent: one read-only switch for both routes. */
function combinedSwitch(intent: Intent): ListeningSwitch {
  let state = 'Off';
  if (intent.enabled === true) {
    state = 'On';
    if (!intent.toggleable) {
      state = 'Always on';
    }
  }
  let description = `Intent and shortcut together · ${state}`;
  const prefixes = prefixesText(intent);
  if (prefixes) {
    description += ` · ${prefixes}`;
  }
  return {
    key: `intent:${intent.name}:combined`,
    kind: 'combined',
    intent: intent.name,
    label: intent.label,
    name: intent.label,
    description,
    checked: intent.enabled === true,
    available: false,
  };
}

/**
 * The state words for an intent or shortcut: the shared switch's value.
 *
 * The listener's `inferenceAvailable` and `prefixAvailable` (the phone's
 * "Needs conversation context") describe what the desktop shows now, the
 * context of the computer's microphone. This browser's own speech follows
 * what this tab shows instead (README "Rule: spoken navigation"), so the
 * shell does not show that availability as if it applied here.
 */
function routeState(intent: Intent, mode: IntentMode): string {
  const enabled = modeEnabled(intent, mode);
  if (!enabled) {
    return 'Off';
  }
  if (!intent.toggleable) {
    return 'Always on';
  }
  return 'On';
}

/** A shortcut's spoken prefixes as the phone shows them (`note …`). */
function prefixesText(intent: Intent): string {
  const prefixes = intent.prefixes ?? [];
  const shown: string[] = [];
  for (const prefix of prefixes) {
    if (intent.acceptsEmptyPrefix) {
      shown.push(prefix);
    } else {
      shown.push(`${prefix} …`);
    }
  }
  return shown.join(', ');
}

/**
 * The section's switches and notes for the listener's engine state (or
 * undefined before the first snapshot), whether requests are admitted,
 * and which switch requests await their answer.
 */
export function listeningView(
  engine: Engine | undefined,
  admitted: boolean,
  isPending: (key: string) => boolean,
): ListeningView {
  if (!engine) {
    return { switches: [], notes: [noEngineNote] };
  }

  const notes: string[] = [];
  if (!admitted) {
    notes.push(notConnectedNote);
  }
  if (engine.preview) {
    notes.push(previewNote);
  }
  const intents = engine.intents ?? [];
  const independent = independentSwitches(intents);
  if (!independent) {
    notes.push(olderListenerNote);
  }

  const switches: ListeningSwitch[] = [];
  switches.push({
    key: 'sounds',
    kind: 'sounds',
    intent: '',
    label: 'Sound feedback',
    name: 'Sound feedback',
    description: 'Cues play on the computer.',
    checked: engine.soundsEnabled === true,
    available: admitted && !engine.preview && !isPending('sounds'),
  });

  for (const intent of intents) {
    if (!hasModeValues(intent)) {
      switches.push(combinedSwitch(intent));
      continue;
    }
    const modes: IntentMode[] = [];
    if (intent.supportsInference) {
      modes.push('inference');
    }
    if ((intent.prefixes?.length ?? 0) > 0) {
      modes.push('shortcut');
    }
    for (const mode of modes) {
      const key = intentSwitchKey(intent.name, mode);
      const checked = modeEnabled(intent, mode);
      let description = `Shortcut · ${routeState(intent, mode)} · ${prefixesText(intent)}`;
      let name = `${intent.label} shortcut`;
      if (mode === 'inference') {
        description = `Intent · ${routeState(intent, mode)}`;
        name = `${intent.label} intent`;
      }
      switches.push({
        key,
        kind: mode,
        intent: intent.name,
        label: intent.label,
        name,
        description,
        checked,
        available: admitted && independent && intent.toggleable && !isPending(key),
      });
    }
  }

  return { switches, notes };
}
