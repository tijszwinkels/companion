/**
 * The conversation's model in the bar above the chat, next to its state:
 * a button naming the model its next turn uses, which opens the desktop
 * footer's picker (integrations/panel/ModelPicker.qml) below the bar. The
 * rules are in ./model-choice.ts.
 *
 * Requests are the phone panel's (integrations/mobile/src/components/
 * Conversation.tsx): the Store's `loadModels` / `loadClaudeModels` read the
 * listener's catalogues (`agent-models`, `claude-models`) into the Store,
 * and a choice is `set-agent-model` for this conversation. The listener's
 * answer is the conversation's next update; nothing is changed here before.
 *
 * Keyboard: the button opens and closes the picker (Enter, Space); in the
 * picker Tab moves between its controls, the model list is a native select
 * (arrow keys), Escape closes it and focus returns to the button. A click
 * outside closes it too. The picker belongs to one conversation lifetime:
 * Workspace.tsx keys it by ID and tool epoch, so another conversation
 * starts closed and without the previous one's notice.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { AgentSession } from '../../../../src/agents/types.ts';
import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import { modelChoice } from './model-choice.ts';

/** The picker's element ID, for the button's aria-controls. */
export const modelPickerId = 'model-picker';

export function ModelPicker(props: { session: AgentSession; admitted: boolean }) {
  const store = useStore();
  const state = useAppState();
  const { session, admitted } = props;

  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [changing, setChanging] = useState(false);
  const [refusal, setRefusal] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Whether this picker is still drawn, for answers that arrive later.
  const mounted = useRef(true);
  // Whether the picker is open now (not as of the render a request started
  // in), so a refusal that arrives after it was closed is still seen.
  const openNow = useRef(open);
  openNow.current = open;

  const choice = modelChoice(session, state, { admitted, changing, showAll });

  // Read the catalogue when the reader opens the picker (and it was not read
  // yet), not for every conversation shown: until then the bar names the
  // conversation's own choice or the model of its last turn. A failed read
  // is repeated only by the picker's ↻.
  useEffect(() => {
    if (!open || !admitted || choice.loaded || choice.loading) {
      return;
    }
    if (choice.claude && !state.claudeModelsError) {
      void store.loadClaudeModels();
    } else if (!choice.claude && !state.modelsError) {
      void store.loadModels();
    }
  }, [open, admitted, choice.claude]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A click outside the button and the picker closes it, and Escape closes
  // it wherever the focus is (also when a control that had it became
  // unavailable and the browser moved focus to the page itself).
  useEffect(() => {
    if (!open) {
      return;
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      closeToButton();
    };
    const pointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (panel.current?.contains(target) || button.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('keydown', keyDown);
    };
  }, [open]);

  function toggle() {
    setOpen(!open);
    setRefusal('');
  }

  function closeToButton() {
    setOpen(false);
    button.current?.focus();
  }

  function refresh() {
    if (choice.claude) {
      void store.loadClaudeModels();
    } else {
      void store.loadModels();
    }
  }

  async function choose(model: string) {
    if (changing || !choice.enabled || model === choice.selected) {
      return;
    }
    setChanging(true);
    setRefusal('');
    // The pairing this change was asked in (its device credential): an
    // answer after sign-out or a new pairing belongs to no one shown now.
    const credential = store.connection.token;
    try {
      await store.request('set-agent-model', { id: session.id, model: model }, { quiet: true });
    } catch (failure) {
      if (store.connection.token !== credential) {
        return;
      }
      let message = String(failure);
      if (failure instanceof Error) {
        message = failure.message;
      }
      if (mounted.current && openNow.current) {
        setRefusal(message);
      } else {
        // The picker was closed or the reader moved on: still say that the
        // change did not happen.
        store.toast(message, 'error');
      }
    } finally {
      if (mounted.current) {
        setChanging(false);
      }
    }
  }

  let buttonText = choice.current || 'Model';
  let buttonLabel = `Model: ${buttonText}. Change the model of this conversation's next turn`;
  if (choice.usesDefault && choice.current) {
    buttonLabel = `Model: ${choice.current}, the profile default. Change the model of this conversation's next turn`;
  }

  return (
    <span
      class="model-control"
      onFocusOut={(event) => {
        // Keyboard focus moved on to another control of the page (Tab past
        // the picker's last control): the picker closes, so it never stays
        // open where Escape can no longer reach it. Focus leaving the
        // window (no next element) keeps it open.
        const next = event.relatedTarget as Node | null;
        if (open && next && !event.currentTarget.contains(next)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={button}
        class="model-button"
        aria-label={buttonLabel}
        aria-expanded={open}
        aria-controls={open ? modelPickerId : undefined}
        title={buttonLabel}
        onClick={toggle}
      >
        {/* The part that tells the model apart (model-choice.ts
            `closedModelName`); the full name is the button's title and
            accessible name. Too narrow, the lead shortens first. */}
        <span class="model-name">
          {choice.current ? (
            <>
              {choice.closedName.lead && <span class="model-lead">{choice.closedName.lead}</span>}
              <span class="model-distinct">{choice.closedName.distinct}</span>
            </>
          ) : (
            <span class="model-distinct">{buttonText}</span>
          )}
        </span>
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div
          ref={panel}
          id={modelPickerId}
          class="model-panel"
          role="group"
          aria-label="Model for this conversation's next turn"
        >
          <label class="model-caption" for="model-select">
            {choice.caption}
          </label>
          <select
            id="model-select"
            class="model-select"
            value={choice.selected}
            // While a change is on its way the list keeps keyboard focus
            // (a disabled control would lose it) and only says it is
            // unavailable; choose() takes nothing meanwhile.
            disabled={!choice.enabled && !changing}
            aria-disabled={changing ? 'true' : undefined}
            onChange={(event) => {
              const select = event.currentTarget;
              const model = select.value;
              // The conversation's state decides what is shown: the
              // listener's answer (or the next update) moves it.
              select.value = choice.selected;
              void choose(model);
            }}
          >
            {choice.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {choice.note && <p class="model-note">{choice.note}</p>}
          <div class="model-actions">
            {choice.showAllLabel && (
              <button class="bar-button" onClick={() => setShowAll(!showAll)}>
                {choice.showAllLabel}
              </button>
            )}
            <button
              class="bar-button"
              aria-label={
                choice.claude ? 'Refresh available Claude models' : 'Refresh available Pi models'
              }
              title="Refresh the list of models"
              disabled={!admitted || choice.loading}
              onClick={refresh}
            >
              ↻
            </button>
            <span class="model-status" role="status">
              {changing ? 'Changing the model…' : choice.status}
            </span>
          </div>
          {!admitted && (
            <p class="model-status">Not connected: the model can be changed once connected.</p>
          )}
          {refusal && (
            <p class="model-refusal" role="alert">
              {refusal}
            </p>
          )}
        </div>
      )}
    </span>
  );
}
