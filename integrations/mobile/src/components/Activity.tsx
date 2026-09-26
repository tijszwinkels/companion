/**
 * The Activity page, in the desktop panel's order (integrations/panel/
 * ActivityView and IntentControls): a text box at the top, then collapsible
 * Listening, Voice shortcuts, Intentions and History sections.
 *
 * Phone difference: the desktop's "Type an utterance" sends text to the
 * focused desktop application, which a phone cannot target. Here the same
 * box starts a conversation instead (text only, no screenshot). "Insert"
 * on history cards is desktop-only for the same reason.
 */

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

import type { ActivityEntry, IntentState } from '../../../../src/remote/protocol.ts';
import { clockTime, copyText, intentLabel } from '../format.ts';
import { useAppState, useStore } from '../hooks.ts';
import type { AppState } from '../store.ts';
import { MicIcon, MicOffIcon } from './icons.tsx';

/** Listening title/description with the desktop StatusView's wording. */
export function listeningStatus(state: AppState): {
  title: string;
  description: string;
  tone: '' | 'paused' | 'offline';
} {
  const engine = state.engine;
  if (state.connection.status !== 'online' || !engine?.ready) {
    return {
      title: 'Not running',
      description: 'Companion will reconnect when it starts.',
      tone: 'offline',
    };
  }
  if (engine.paused) {
    return engine.pauseReason === 'media'
      ? {
          title: 'Paused for media',
          description: 'Listening resumes when playback stops.',
          tone: 'paused',
        }
      : { title: 'Paused', description: 'Microphone capture is paused.', tone: 'paused' };
  }
  return { title: 'Listening', description: '', tone: '' };
}

export function ActivityPage() {
  const state = useAppState();
  const engine = state.engine;
  const online = state.connection.status === 'online';
  const intents = engine?.intents ?? [];

  const labels = new Map(intents.map((intent) => [intent.name, intent.label]));
  const entries = [...state.activity.entries.values()].sort(
    (left, right) => right.sequence - left.sequence,
  );

  return (
    <div class="page">
      <div class="scroll">
        <AskBox />
        <Section title="Listening">
          <Listening />
        </Section>
        <VoiceShortcuts intents={intents} />
        <Intentions intents={intents} online={online} />
        <Section title="History" detail={String(entries.length)}>
          <History entries={entries} labels={labels} intents={intents} />
        </Section>
        <div style={{ height: '16px' }} />
      </div>
    </div>
  );
}

/** Collapsible section heading, like the desktop CollapsibleSection. */
function Section(props: { title: string; detail?: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(true);
  return (
    <section class="section">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{props.title}</span>
        <span class="detail">{props.detail}</span>
        <span class="caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && <div class="section-body">{props.children}</div>}
    </section>
  );
}

/**
 * A typed question from the phone. It has no screenshot of the computer and
 * opens in the background on the desktop panel.
 */
function AskBox() {
  const store = useStore();
  const state = useAppState();
  const text = store.draft('new');
  const [profile, setProfile] = useState<'coding' | 'quickQuestion'>('coding');
  const busy = state.sends.get('new')?.pending ?? false;
  const error = state.sends.get('new')?.error ?? '';
  const online = state.connection.status === 'online';
  const available = state.engine?.sessionControlsAvailable !== false;

  async function start() {
    await store.sendDraft('new', profile);
  }

  return (
    <div class="ask">
      <h2>Start a conversation</h2>
      <label class="visually-hidden" for="ask-text">
        Message for a new conversation
      </label>
      <textarea
        id="ask-text"
        value={text}
        maxLength={4000}
        placeholder="Ask Companion…"
        onInput={(event) => {
          store.setDraft('new', event.currentTarget.value);
        }}
      />
      <div class="row">
        <div class="segmented" role="group" aria-label="Conversation type">
          <button aria-pressed={profile === 'coding'} onClick={() => setProfile('coding')}>
            Coding
          </button>
          <button
            aria-pressed={profile === 'quickQuestion'}
            onClick={() => setProfile('quickQuestion')}
          >
            Quick question
          </button>
        </div>
        <button
          class="action primary"
          onClick={start}
          disabled={!online || !available || busy || !text.trim()}
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
      {error ? (
        <div class="input-error" role="alert">
          {error}
        </div>
      ) : (
        <p class="hint">
          {!online ? 'Disconnected · draft kept' : 'No screenshot is attached from the phone.'}
        </p>
      )}
    </div>
  );
}

function Listening() {
  const state = useAppState();
  const store = useStore();
  const engine = state.engine;
  const status = listeningStatus(state);
  const paused = !engine || engine.paused;
  const online = state.connection.status === 'online';

  const detail =
    status.description ||
    (engine && engine.processing > 0 ? `Processing ${engine.processing}…` : 'Ready for speech');

  return (
    <div class="listening">
      <button
        class={`mic ${paused ? 'paused' : ''} ${engine?.speaking ? 'speaking' : ''}`}
        disabled={!online || !engine?.ready}
        aria-label={paused ? 'Resume listening' : 'Pause listening'}
        aria-pressed={!paused}
        onClick={() => void store.request('toggle-pause', {}).catch(() => {})}
      >
        {paused ? <MicOffIcon size={24} /> : <MicIcon size={24} />}
      </button>
      <div aria-live="polite">
        <div class="state">{status.title}</div>
        <div class="description">
          {detail}
          {engine?.preview ? ' · preview mode' : ''}
        </div>
      </div>
    </div>
  );
}

/** Enabled spoken prefixes, as chips (desktop "Voice shortcuts"). */
function VoiceShortcuts(props: { intents: IntentState[] }) {
  const state = useAppState();
  const engine = state.engine;
  const active = state.connection.status === 'online' && engine?.ready && !engine.paused;

  const shortcuts = props.intents.flatMap((intent) =>
    intent.shortcutEnabled && intent.prefixAvailable !== false
      ? (intent.prefixes ?? []).map((prefix) => ({
          prefix,
          label: intent.label,
          standalone: intent.acceptsEmptyPrefix === true,
        }))
      : [],
  );

  const hint = !active
    ? engine?.paused
      ? 'Resume listening to use voice shortcuts.'
      : 'Connect Companion to use voice shortcuts.'
    : shortcuts.length
      ? 'Say a shortcut; add your text where shown by …'
      : 'No voice shortcuts are enabled in this context.';

  return (
    <Section title="Voice shortcuts" detail={String(shortcuts.length)}>
      <div class={`voice-chips ${active ? '' : 'inactive'}`}>
        {shortcuts.map((shortcut) => (
          <span
            key={shortcut.prefix}
            class="voice-chip"
            aria-label={`${shortcut.prefix}: ${shortcut.label}`}
          >
            {shortcut.prefix}
            {shortcut.standalone ? '' : ' …'}
          </span>
        ))}
      </div>
      <p class="hint">{hint}</p>
    </Section>
  );
}

/**
 * One card per route, like the desktop: accent "Intent" cards and amber
 * "Shortcut" cards, each toggled separately with a tap.
 */
function Intentions(props: { intents: IntentState[]; online: boolean }) {
  const store = useStore();
  const [busy, setBusy] = useState('');

  // Older listeners without independent switches cannot be toggled safely.
  const independent = props.intents.every((intent) => intent.inferenceEnabled !== undefined);

  const routes = props.intents.flatMap((intent) => {
    const list: { intent: IntentState; mode: 'inference' | 'shortcut' }[] = [];
    if (intent.supportsInference) {
      list.push({ intent, mode: 'inference' });
    }
    if ((intent.prefixes?.length ?? 0) > 0) {
      list.push({ intent, mode: 'shortcut' });
    }
    return list;
  });

  async function toggle(intent: IntentState, mode: 'inference' | 'shortcut', enabled: boolean) {
    setBusy(`${intent.name}:${mode}`);
    try {
      await store.request('set-intent-enabled', { name: intent.name, mode, enabled });
    } catch {
      // Toast shown by the store; the card keeps the engine's state.
    } finally {
      setBusy('');
    }
  }

  return (
    <Section title="Intentions" detail="Intent / Shortcut · tap separately">
      {!independent && (
        <p class="hint">Restart Companion to load independent intent and shortcut controls.</p>
      )}
      <div class="route-grid">
        {routes.map(({ intent, mode }) => {
          const inference = mode === 'inference';
          const enabled = inference ? intent.inferenceEnabled : intent.shortcutEnabled;
          const available = inference ? intent.inferenceAvailable : intent.prefixAvailable;
          const active = enabled === true && available !== false;
          const stateText = !enabled
            ? 'Off'
            : available === false
              ? 'Needs conversation context'
              : !intent.toggleable
                ? 'Always on'
                : 'On';
          const locked =
            !intent.toggleable ||
            !props.online ||
            !independent ||
            busy === `${intent.name}:${mode}`;

          return (
            <button
              key={`${intent.name}:${mode}`}
              class={`route ${inference ? '' : 'shortcut'} ${active ? 'active' : ''}`}
              role="switch"
              aria-checked={enabled === true}
              aria-label={`${intent.label} ${inference ? 'intent' : 'shortcut'}: ${stateText}`}
              disabled={locked}
              onClick={() => void toggle(intent, mode, !enabled)}
            >
              <span class="dot" aria-hidden="true" />
              <span>
                <div class="name">{intent.label}</div>
                <div class="mode">
                  {inference ? 'Intent' : 'Shortcut'} · {stateText}
                </div>
                {!inference && (
                  <div class="prefixes">
                    {(intent.prefixes ?? []).map((prefix) => (
                      <span key={prefix}>
                        {prefix}
                        {intent.acceptsEmptyPrefix ? '' : ' …'}
                      </span>
                    ))}
                  </div>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

function History(props: {
  entries: ActivityEntry[];
  labels: Map<string, string>;
  intents: IntentState[];
}) {
  const state = useAppState();
  const store = useStore();
  const online = state.connection.status === 'online';

  return (
    <>
      {state.activity.error && (
        <div class="input-error" role="alert">
          {state.activity.error}{' '}
          <button class="action small" onClick={() => store.retryActivity()}>
            Retry
          </button>
        </div>
      )}
      {props.entries.length === 0 && !state.activity.syncing && (
        <div class="empty">What you say to Companion on the computer appears here.</div>
      )}
      {props.entries.map((entry) => (
        <HistoryCard
          key={entry.id}
          entry={entry}
          labels={props.labels}
          online={online}
          deletable={state.engine?.historyDeletionAvailable === true}
          intents={props.intents}
        />
      ))}
    </>
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
  intents: IntentState[];
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
    <article class="history-card" aria-label={`Utterance at ${clockTime(entry.observedAt)}`}>
      <div class="utterance">{entry.utterance}</div>
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
          class="action small"
          onClick={async () => {
            setCopied(await copyText(entry.utterance));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          class="action small"
          disabled={!props.online || busy}
          onClick={() => act(() => store.request('start-history-agent', { id: entry.id }))}
        >
          New coding session
        </button>
        <button
          class="chip label-correct"
          aria-pressed={feedback === 'correct'}
          disabled={!canLabel}
          onClick={() => {
            setChoosing(false);
            void act(() => store.request('label-history', { id: entry.id, correct: true }));
          }}
        >
          Label correct
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
          Label incorrect
        </button>
        {props.deletable && (
          <button
            class="action small danger"
            disabled={!props.online || busy || entry.outcome === 'processing'}
            aria-label="Delete utterance, screenshot and audio"
            onClick={() => act(() => store.request('delete-history', { id: entry.id }))}
          >
            ×
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
                aria-label={`Correct intent to ${intent.label}`}
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
