/**
 * Listening status and this listener run's history, newest first.
 *
 * Mirrors the desktop Activity panel except for actions that act on the
 * computer's focused window: "Insert" (paste into an application) and typed
 * utterances addressed to a desktop window are desktop-only.
 */

import { useState } from 'preact/hooks';

import type { ActivityEntry } from '../../../../src/remote/protocol.ts';
import { clockTime, copyText, intentLabel } from '../format.ts';
import { useAppState, useStore } from '../hooks.ts';
import { MicIcon, MicOffIcon } from './icons.tsx';

export function Activity() {
  const state = useAppState();
  const store = useStore();
  const engine = state.engine;
  const online = state.connection.status === 'online';

  const labels = new Map((engine?.intents ?? []).map((intent) => [intent.name, intent.label]));
  const entries = [...state.activity.entries.values()].sort(
    (left, right) => right.sequence - left.sequence,
  );

  let stateText = 'Connecting…';
  let detail = '';
  if (engine) {
    if (!engine.ready) {
      stateText = 'Starting up';
    } else if (engine.paused) {
      stateText = 'Paused';
      detail =
        engine.pauseReason === 'media'
          ? 'Media is playing on the computer. Tap to listen anyway.'
          : 'The microphone is off. Tap to listen.';
    } else {
      stateText = engine.speaking ? 'Hearing you' : 'Listening';
      detail = engine.processing > 0 ? `Processing ${engine.processing}…` : 'Ready for speech';
    }
    if (engine.preview) {
      detail += ' · preview mode';
    }
  }

  const paused = engine?.paused ?? true;
  const micClass = `mic ${paused ? 'paused' : ''} ${engine?.speaking ? 'speaking' : ''}`;

  return (
    <div class="screen">
      <header class="topbar">
        <h1>Activity</h1>
      </header>
      <div class="scroll">
        <section class="section">
          <div class="card status-card">
            <button
              class={micClass}
              disabled={!online || !engine?.ready}
              aria-label={paused ? 'Resume listening' : 'Pause listening'}
              aria-pressed={!paused}
              onClick={() => void store.request('toggle-pause', {}).catch(() => {})}
            >
              {paused ? <MicOffIcon size={28} /> : <MicIcon size={28} />}
            </button>
            <div class="text" aria-live="polite">
              <div class="state">{stateText}</div>
              <div class="detail">{detail}</div>
            </div>
          </div>
        </section>

        <section class="section" aria-label="This run's utterances">
          <h2 class="section-title">This run</h2>
          {state.activity.error && (
            <div class="banner error" role="alert">
              {state.activity.error}
              <span class="spacer" />
              <button onClick={() => store.retryActivity()}>Retry</button>
            </div>
          )}
          {entries.length === 0 && !state.activity.syncing && (
            <div class="empty">
              <div class="art" aria-hidden="true">
                🎙️
              </div>
              <h2>Nothing yet</h2>
              <p>What you say to Companion on the computer appears here.</p>
            </div>
          )}
          {entries.map((entry) => (
            <HistoryCard
              key={entry.id}
              entry={entry}
              labels={labels}
              online={online}
              deletable={engine?.historyDeletionAvailable === true}
              intents={(engine?.intents ?? []).map((intent) => ({
                name: intent.name,
                label: intent.label,
              }))}
            />
          ))}
        </section>
        <div style={{ height: '24px' }} />
      </div>
    </div>
  );
}

const outcomeLabels: Record<string, string> = {
  processing: 'Processing',
  delivering: 'Typing',
  sent: 'Typed',
  ignored: 'Ignored',
  started: 'Started a session',
  closed: 'Closed a session',
  labeled: 'Labeled',
  selected: 'Switched session',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  failed: 'Failed',
  preview: 'Preview',
};

function HistoryCard(props: {
  entry: ActivityEntry;
  labels: Map<string, string>;
  intents: { name: string; label: string }[];
  online: boolean;
  deletable: boolean;
}) {
  const store = useStore();
  const { entry } = props;
  const [choosing, setChoosing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch {
      // Toast shown by the store.
    } finally {
      setBusy(false);
    }
  }

  const feedback =
    entry.correct === true ? 'correct' : entry.correct === false ? 'incorrect' : undefined;
  const canLabel = props.online && entry.intent !== null && !busy;

  return (
    <article class="card history-card" aria-label={`Utterance at ${clockTime(entry.observedAt)}`}>
      <div class="utterance">“{entry.utterance}”</div>
      <div class="facts">
        <span>{clockTime(entry.observedAt)}</span>
        {entry.application && <span class="pill">{entry.application}</span>}
        <span class="pill intent">{intentLabel(entry.intent, props.labels)}</span>
        <span class="pill">{outcomeLabels[entry.outcome] ?? entry.outcome}</span>
        {feedback === 'correct' && <span class="pill good">Labeled correct</span>}
        {feedback === 'incorrect' && (
          <span class="pill bad">
            Labeled incorrect
            {entry.actualIntent ? ` → ${intentLabel(entry.actualIntent, props.labels)}` : ''}
          </span>
        )}
      </div>

      <div class="actions">
        <button
          class="button small"
          onClick={async () => {
            setCopied(await copyText(entry.utterance));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          class="button small"
          disabled={!props.online || busy}
          onClick={() => act(() => store.request('start-history-agent', { id: entry.id }))}
        >
          New coding session
        </button>
        <button
          class="chip"
          aria-pressed={feedback === 'correct'}
          disabled={!canLabel}
          onClick={() => {
            setChoosing(false);
            void act(() => store.request('label-history', { id: entry.id, correct: true }));
          }}
        >
          👍 Correct
        </button>
        <button
          class="chip"
          aria-pressed={feedback === 'incorrect'}
          aria-expanded={choosing}
          disabled={!canLabel}
          onClick={() => {
            setChoosing(!choosing);
            if (feedback !== 'incorrect') {
              void act(() => store.request('label-history', { id: entry.id, correct: false }));
            }
          }}
        >
          👎 Incorrect
        </button>
        {props.deletable && (
          <button
            class="button small danger"
            disabled={!props.online || busy || entry.outcome === 'processing'}
            aria-label="Delete utterance, screenshot and audio"
            onClick={() => act(() => store.request('delete-history', { id: entry.id }))}
          >
            Delete
          </button>
        )}
      </div>

      {choosing && (
        <div class="intent-picker">
          <div class="hint">What should it have been?</div>
          <div class="chips">
            {props.intents.map((intent) => (
              <button
                key={intent.name}
                class="chip"
                aria-pressed={entry.actualIntent === intent.name}
                disabled={!canLabel}
                onClick={() => {
                  setChoosing(false);
                  void act(() =>
                    store.request('label-history', {
                      id: entry.id,
                      correct: false,
                      actualIntent: intent.name,
                    }),
                  );
                }}
              >
                {intent.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
