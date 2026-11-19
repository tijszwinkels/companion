/**
 * Companion's trusted HTML session rail (dist/rail.html).
 *
 * Lists the open conversations in their shared order and lets the person
 * select, pop out, focus, return or close them. The native view
 * (TrustedRailView.qml) sends the whole list on every change (at most 16
 * conversations) and performs each request through the panel's existing
 * signals. Activity, Previous sessions, reordering and settings stay in the
 * native rail around this page.
 */

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { connectChannel } from '../web-channel.ts';
import './styles.css';

interface RailSession {
  id: string;
  number: number;
  title: string;
  selected: boolean;
  running: boolean;
  unread: boolean;
  poppedOut: boolean;
  wakes: number;
}

interface RailState {
  seq: number;
  sessions: RailSession[];
  online: boolean;
  popoutAvailable: boolean;
  theme: {
    foreground: string;
    accent: string;
    muted: string;
    selection: string;
    fontFamily: string;
    unit: number;
  };
}

interface RailBridge {
  message: { connect(callback: (json: string) => void): void };
  ready(): void;
  select(id: string): void;
  popOut(id: string): void;
  returnToPanel(id: string): void;
  close(id: string): void;
}

function Rail(props: {
  bridge: RailBridge;
  initial: RailState | null;
  subscribe: (set: (state: RailState) => void) => void;
}) {
  const [state, setState] = useState<RailState | null>(props.initial);

  useEffect(() => {
    props.subscribe(setState);
  }, []);

  if (!state) {
    return null;
  }

  const theme = state.theme;
  const style = {
    '--foreground': theme.foreground,
    '--accent': theme.accent,
    '--muted': theme.muted,
    '--selection': theme.selection,
    '--font': theme.fontFamily,
    '--unit': String(theme.unit || 1),
  };

  return (
    <nav class="rail" style={style} aria-label="Conversations">
      {state.sessions.map((session) => {
        const { glyph, caption, emoji } = badgeOf(session);
        return (
          <div
            key={session.id}
            class={`session ${session.selected ? 'selected' : ''} ${session.unread ? 'unread' : ''}`}
            role="tab"
            aria-selected={session.selected}
            title={
              session.poppedOut
                ? `${session.title}\nIn its own window · click to focus it`
                : session.title
            }
            onClick={() => props.bridge.select(session.id)}
          >
            <div class="badge">
              {session.running && <span class="running" aria-label="Answering" />}
              <span class={`glyph ${emoji ? 'emoji' : ''}`}>{glyph}</span>
              {emoji && <span class="number">{session.number}</span>}
              {session.poppedOut && (
                <span class="popped" aria-label="In its own window">
                  ↗
                </span>
              )}
              {session.unread && <span class="unread-dot" aria-label="Unread" />}
            </div>
            {session.wakes > 0 && <div class="wakes">◷{session.wakes}</div>}
            <div class="title">{caption}</div>
            {/* Shown on hover or keyboard focus, like the classic tab's close
                button; the tab itself looks like the classic tab otherwise. */}
            <div class="actions" onClick={(event) => event.stopPropagation()}>
              {state.popoutAvailable && !session.poppedOut && (
                <button disabled={!state.online} onClick={() => props.bridge.popOut(session.id)}>
                  Pop out
                </button>
              )}
              {session.poppedOut && (
                <button onClick={() => props.bridge.returnToPanel(session.id)}>Return</button>
              )}
              <button
                class="close"
                disabled={!state.online}
                onClick={() => props.bridge.close(session.id)}
                aria-label="Close conversation"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The classic tab's badge: a leading emoji of the title, or "Q" and the
 * session number; the caption is the rest of the title. Mirrors
 * SessionTab.qml (whole emoji token, the same code point ranges).
 */
function badgeOf(session: RailSession): { glyph: string; caption: string; emoji: boolean } {
  const trimmed = session.title.trim();
  const firstToken = trimmed.split(/\s+/)[0] || '';
  const point = firstToken.codePointAt(0) ?? 0;
  const emoji =
    (point >= 0x1f000 && point <= 0x1faff) ||
    (point >= 0x2600 && point <= 0x27bf) ||
    firstToken.includes('️') ||
    firstToken.includes('⃣');
  if (emoji) {
    return { glyph: firstToken, caption: trimmed.slice(firstToken.length).trim(), emoji: true };
  }
  return { glyph: `Q${session.number}`, caption: session.title, emoji: false };
}

const root = document.getElementById('rail')!;

const connected = connectChannel<RailBridge>((bridge) => {
  let latest: RailState | null = null;
  let setter: ((state: RailState) => void) | null = null;

  bridge.message.connect((json) => {
    try {
      latest = JSON.parse(json) as RailState;
    } catch {
      return;
    }
    setter?.(latest);
  });

  render(
    <Rail
      bridge={bridge}
      initial={latest}
      subscribe={(set) => {
        setter = set;
        if (latest) {
          set(latest);
        }
      }}
    />,
    root,
  );
  bridge.ready();
  // The native view's liveness signal (TrustedRailView.qml).
  (window as unknown as { companionRail: { connected: boolean } }).companionRail = {
    connected: true,
  };
});

if (!connected) {
  root.textContent = 'This page only runs inside Companion.';
}
