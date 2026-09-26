/**
 * The session rail, as in the desktop panel (integrations/panel/PanelContent
 * and SessionTab): Activity at the top, open conversations in their
 * authoritative order, Previous sessions at the bottom.
 *
 * Phone differences: the desktop's hover close button and drag reordering
 * become a long-press (or right-click) menu with Close, Move earlier and
 * Move later, using the same close-agent and move-agent requests.
 */

import { useRef, useState } from 'preact/hooks';

import type { AgentSession } from '../../../../src/agents/types.ts';
import { useAppState, useStore } from '../hooks.ts';
import { Sheet } from './Sheet.tsx';

/** How long a press must last to open the tab menu instead of selecting. */
const longPressMilliseconds = 480;

export function Rail() {
  const state = useAppState();
  const store = useStore();
  const [menuFor, setMenuFor] = useState<AgentSession>();
  const engine = state.engine;
  const onActivity = !state.selected && !state.showingPrevious;

  const barsClass = [
    'activity-bars',
    engine?.speaking ? 'speaking' : '',
    !engine || engine.paused ? 'paused' : '',
  ].join(' ');

  const sessions = state.order
    .map((id) => state.sessions.get(id))
    .filter((session): session is AgentSession => Boolean(session));

  return (
    <nav class="rail" aria-label="Pages and conversations">
      <button
        class="rail-button rail-activity"
        aria-current={onActivity ? 'page' : undefined}
        onClick={() => store.showActivity()}
      >
        <span class={barsClass} aria-hidden="true">
          <span style={{ height: '8px' }} />
          <span style={{ height: '20px' }} />
          <span style={{ height: '14px' }} />
        </span>
        Activity
      </button>

      <div class="rail-tabs" role="tablist" aria-label="Open conversations">
        {sessions.map((session, index) => (
          <SessionTab
            key={session.id}
            session={session}
            number={index + 1}
            selected={state.selected === session.id}
            unread={state.unread.has(session.id)}
            online={state.connection.status === 'online'}
            onSelect={() => store.open(session.id)}
            onMenu={() => setMenuFor(session)}
          />
        ))}
      </div>

      <button
        class="rail-button rail-previous"
        aria-current={state.showingPrevious ? 'page' : undefined}
        onClick={() => store.showPrevious()}
      >
        <span class="glyph" aria-hidden="true">
          ◷
        </span>
        Previous sessions
      </button>

      {menuFor && <TabMenu session={menuFor} onClose={() => setMenuFor(undefined)} />}
    </nav>
  );
}

/**
 * Leading emoji becomes the glyph and is removed from the caption; other
 * titles show "Q<number>". Grapheme segmentation keeps flags, skin tones
 * and ZWJ sequences intact.
 */
function tabGlyph(
  title: string,
  number: number,
): { glyph: string; caption: string; emoji: boolean } {
  const trimmed = title.trim();
  const firstToken = trimmed.split(/\s+/)[0] ?? '';
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const first = [...segmenter.segment(firstToken)][0]?.segment ?? '';

  if (first && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(first)) {
    return { glyph: firstToken, caption: trimmed.slice(firstToken.length).trim(), emoji: true };
  }
  return { glyph: `Q${number}`, caption: trimmed, emoji: false };
}

function SessionTab(props: {
  session: AgentSession;
  number: number;
  selected: boolean;
  unread: boolean;
  online: boolean;
  onSelect(): void;
  onMenu(): void;
}) {
  const { session } = props;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const longPressed = useRef(false);
  const { glyph, caption, emoji } = tabGlyph(session.title, props.number);
  const running = session.status === 'running' || session.status === 'starting';

  function pressStart() {
    longPressed.current = false;
    timer.current = setTimeout(() => {
      longPressed.current = true;
      props.onMenu();
    }, longPressMilliseconds);
  }

  function pressEnd() {
    clearTimeout(timer.current);
  }

  const classes = ['rail-button', 'session-tab', props.unread ? 'unread' : ''].join(' ');
  const label = `${props.number}. ${session.title || 'Untitled'}${running ? ', working' : ''}${
    props.unread ? ', new answer' : ''
  }`;

  return (
    <button
      class={classes}
      role="tab"
      aria-selected={props.selected}
      aria-current={props.selected ? 'page' : undefined}
      aria-label={label}
      title={session.title}
      onPointerDown={pressStart}
      onPointerUp={pressEnd}
      onPointerLeave={pressEnd}
      onPointerCancel={pressEnd}
      onContextMenu={(event) => {
        event.preventDefault();
        pressEnd();
        props.onMenu();
      }}
      onClick={() => {
        // A long press already opened the menu; don't also switch tabs.
        if (!longPressed.current) {
          props.onSelect();
        }
      }}
    >
      {emoji && (
        <span class="number" aria-hidden="true">
          {props.number}
        </span>
      )}
      <span class={`badge ${emoji ? 'emoji' : ''}`} aria-hidden="true">
        {running && <span class="ring" style={{ opacity: props.online ? 1 : 0.35 }} />}
        {glyph}
        {props.unread && <span class="unread-dot" />}
      </span>
      <span class="caption" aria-hidden="true">
        {caption}
      </span>
    </button>
  );
}

function TabMenu(props: { session: AgentSession; onClose(): void }) {
  const store = useStore();
  const state = useAppState();
  const { session } = props;
  const index = state.order.indexOf(session.id);
  const online = state.connection.status === 'online';

  async function run(action: () => Promise<unknown>) {
    props.onClose();
    await action().catch(() => {});
  }

  // move-agent inserts before `beforeId`; an empty ID appends at the end.
  function move(offset: -1 | 1) {
    const target = index + offset;
    const beforeId = offset < 0 ? state.order[target] : (state.order[target + 1] ?? '');
    return store.request('move-agent', {
      id: session.id,
      beforeId,
      revision: state.orderRevision,
    });
  }

  return (
    <Sheet title={session.title || 'Conversation'} onClose={props.onClose}>
      <div class="menu-list">
        <button onClick={() => run(() => move(-1))} disabled={!online || index <= 0}>
          Move up
        </button>
        <button
          onClick={() => run(() => move(1))}
          disabled={!online || index < 0 || index >= state.order.length - 1}
        >
          Move down
        </button>
        <button
          class="danger"
          onClick={() => run(() => store.request('close-agent', { id: session.id }))}
          disabled={!online}
        >
          Close session · saved in Previous sessions
        </button>
      </div>
    </Sheet>
  );
}
