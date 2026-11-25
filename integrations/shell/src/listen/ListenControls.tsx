/**
 * What the page shows of Listen here (listen-here.ts), as in the agreed
 * mock-up:
 *
 * - `ListenMark`: the always-visible mark in the bar above the chat (and in
 *   Activity's header) while Listen here is on: red with a level meter while
 *   the microphone is open, struck through while it waits (paused, not
 *   connected). Pressing it in the bar shows the Activity column. Hidden
 *   while Listen here is off or the browser still asks for permission
 *   (nothing is captured then).
 * - `MicrophoneRows`: Activity's listening block below Pause: one row with
 *   a switch for the computer's microphone (`set-computer-microphone`, the
 *   design's D8), one with the Listen here switch for this browser, one per
 *   other browser that listens now, and a notice that explains the state
 *   (permission, refused, moved, no sound, no microphone on).
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { MicIcon, MicOffIcon } from '../../../chat-ui/icons.tsx';
import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import type { ActivityRequests } from '../activity/requests.ts';
import type { GatewayChatBridge } from '../bridge.ts';
import type { MicrophonesState } from '../../../../src/remote/protocol.ts';
import { quietNotice, type ListenHere, type ListenView } from './listen-here.ts';

/** The Activity requests key of the computer's switch. */
const computerSwitchKey = 'computer-microphone';

/** Listen here's view, drawn again whenever it changes. */
export function useListenView(listenHere: ListenHere): ListenView {
  const [view, setView] = useState(listenHere.view);
  useEffect(() => {
    const unsubscribe = listenHere.subscribe(() => setView(listenHere.view));
    // It can change between the first render and this subscription.
    setView(listenHere.view);
    return unsubscribe;
  }, [listenHere]);
  return view;
}

/**
 * Four bars whose heights follow the microphone's level. Subscribed on its
 * own, so ten level changes a second redraw only the meter.
 */
export function LevelMeter(props: { listenHere: ListenHere }) {
  const [level, setLevel] = useState(props.listenHere.currentLevel);
  useEffect(() => {
    const listenHere = props.listenHere;
    const unsubscribe = listenHere.subscribeLevel(() => setLevel(listenHere.currentLevel));
    setLevel(listenHere.currentLevel);
    return unsubscribe;
  }, [props.listenHere]);

  // Each bar responds to a louder level than the one before it, so quiet
  // sound moves the first bar and speech moves all four.
  const bars = [0.02, 0.08, 0.2, 0.4].map((threshold, index) => {
    const height = Math.min(1, level / threshold);
    return <i key={index} style={{ height: `${3 + Math.round(height * 10)}px` }} />;
  });
  return (
    <span class="level-meter" aria-hidden="true" data-level={level.toFixed(3)}>
      {bars}
    </span>
  );
}

/**
 * The mark while Listen here is on. In the bar above the chat it is a
 * button that shows Activity (`onShowActivity`). In Activity's header,
 * which covers the bar where Activity lies over the chat, it is the same
 * mark without a button.
 */
export function ListenMark(props: { listenHere: ListenHere; onShowActivity?: () => void }) {
  const view = useListenView(props.listenHere);

  let classes = '';
  let label = '';
  let content: ComponentChildren = null;
  if (view.phase === 'listening') {
    // Red from the browser's grant on; "starting" until the stream is open,
    // so nobody speaks into a stream that is not there yet.
    const starting = view.streamId === '';
    classes = starting ? 'listen-mark on starting' : 'listen-mark on';
    label = starting ? 'This browser is starting to listen' : 'This browser is listening';
    content = (
      <>
        <MicIcon size={16} />
        <LevelMeter listenHere={props.listenHere} />
        <span class="listen-mark-text">{starting ? 'starting…' : 'listening here'}</span>
      </>
    );
  } else if (view.phase === 'waiting') {
    let text = 'paused';
    label = 'Listen here: paused; this browser listens again on Resume';
    if (view.waitingFor === 'connection') {
      text = 'not connected';
      label = 'Listen here: not connected; this browser listens again once it is connected';
    } else if (view.waitingFor === 'companion') {
      text = 'waiting';
      label = 'Listen here: waiting; this browser listens again once Companion is ready';
    } else if (view.waitingFor === 'not-available') {
      text = 'not available';
      label =
        'Listen here: not available right now; this browser listens again once Companion allows it';
    }
    classes = 'listen-mark waiting';
    if (view.waitingFor === 'not-available') {
      // Its reason stays written also in Activity's compact header: the
      // crossed-out microphone alone would read as Pause.
      classes = 'listen-mark waiting not-available';
    }
    content = (
      <>
        <MicOffIcon size={16} />
        <span class="listen-mark-text">{text}</span>
      </>
    );
  } else {
    return null;
  }

  if (!props.onShowActivity) {
    return (
      <span class={classes} role="img" aria-label={label} title={label}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      class={classes}
      title={`${label}. Show Activity`}
      aria-label={`${label}. Show Activity`}
      onClick={props.onShowActivity}
    >
      {content}
    </button>
  );
}

/** Activity's microphone rows: the computer, this browser, other browsers. */
export function MicrophoneRows(props: {
  listenHere: ListenHere;
  bridge: GatewayChatBridge;
  requests: ActivityRequests;
}) {
  const store = useStore();
  const state = useAppState();
  const view = useListenView(props.listenHere);
  const engine = state.engine;
  const microphones = engine?.microphones;
  const admitted = props.bridge.admitted;
  const running = admitted && engine?.ready === true;
  const paused = engine?.paused === true;

  // The computer's switch (D8): only where the listener has microphones,
  // and not when the computer has none of its own (no desktop).
  let computerRow = null;
  if (microphones && microphones.computerAvailable !== false) {
    const pending = props.requests.isPending(computerSwitchKey);
    let status = 'Off';
    if (microphones.computer && paused) {
      status = 'Paused with everything else';
    } else if (microphones.computer) {
      const listed = microphones.listening.some((microphone) => microphone.kind === 'computer');
      status = listed ? 'Listening' : 'On, not listening at the moment';
    }
    computerRow = (
      <MicrophoneRow
        id="microphone-computer"
        title="Computer"
        name="Computer's microphone"
        status={status}
        checked={microphones.computer}
        available={admitted && !pending}
        onPress={() => {
          // Checked again at the press: the state may have changed.
          const current = store.state.engine?.microphones;
          if (!props.bridge.admitted || !current) {
            return;
          }
          void props.requests.run(computerSwitchKey, () =>
            store.request('set-computer-microphone', { enabled: !current.computer }),
          );
        }}
      />
    );
  }

  // Other browsers that listen now (not this page's own stream). Only from
  // this connection's state: the last one before a disconnect may still list
  // this page's own former stream.
  let others: MicrophonesState['listening'] = [];
  if (admitted) {
    others = (microphones?.listening ?? []).filter(
      (microphone) => microphone.kind === 'browser' && microphone.id !== view.streamId,
    );
  }
  const quiet = quietNotice({
    running,
    paused,
    microphones,
    listeningHere: view.phase === 'listening',
  });

  // A notice below the rows, as in the mock-up.
  let notice = null;
  if (view.phase === 'asking') {
    notice = (
      <p class="listen-notice">
        Your browser asks for the microphone. Sound from this browser goes to Companion on your
        computer and is handled as speech there.
      </p>
    );
  } else if (view.phase === 'off' && view.problem) {
    notice = <ProblemNotice view={view} />;
  } else if (quiet === 'none-on') {
    notice = (
      <p class="listen-notice warn">
        <b>No microphone is on.</b> Companion hears nothing until one is switched on.
      </p>
    );
  } else if (quiet === 'none-listening') {
    notice = (
      <p class="listen-notice">
        <b>No microphone is listening right now.</b> The computer's microphone is on and listens
        again by itself.
      </p>
    );
  }

  return (
    <div class="microphone-rows">
      {computerRow}
      <ThisBrowserRow listenHere={props.listenHere} view={view} admitted={admitted} />
      {others.map((microphone) => (
        <div class="microphone-row" key={microphone.id}>
          <div class="microphone-text">
            <span class="microphone-title">{microphone.name}</span>
            <span class="microphone-status">Listening</span>
          </div>
        </div>
      ))}
      {notice}
    </div>
  );
}

/** This browser's row: the Listen here switch and what it is doing. */
function ThisBrowserRow(props: { listenHere: ListenHere; view: ListenView; admitted: boolean }) {
  const view = props.view;

  if (view.phase === 'unavailable') {
    return (
      <div class="microphone-row this-browser" data-listen={view.phase}>
        <div class="microphone-text">
          <span class="microphone-title">This browser</span>
          <span class="microphone-status">{view.unavailable}</span>
        </div>
      </div>
    );
  }

  let status: ComponentChildren = 'Off';
  if (view.phase === 'off' && view.problem) {
    status = view.problem.message;
  } else if (view.phase === 'asking') {
    status = 'Waiting for the browser’s permission…';
  } else if (view.phase === 'listening') {
    let word = 'Listening';
    if (view.streamId === '') {
      word = 'Starting…';
    }
    status = (
      <>
        {word} <LevelMeter listenHere={props.listenHere} />
      </>
    );
  } else if (view.phase === 'waiting') {
    status = 'Paused with everything else';
    if (view.waitingFor === 'connection') {
      status = 'Waiting for the connection to Companion';
    } else if (view.waitingFor === 'companion') {
      status = 'Waiting for Companion';
    } else if (view.waitingFor === 'not-available') {
      status = 'Listening here is not available right now';
    }
  }

  const on = view.phase !== 'off';
  const classes = ['microphone-row', 'this-browser'];
  if (view.phase === 'listening') {
    classes.push('mine');
  }

  return (
    <>
      <MicrophoneRow
        id="microphone-this-browser"
        className={classes.join(' ')}
        phase={view.phase}
        title="This browser"
        name="Listen here"
        status={status}
        checked={on}
        // Off is always possible; on only while requests are admitted.
        available={on || props.admitted}
        onPress={() => props.listenHere.setWanted(!on)}
      />
      {view.notice && <p class="listen-notice warn">{view.notice}</p>}
    </>
  );
}

/** Why the page switched Listen here off, with what to do. */
function ProblemNotice(props: { view: ListenView }) {
  const problem = props.view.problem!;
  if (problem.kind === 'refused') {
    return (
      <p class="listen-notice bad">
        <b>Microphone not allowed.</b> Allow it for this site with the icon in the address bar, then
        switch Listen here on again. If it is allowed there, Companion’s gateway does not permit it
        (it needs <code>--allow-microphone</code>).
      </p>
    );
  }
  if (problem.kind === 'moved') {
    return (
      <p class="listen-notice warn">
        <b>Listening moved to another tab of this browser.</b> Switch on here to take it back.
      </p>
    );
  }
  if (problem.kind === 'lost') {
    return (
      <p class="listen-notice warn">
        <b>No sound from this browser.</b> Listen here was switched off. Switch it on to resume.
      </p>
    );
  }
  if (problem.kind === 'no-microphone') {
    return (
      <p class="listen-notice bad">
        <b>No microphone found.</b> Connect one, then switch Listen here on again.
      </p>
    );
  }
  return (
    <p class="listen-notice bad">
      <b>Listen here stopped.</b> {problem.message}. Switch it on to try again.
    </p>
  );
}

/** One microphone with its switch; the whole row presses the switch. */
function MicrophoneRow(props: {
  id: string;
  className?: string;
  phase?: string;
  title: string;
  name: string;
  status: ComponentChildren;
  checked: boolean;
  available: boolean;
  onPress: () => void;
}) {
  const statusId = `${props.id}-status`;

  function press() {
    if (props.available) {
      props.onPress();
    }
  }

  return (
    <div class={props.className ?? 'microphone-row'} data-listen={props.phase} onClick={press}>
      <div class="microphone-text">
        <span class="microphone-title">{props.title}</span>
        <span class="microphone-status" id={statusId}>
          {props.status}
        </span>
      </div>
      <button
        type="button"
        id={props.id}
        class="setting-switch"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.name}
        aria-describedby={statusId}
        aria-disabled={props.available ? undefined : 'true'}
        onClick={(event) => {
          // The row's handler presses it once.
          event.stopPropagation();
          press();
        }}
      />
    </div>
  );
}
