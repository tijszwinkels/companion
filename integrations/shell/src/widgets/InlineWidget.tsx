/**
 * Inline widgets in the browser shell's chat (integrations/shell/README.md,
 * "Inline widgets").
 *
 * The shared chat page (`../../../session-apps/chat/Chat.tsx`) draws a
 * widget message with the host's `inlineWidget` component when the host has
 * one (`NativeBridge.inlineWidget`, chat/protocol.ts). The shell's bridge
 * carries the component made here; the Qt host has none.
 *
 * The bridge's rows then carry `widget.frameUrl` (rows.ts), which makes the
 * page use this component. For one widget row it draws, at the width of a
 * message:
 * - with a frame address (`widget.frameUrl`, frame-address.ts): a rounded
 *   panel with the widget's name and its page in a sandboxed iframe on the
 *   gateway's frame origin, in one of the states of frame-state.ts, greyed
 *   while the shell is not connected;
 * - with '' (no frame origin configured): a small "not set up" card.
 *
 * Resources: each panel owns one `message` listener on this window, one
 * IntersectionObserver, one visibility listener, one load deadline timer and
 * one height throttle. All are released when the panel is removed (another
 * conversation shown, the widget removed from its message, a new frame
 * address) or its frame is replaced (Try again).
 */

import type { ComponentType } from 'preact';
import { useSyncExternalStore } from 'preact/compat';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'preact/hooks';

import type { InlineWidgetProps } from '../../../session-apps/chat/protocol.ts';
import type { ChatCover } from './chat-cover.ts';
import { frameAddress, frameOriginOf } from './frame-address.ts';
import {
  readFrameMessage,
  themeFromVariables,
  themeMessage,
  visibleMessage,
} from './frame-messages.ts';
import { initialFrameState, loadDeadlineMilliseconds, nextFrameState } from './frame-state.ts';
import { watchTranscript } from './frame-scroll.ts';
import { frameVisible } from './frame-visibility.ts';
import { HeightThrottle, type ThrottleTimers } from './height-throttle.ts';

/** What the panels need from the rest of the page (made in main.tsx). */
export interface InlineWidgetEnvironment {
  /** Requests are admitted: connected, and this connection's snapshot arrived. */
  connected(): boolean;
  /** Told after every change that may change `connected` (each Store change). */
  subscribe(listener: () => void): () => void;
  /** Whether the settings screen or the Activity overlay covers the chat. */
  cover: ChatCover;
}

/**
 * The frame is granted no feature, and these are denied explicitly (the
 * same list as host.js's inner frame, plus fullscreen and autoplay);
 * features not named keep the browser's default for a frame of another
 * origin. The gateway's own Permissions-Policy denies camera, microphone
 * and geolocation to the whole page as well.
 */
const noPermissions =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'; serial 'none'; bluetooth 'none'; display-capture 'none'; fullscreen 'none'; autoplay 'none'";

/**
 * Heights last shown for each frame address in this page, so a conversation
 * shown again draws its frames at their last height while they load again.
 * Memory only, at most 100 addresses (the oldest is forgotten first).
 */
const rememberedHeights = new Map<string, number>();
const maximumRememberedHeights = 100;

function rememberHeight(address: string, height: number): void {
  rememberedHeights.delete(address);
  rememberedHeights.set(address, height);
  if (rememberedHeights.size > maximumRememberedHeights) {
    const oldest = rememberedHeights.keys().next().value;
    if (oldest !== undefined) {
      rememberedHeights.delete(oldest);
    }
  }
}

/** Why a frame the page's own policy refused could not load, and what helps. */
const policyRefusal =
  'This page was opened before widgets were set up for it. Reload the page to show them.';

const pageTimers: ThrottleTimers = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/** The component the shell's bridge offers the chat page as `inlineWidget`. */
export function createInlineWidget(
  environment: InlineWidgetEnvironment,
): ComponentType<InlineWidgetProps> {
  function InlineWidget(props: InlineWidgetProps) {
    const widget = props.row.widget;
    if (!widget) {
      return null;
    }

    // The message's time (`row.time`, while the Message timestamps switch
    // is on) is shown at the right of the panel's header, as on messages.
    const time = props.row.time ?? '';
    const address = frameAddress(widget.frameUrl);
    if (!address) {
      return <NotSetUp name={widget.name} time={time} />;
    }

    // A new address (after a reconnect that ended the old handles) is a new
    // panel: the old frame and everything it owns go, the new one loads.
    return (
      <WidgetFrame
        key={address}
        name={widget.name}
        time={time}
        address={address}
        environment={environment}
      />
    );
  }
  return InlineWidget;
}

/** No frame origin is configured on the gateway: the widget's name only. */
function NotSetUp(props: { name: string; time: string }) {
  return (
    <div class="panel inline-widget" data-phase="not-set-up">
      <WidgetHeader name={props.name} time={props.time} />
      <p class="inline-widget-note">
        Widgets are not set up for this browser, so only the widget's name is shown.
      </p>
    </div>
  );
}

function WidgetHeader(props: { name: string; time: string }) {
  return (
    <div class="inline-widget-header">
      <span aria-hidden="true">🧩</span>
      <span class="inline-widget-name">{props.name}</span>
      {props.time ? <span class="message-time">{props.time}</span> : null}
    </div>
  );
}

function WidgetFrame(props: {
  name: string;
  time: string;
  address: string;
  environment: InlineWidgetEnvironment;
}) {
  const { name, time, address, environment } = props;
  const origin = frameOriginOf(address);

  const [state, dispatch] = useReducer(nextFrameState, undefined, () =>
    initialFrameState(rememberedHeights.get(address)),
  );

  // The inputs of the visibility rule (frame-visibility.ts).
  const connected = useSyncExternalStore(environment.subscribe, environment.connected);
  const cover = environment.cover;
  const subscribeToCover = useCallback(
    (listener: () => void) => cover.subscribe(listener),
    [cover],
  );
  const covered = useSyncExternalStore(subscribeToCover, () => cover.covered);
  const pageHidden = usePageHidden();
  const [inView, setInView] = useState(false);
  const visible = frameVisible({ inView, pageHidden, covered, connected });

  const panel = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);

  // The frame element: a new one for each attempt (Try again), and a new one
  // when a frame that had not been shown yet comes back after the shell was
  // disconnected. While disconnected a frame that was never shown is not in
  // the page at all, so nothing starts loading (or half-loads) before
  // requests are admitted again.
  const [generation, setGeneration] = useState(0);
  const frameKey = state.attempt + ':' + generation;
  const frameInPage = connected || state.phase === 'shown';
  useEffect(() => {
    if (!connected && state.phase === 'loading') {
      setGeneration((value) => value + 1);
    }
  }, [connected, state.phase]);

  // Whether the current frame element has loaded, and what it was last told
  // about its visibility. Messages go to a frame only after its load event:
  // before that its window still holds the initial empty document, and the
  // target origin would not match anyway.
  const [loadedKey, setLoadedKey] = useState('');
  const loaded = loadedKey === frameKey && frameInPage && state.phase !== 'failed';
  const toldVisible = useRef<boolean | null>(null);
  const visibleNow = useRef(visible);
  visibleNow.current = visible;

  // In view: the panel intersects the window after the transcript's own
  // scrolling clipped it.
  useEffect(() => {
    const element = panel.current;
    if (!element) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        setInView(entry.isIntersecting);
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Scrolling the transcript with the pointer over a frame counts as the
  // reader's scroll (frame-scroll.ts), while this panel has a frame.
  useEffect(() => {
    const transcript = panel.current?.closest('.transcript');
    if (!transcript) {
      return;
    }
    return watchTranscript(transcript);
  }, []);

  // Messages from this panel's frame only (frame-messages.ts checks the
  // source window, the origin and every field). Heights go through the
  // throttle; the listener and the throttle belong to one frame element, so
  // a replaced frame's late messages and waiting heights are dropped. A
  // layout effect: it is installed in the same task that puts the frame into
  // the page, before the frame can run a script and report.
  const frameShown = state.phase !== 'failed';
  useLayoutEffect(() => {
    if (!frameShown) {
      return;
    }
    const throttle = new HeightThrottle((height) => {
      dispatch({ type: 'geometry', height: height });
    }, pageTimers);

    function onMessage(event: MessageEvent) {
      const frameWindow = iframe.current?.contentWindow ?? null;
      const message = readFrameMessage(event, { frameWindow, frameOrigin: origin });
      if (!message) {
        return;
      }
      if (message.type === 'geometry') {
        throttle.report(message.height);
      } else {
        dispatch(message);
      }
    }

    // The page refused to frame the address: its policy (from the gateway,
    // when the page was loaded) has no `frame-src` for this frame origin,
    // because the frame origin was set up or changed after the page loaded.
    function onPolicyViolation(event: SecurityPolicyViolationEvent) {
      if (event.effectiveDirective === 'frame-src' && event.blockedURI.startsWith(origin)) {
        dispatch({ type: 'error', text: policyRefusal });
      }
    }

    window.addEventListener('message', onMessage);
    document.addEventListener('securitypolicyviolation', onPolicyViolation);
    return () => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('securitypolicyviolation', onPolicyViolation);
      throttle.dispose();
    };
  }, [frameShown, frameKey, origin]);

  // A loading frame has ten seconds to report its first height, counted
  // only while it is visible: a frame out of view, in a hidden tab, under
  // the settings screen or while the shell reconnects may not be drawn by
  // the browser at all, so it cannot report. Each visible period starts the
  // full deadline again.
  useEffect(() => {
    if (state.phase !== 'loading' || !visible) {
      return;
    }
    const timer = window.setTimeout(() => {
      dispatch({ type: 'deadline' });
    }, loadDeadlineMilliseconds);
    return () => {
      window.clearTimeout(timer);
    };
  }, [state.phase, state.attempt, visible]);

  // The last height shown is remembered for this address (see above).
  useEffect(() => {
    if (state.phase === 'shown') {
      rememberHeight(address, state.height);
    }
  }, [state.phase, state.height, address]);

  // Tell the loaded frame when its visibility changes.
  useEffect(() => {
    if (!loaded) {
      return;
    }
    const target = iframe.current?.contentWindow;
    if (!target || toldVisible.current === visible) {
      return;
    }
    target.postMessage(visibleMessage(visible), origin);
    toldVisible.current = visible;
  }, [loaded, visible, origin]);

  /**
   * Each load of the frame (also a page that reloads itself) is a new
   * document: it gets the theme and its current visibility, nothing else.
   */
  function onFrameLoad(event: Event) {
    const element = event.currentTarget as HTMLIFrameElement;
    const target = element.contentWindow;
    if (!target) {
      return;
    }
    const styles = getComputedStyle(element);
    const theme = themeFromVariables((name) => styles.getPropertyValue(name));
    target.postMessage(themeMessage(theme), origin);
    target.postMessage(visibleMessage(visibleNow.current), origin);
    toldVisible.current = visibleNow.current;
    setLoadedKey(frameKey);
  }

  if (state.phase === 'failed') {
    return (
      <div ref={panel} class="panel inline-widget" data-phase="failed" data-visible="false">
        <WidgetHeader name={name} time={time} />
        <div class="inline-widget-failed">
          <p>
            <strong>The {name} widget could not load.</strong> {state.reason}
          </p>
          <p class="inline-widget-note">
            The conversation and the widget's saved data are unchanged.
          </p>
          <div>
            {/* A new frame needs requests admitted, as its first load does. */}
            <button
              class="panel-action small"
              disabled={!connected}
              onClick={() => dispatch({ type: 'retry' })}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  let panelClass = 'panel inline-widget';
  if (!connected) {
    panelClass += ' disconnected';
  }

  return (
    <div
      ref={panel}
      class={panelClass}
      data-phase={state.phase}
      data-visible={String(visible)}
      data-connected={String(connected)}
    >
      <WidgetHeader name={name} time={time} />
      <div class="inline-widget-body">
        {/* While disconnected the frame takes no input (it is paused). Only
            the frame is inert: the labels below stay readable. */}
        <div class="inline-widget-frame" inert={!connected}>
          {/* The sandbox and the other attributes come before the address,
              and all are set before the frame is put into the page. */}
          {frameInPage ? (
            <iframe
              key={frameKey}
              ref={iframe}
              title={`${name} widget`}
              sandbox="allow-scripts allow-same-origin allow-forms"
              allow={noPermissions}
              referrerpolicy="no-referrer"
              loading="lazy"
              src={address}
              style={{ height: `${state.height}px` }}
              onLoad={onFrameLoad}
            />
          ) : (
            <div class="inline-widget-placeholder" style={{ height: `${state.height}px` }} />
          )}
        </div>
        {state.phase === 'loading' && connected && (
          <div class="inline-widget-cover" role="status">
            Loading the {name} widget…
          </div>
        )}
        {!connected && (
          <div class="inline-widget-cover offline" role="status">
            <span>Disconnected · reconnecting…</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Whether this browser tab is hidden, following `visibilitychange`. */
function usePageHidden(): boolean {
  return useSyncExternalStore(subscribeToPageVisibility, () => document.hidden);
}

function subscribeToPageVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => {
    document.removeEventListener('visibilitychange', listener);
  };
}
