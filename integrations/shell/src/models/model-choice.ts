/**
 * What the model picker in the bar above the chat shows and offers for one
 * conversation, by the desktop footer's rules (integrations/panel/
 * ModelPicker.qml) and the listener's (src/agents/sessions.ts `setModel`):
 *
 * - A Pi conversation offers "Use <profile> default · <model>" (clears its
 *   own choice) and the listener's Pi models: the pinned ones, or all of
 *   them after Show all models. A choice the catalogue no longer lists is
 *   still shown, marked "(unavailable)".
 * - A Claude Code conversation offers the listener's Claude models (the
 *   configured default marked). Its current model is always shown, even
 *   when the list does not have it. Its effort stays as it started.
 * - The choice applies to the conversation's next turn, also while a turn
 *   runs: the listener accepts it then, so the picker does too. It is
 *   offered while requests are admitted and no change of this picker is on
 *   its way, once the list has loaded (a loaded list stays usable while it
 *   is read again) or failed to load (then the profile default, or a
 *   Claude conversation's own model, can still be chosen, as on the
 *   desktop).
 * - The listener decides every change; a refusal is shown in its words and
 *   the picker returns to the conversation's model. A model chosen
 *   elsewhere appears here with the conversation's next update.
 *
 * Input: the conversation, the phone Store's two catalogues and their
 * loading state, and this picker's own state. Output: `ModelChoice`, pure
 * data the component draws.
 */

import type { AgentSession, ClaudeCodeModelCatalog } from '../../../../src/agents/types.ts';
import type { ModelCatalog } from '../../../../src/remote/protocol.ts';

/** The Store's catalogues (integrations/mobile/src/store.ts `AppState`). */
export interface ModelCatalogs {
  models?: ModelCatalog;
  modelsError: string;
  modelsLoading: boolean;
  claudeModels?: ClaudeCodeModelCatalog;
  claudeModelsError: string;
  claudeModelsLoading: boolean;
}

/** This picker's own state. */
export interface PickerState {
  /** Requests are admitted (connected, the connection's snapshot arrived). */
  admitted: boolean;
  /** A change made with this picker awaits the listener's answer. */
  changing: boolean;
  /** Pi: all models are listed, not only the pinned ones. */
  showAll: boolean;
}

export interface ModelOption {
  label: string;
  value: string;
}

export interface ModelChoice {
  /** Which catalogue applies. */
  claude: boolean;
  /** The model the next turn uses, for the bar ('' when not known yet). */
  current: string;
  /** Whether `current` is the profile's default (Pi, no own choice). */
  usesDefault: boolean;
  /** "This session · next turn model" (Pi) or "… Claude model". */
  caption: string;
  options: ModelOption[];
  /** The option that is the conversation's choice now. */
  selected: string;
  /** Whether a choice may be made now. */
  enabled: boolean;
  /** Pi: whether Show all models / Pinned models only is offered, and its label. */
  showAllLabel: string;
  /** Claude: the fixed effort and what a change keeps; '' for Pi. */
  note: string;
  /** Loading, the catalogue's failure or its warning; '' for none. */
  status: string;
  /** Whether the catalogue has loaded (else the component asks for it). */
  loaded: boolean;
  loading: boolean;
}

/** Whether `session` is a Claude Code conversation. */
export function isClaudeConversation(session: AgentSession): boolean {
  return session.harness === 'claude-code';
}

export function modelChoice(
  session: AgentSession,
  catalogs: ModelCatalogs,
  picker: PickerState,
): ModelChoice {
  if (isClaudeConversation(session)) {
    return claudeChoice(session, catalogs, picker);
  }
  return piChoice(session, catalogs, picker);
}

function piChoice(session: AgentSession, catalogs: ModelCatalogs, picker: PickerState) {
  const catalog = catalogs.models;
  const profile = session.profile === 'quickQuestion' ? 'quickQuestion' : 'coding';
  let defaultModel = '';
  if (catalog) {
    defaultModel = catalog[profile] || '';
  }
  const override = session.modelOverride || '';

  let profileName = 'coding';
  if (profile === 'quickQuestion') {
    profileName = 'quick-question';
  }
  const options: ModelOption[] = [
    { label: `Use ${profileName} default · ${defaultModel || 'profile settings'}`, value: '' },
  ];
  let listed: string[] = [];
  if (catalog) {
    if (picker.showAll || catalog.pinned === undefined) {
      listed = catalog.models;
    } else {
      listed = catalog.pinned;
    }
  }
  for (const model of listed) {
    options.push({ label: model, value: model });
  }
  if (override && !options.some((option) => option.value === override)) {
    let label = override;
    if (catalog && !catalog.models.includes(override)) {
      label += ' (unavailable)';
    }
    options.push({ label: label, value: override });
  }

  // The next turn's model: the conversation's own choice, else the
  // profile's default once known, else the model of its last turn.
  let current = override;
  if (!current) {
    current = defaultModel || session.model || '';
  }

  let showAllLabel = '';
  if (catalog && catalog.pinned !== undefined && catalog.pinned.length < catalog.models.length) {
    showAllLabel = picker.showAll ? 'Pinned models only' : 'Show all models';
  }

  let status = '';
  if (catalogs.modelsLoading) {
    status = 'Loading models…';
  } else if (catalogs.modelsError) {
    status = catalogs.modelsError;
  } else if (catalog && catalog.warning) {
    status = catalog.warning;
  }

  return {
    claude: false,
    current: current,
    usesDefault: override === '',
    caption: 'This session · next turn model',
    options: options,
    selected: override,
    enabled: chooseable(picker, catalog !== undefined, catalogs.modelsError !== ''),
    showAllLabel: showAllLabel,
    note: '',
    status: status,
    loaded: catalog !== undefined,
    loading: catalogs.modelsLoading,
  };
}

function claudeChoice(session: AgentSession, catalogs: ModelCatalogs, picker: PickerState) {
  const catalog = catalogs.claudeModels;
  let model = '';
  if (session.claudeCode) {
    model = session.claudeCode.model;
  }

  const options: ModelOption[] = [];
  const listed = catalog ? catalog.models : [];
  for (const entry of listed) {
    let label = entry;
    if (catalog && entry === catalog.model) {
      label += ' · configured default';
    }
    options.push({ label: label, value: entry });
  }
  // The conversation's own model is always offered, listed or not (for
  // example one started by an agent tool).
  if (model && !listed.includes(model)) {
    options.push({ label: model, value: model });
  }

  let effort = 'unknown';
  if (session.claudeCode && session.claudeCode.effort) {
    effort = session.claudeCode.effort;
  }

  let status = '';
  if (catalogs.claudeModelsLoading) {
    status = 'Loading models…';
  } else if (catalogs.claudeModelsError) {
    status = catalogs.claudeModelsError;
  }

  return {
    claude: true,
    current: model || session.model || '',
    usesDefault: false,
    caption: 'This session · next turn Claude model',
    options: options,
    selected: model,
    enabled: chooseable(picker, catalog !== undefined, catalogs.claudeModelsError !== ''),
    showAllLabel: '',
    note: `Effort · ${effort} · fixed. Same Claude history; effort stays as it started.`,
    status: status,
    loaded: catalog !== undefined,
    loading: catalogs.claudeModelsLoading,
  };
}

/**
 * Whether a choice may be made now: requests admitted, none of this
 * picker's changes on its way, and the list loaded or failed (not still to
 * come). A turn that runs does not matter: the listener applies the choice
 * to the next turn.
 */
function chooseable(picker: PickerState, loaded: boolean, failed: boolean): boolean {
  if (!picker.admitted || picker.changing) {
    return false;
  }
  return loaded || failed;
}
