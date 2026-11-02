/**
 * Pop-out windows reported by the native Companion UI, and the voice target
 * that follows from them.
 *
 * A native UI that can pop conversations out into their own windows adds
 * three fields to its ordinary `panel-state` report (see README "Pop-out
 * windows"): `popoutHost: true`, `rail` and `popouts`. This module validates
 * those fields, gives each report a canonical key so the runtime can tell a
 * real change from a repeated report, and chooses which conversation a spoken
 * follow-up addresses.
 *
 * Inputs are untrusted JSON from a local UI connection. Nothing here keeps
 * state or performs I/O; `DesktopRuntime` owns the per-connection records.
 */

/** Most pop-out windows one report may list. */
export const maximumPopouts = 8;

/** One visible pop-out window of a real open conversation. */
export interface PopoutView {
  id: string;
  /** The window is the focused toplevel, as observed by the native UI. */
  active: boolean;
  /** Its composer has keyboard focus. Only possible in the active window. */
  composerFocused: boolean;
}

/** The pop-out part of one native `panel-state` report. */
export interface NativeViewReport {
  /** Main sidebar layout: full width, or only the compact session rail. */
  rail: 'full' | 'compact';
  popouts: PopoutView[];
}

/** How the voice target was chosen; for logs and tests, never shown to the model. */
export type VoiceTargetSource = 'navigation' | 'popout' | 'panel' | 'popout-only';

export interface VoiceTarget {
  id: string;
  /** Connection whose view supplied the target. */
  clientId: number;
  source: VoiceTargetSource;
}

/** The native view state the runtime holds for one connection. */
export interface NativeViewRecord {
  report: NativeViewReport;
  /** Canonical form of `report`; equal keys mean no semantic change. */
  key: string;
  /** Report order across connections; the newest report wins ties. */
  sequence: number;
}

/**
 * Validate the pop-out fields of a desktop `panel-state` report.
 *
 * Returns undefined for a legacy report that has none of the fields; such a
 * client keeps exactly the old single-view semantics. Throws a user-facing
 * error for any malformed report, before the caller changes any state.
 */
export function parseNativeViewReport(
  request: Record<string, unknown>,
  isOpen: (id: string) => boolean,
): NativeViewReport | undefined {
  const declared = request.popoutHost;
  const hasViews = request.rail !== undefined || request.popouts !== undefined;

  if (declared === undefined || declared === false) {
    if (hasViews) {
      throw Error('Pop-out windows require popoutHost: true');
    }
    return undefined;
  }
  if (declared !== true) {
    throw Error('Expected popoutHost: true');
  }

  if (request.rail !== 'full' && request.rail !== 'compact') {
    throw Error('Expected rail "full" or "compact"');
  }
  if (!Array.isArray(request.popouts) || request.popouts.length > maximumPopouts) {
    throw Error(`Expected at most ${maximumPopouts} pop-out windows`);
  }

  const popouts: PopoutView[] = [];
  const seen = new Set<string>();
  let activeCount = 0;

  for (const value of request.popouts as unknown[]) {
    const popout = parsePopout(value);

    if (seen.has(popout.id)) {
      throw Error('A conversation can have only one pop-out window');
    }
    if (!isOpen(popout.id)) {
      throw Error('A pop-out window must show an open conversation');
    }
    if (popout.active) {
      activeCount++;
    }

    seen.add(popout.id);
    popouts.push(popout);
  }

  if (activeCount > 1) {
    throw Error('At most one pop-out window can be active');
  }

  return { rail: request.rail, popouts };
}

function parsePopout(value: unknown): PopoutView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('Expected pop-out windows as {id, active, composerFocused}');
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  if (
    keys.length !== 3 ||
    typeof record.id !== 'string' ||
    record.id === '' ||
    typeof record.active !== 'boolean' ||
    typeof record.composerFocused !== 'boolean'
  ) {
    throw Error('Expected pop-out windows as {id, active, composerFocused}');
  }
  if (record.composerFocused && !record.active) {
    throw Error('A pop-out composer can be focused only in the active window');
  }

  return { id: record.id, active: record.active, composerFocused: record.composerFocused };
}

/**
 * Canonical key of a report. Window order is not meaningful, so pop-outs are
 * sorted; everything else (rail, membership, activation, composer focus) is.
 */
export function nativeViewKey(report: NativeViewReport): string {
  const popouts = [...report.popouts].sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({ rail: report.rail, popouts });
}

/** The active pop-out window, if any. */
export function activePopout(report: NativeViewReport | undefined): PopoutView | undefined {
  return report?.popouts.find((popout) => popout.active);
}

/**
 * Keyboard-relevant part of a report: which pop-out is active and whether its
 * composer is focused. A change here must stop pending keyboard delivery,
 * exactly like a change of the sidebar composer focus.
 */
export function nativeFocusKey(report: NativeViewReport | undefined): string {
  const active = activePopout(report);
  if (!active) {
    return '';
  }
  return `${active.id}:${active.composerFocused}`;
}

// ---- Explicit voice navigation ------------------------------------------------

/**
 * A conversation the person just chose by voice ("go to session N" or "pop
 * out session N") on one desktop connection. Once that connection shows it
 * as requested (`arrived`), and until something genuinely changes there, it
 * is the voice target, even while another pop-out window keeps keyboard
 * focus: the navigation shows the chosen conversation without taking focus
 * from the window the person was in. Before it arrived, the voice target
 * stays what the connection shows, so routing never runs ahead of the view.
 *
 * It is not sticky. It ends (see `followNavigationSelection`) when that
 * connection's selection, window activation or composer focus changes after
 * the navigation was carried out, when the conversation closes, when the
 * connection disconnects or stops owning navigation, or when a later
 * navigation replaces it. A refused or stale navigation never creates one.
 */
export interface NavigationSelection {
  id: string;
  /** The connection that owned voice navigation and carried it out. */
  clientId: number;
  /** "sidebar": go to session; "window": pop out session. */
  presentation: 'sidebar' | 'window';
  /** The connection showed `id` as requested at or after the navigation. */
  arrived: boolean;
  /** `navigationViewKey` at the navigation, then at its arrival. */
  viewKey: string;
}

/**
 * What one connection shows, as far as a genuine selection or focus change is
 * concerned: its main view's conversation (empty unless it owns the panel
 * selection), the conversation whose composer it has focused, and which
 * pop-out window is active with whether its composer is focused. Transcript
 * updates, draft hosting and similar report fields are not part of it.
 */
export interface ConnectionView {
  mainId: string;
  composerId: string;
  report: NativeViewReport | undefined;
}

export function navigationViewKey(view: ConnectionView): string {
  return JSON.stringify([view.mainId, view.composerId, nativeFocusKey(view.report)]);
}

/** Whether `view` shows `id` the way the navigation asked for. */
function showsAsRequested(selection: NavigationSelection, view: ConnectionView): boolean {
  const popped = view.report?.popouts.some((popout) => popout.id === selection.id) === true;
  if (selection.presentation === 'window') {
    return popped;
  }
  // "Go to session" focuses an existing window instead of selecting a tab.
  return view.mainId === selection.id || popped;
}

/** Start a selection after the navigation request was sent to `clientId`. */
export function startNavigationSelection(
  id: string,
  clientId: number,
  presentation: 'sidebar' | 'window',
  view: ConnectionView,
): NavigationSelection {
  const selection: NavigationSelection = {
    id,
    clientId,
    presentation,
    arrived: false,
    viewKey: navigationViewKey(view),
  };
  // Already shown as requested (for example the sidebar already shows it
  // behind an active pop-out): no report will follow, it has arrived.
  selection.arrived = showsAsRequested(selection, view);
  return selection;
}

/**
 * The selection after the owning connection's view may have changed. Returns
 * the same object while nothing relevant changed, an arrived copy when the
 * view now shows the conversation as requested, or undefined when it ended.
 *
 * Before arrival, an unrelated report with an unchanged view keeps it (the
 * connection has not processed the navigation yet); any other change means
 * the navigation was not carried out as asked or the person moved on. After
 * arrival, any change of the view key is a genuine later focus or selection.
 */
export function followNavigationSelection(
  selection: NavigationSelection,
  view: ConnectionView,
): NavigationSelection | undefined {
  const key = navigationViewKey(view);
  // Arrival first: opening a window that does not take focus changes only
  // the window list, which the view key leaves out.
  if (!selection.arrived && showsAsRequested(selection, view)) {
    return { ...selection, arrived: true, viewKey: key };
  }
  if (key === selection.viewKey) {
    return selection;
  }
  return undefined;
}

/**
 * Choose the conversation a spoken follow-up addresses, in this order:
 *
 * 0. the conversation just chosen by explicit voice navigation, once shown
 *    and while that choice lasts (see `NavigationSelection`);
 * 1. the active pop-out window (the newest report wins if several
 *    connections claim one);
 * 2. the conversation visible in the main sidebar body;
 * 3. when exactly one pop-out window is visible across all connections and
 *    its connection's main sidebar shows only the compact rail, that window
 *    as a weak (unfocused) candidate;
 * 4. no target.
 *
 * Several unfocused pop-outs are never guessed between.
 */
export function chooseVoiceTarget(input: {
  panelSession: string;
  panelClient: number;
  views: ReadonlyMap<number, NativeViewRecord>;
  isOpen: (id: string) => boolean;
  navigation?: NavigationSelection;
}): VoiceTarget | undefined {
  // 0. Explicit voice navigation, once shown.
  if (input.navigation?.arrived && input.isOpen(input.navigation.id)) {
    return { id: input.navigation.id, clientId: input.navigation.clientId, source: 'navigation' };
  }

  // 1. Active pop-out.
  let newestActive: VoiceTarget | undefined;
  let newestSequence = -1;

  for (const [clientId, record] of input.views) {
    const active = activePopout(record.report);
    if (active && input.isOpen(active.id) && record.sequence > newestSequence) {
      newestActive = { id: active.id, clientId, source: 'popout' };
      newestSequence = record.sequence;
    }
  }
  if (newestActive) {
    return newestActive;
  }

  // 2. Visible main conversation.
  if (input.panelSession && input.isOpen(input.panelSession)) {
    return { id: input.panelSession, clientId: input.panelClient, source: 'panel' };
  }

  // 3. The only visible pop-out anywhere, beside a compact rail. Windows of
  // every connection count, whatever their rail: a second visible window
  // elsewhere makes the utterance ambiguous, so there is no candidate at all.
  const visible: VoiceTarget[] = [];
  let compactOwner = false;
  for (const [clientId, record] of input.views) {
    for (const popout of record.report.popouts) {
      if (input.isOpen(popout.id)) {
        visible.push({ id: popout.id, clientId, source: 'popout-only' });
        compactOwner = record.report.rail === 'compact';
      }
    }
  }
  if (visible.length === 1 && compactOwner) {
    return visible[0];
  }

  return undefined;
}
