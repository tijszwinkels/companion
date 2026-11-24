/**
 * The paired browser shell's arrangement:
 *
 *   [conversation list] | [bar above the chat               ] | [Activity]
 *    strip or full list | [   chat in a centred column       ] | [column  ]
 *
 * - The conversation list (../list/ConversationList.tsx) and the divider
 *   that changes its width (../layout/Divider.tsx), both hidden by the ☰
 *   button; width and hidden state are remembered in this browser
 *   (../layout/useListLayout.ts).
 * - The main area: the bar (ChatBar.tsx) and, below it, what the Store
 *   selects: a conversation (the unchanged desktop chat page, `Chat`, using
 *   the main area's whole width), Previous sessions, or an empty view when
 *   nothing is selected. Sign out is offered in the bar when no
 *   conversation is shown, as on slice 1's list page.
 * - The settings screen (../settings/SettingsScreen.tsx) in place of what
 *   the Store selects, from the bar's gear or the list's Settings entry,
 *   until the gear is pressed again, the reader chooses a conversation or
 *   Previous sessions in the list, or goes Back or Forward in the browser.
 *   It is this page's own view (../settings/settings-view.ts), not a Store
 *   page: the selection underneath stays (also when it changes meanwhile),
 *   and the list marks Settings. A conversation's chat stays drawn under
 *   it (covered and inert), so going back finds the reader's place.
 * - The Activity column (../activity/ActivityColumn.tsx), hidden at first,
 *   shown and hidden by the ☰ at the bar's right end (the column's own ☰
 *   while shown) and by the list's Activity entry; its width and shown
 *   state are remembered too (../layout/useActivityLayout.ts). In a wide
 *   window it sits beside the chat with its own divider; in a narrow one it
 *   lies over the chat (../layout/activity-width.ts).
 * - The selected conversation's pinned widget (PinnedWidget.tsx), as a band
 *   above the chat or in the right column above Activity, by the window's
 *   shape or the place fixed in this browser (../layout/pinned-place.ts,
 *   ../layout/usePinnedLayout.ts). Not while the settings screen is shown.
 * - The selected conversation's session application, with the chat at its
 *   right or a Chat | application switch, its bar and its permission rows
 *   (../application/ConversationArea.tsx). Which of the two the switch
 *   shows and the rows' state belong to this pairing, as the marker does.
 *
 * The workspace also owns the new-activity marker and the Activity
 * requests on their way; both belong to this pairing and go with it.
 */

import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { AgentSession } from '../../../../src/agents/types.ts';
import { useAppState, useStore } from '../../../mobile/src/hooks.ts';
import type { ChatStore } from '../../../session-apps/chat/store.ts';
import {
  ActivityColumn,
  activityColumnId,
  type StartProfile,
} from '../activity/ActivityColumn.tsx';
import { NewActivity } from '../activity/new-activity.ts';
import { ActivityRequests } from '../activity/requests.ts';
import { areaWidth } from '../application/application-layout.ts';
import { ApplicationModes } from '../application/application-view.ts';
import { ChatPermissions } from '../application/chat-permissions.ts';
import { ConversationArea } from '../application/ConversationArea.tsx';
import {
  useApplicationLayout,
  type ApplicationLayoutView,
} from '../application/useApplicationLayout.ts';
import type { GatewayChatBridge } from '../bridge.ts';
import {
  activityMaximum,
  activityMinimum,
  activityReservedWidth,
  activityWidthFromKey,
  activityWidthFromPointer,
  isNarrowWindow,
  sideColumnWidth,
} from '../layout/activity-width.ts';
import type { ActivityOverlay } from '../layout/activity-overlay.ts';
import { Divider } from '../layout/Divider.tsx';
import { stripWidth, widthFromKey, widthFromPointer } from '../layout/list-width.ts';
import {
  bandPercent,
  pinnedPlace,
  type PinnedPlace,
  type PinnedPlacePreference,
} from '../layout/pinned-place.ts';
import { useActivityLayout } from '../layout/useActivityLayout.ts';
import { useListLayout } from '../layout/useListLayout.ts';
import { usePinnedLayout } from '../layout/usePinnedLayout.ts';
import { ConversationList, conversationListId } from '../list/ConversationList.tsx';
import type { ListenHere } from '../listen/listen-here.ts';
import { ListenMark } from '../listen/ListenControls.tsx';
import { ModelPicker } from '../models/ModelPicker.tsx';
import { SettingsScreen } from '../settings/SettingsScreen.tsx';
import { useDisplaySettings } from '../settings/useDisplaySettings.ts';
import type { SettingsView } from '../settings/settings-view.ts';
import type { PageTimes } from '../times/page-times.ts';
import type { ChatCover } from '../widgets/chat-cover.ts';
import type { InlineWidgetEnvironment } from '../widgets/InlineWidget.tsx';
import { pinnedWidget } from '../widgets/pinned-widget.ts';
import { BarState } from './BarState.tsx';
import { ChatBar } from './ChatBar.tsx';
import { PinnedWidgetPanel, pinnedWidgetId } from './PinnedWidget.tsx';
import { PreviousSessions } from './PreviousSessions.tsx';

/** The Activity parts of the bar: whether the column is shown, the marker, the ☰. */
interface ActivityBar {
  shown: boolean;
  newActivity: number;
  onShow: () => void;
  button: RefObject<HTMLButtonElement>;
  onFocusLost: () => void;
}

/** What the main area passes on to a conversation's application (ConversationArea.tsx). */
interface ApplicationContext {
  widgets: InlineWidgetEnvironment;
  windowWidth: number;
  areaWidth: number;
  modes: ApplicationModes;
  permissions: ChatPermissions;
  layout: ApplicationLayoutView;
}

/** The settings screen's part of the bar: whether it is shown, and the gear. */
interface SettingsBar {
  shown: boolean;
  onToggle: () => void;
}

export function Workspace(props: {
  chat: ChatStore;
  bridge: GatewayChatBridge;
  times: PageTimes;
  settingsView: SettingsView;
  activityOverlay: ActivityOverlay;
  chatCover: ChatCover;
  widgets: InlineWidgetEnvironment;
  listenHere: ListenHere;
}) {
  const store = useStore();
  const state = useAppState();
  const display = useDisplaySettings(props.times.settings);

  // The settings screen, shown in place of the chat (drawn again when it is
  // shown or left). Browser Back and Forward leave it too (main.tsx).
  const settingsView = props.settingsView;
  const [settingsShown, setSettingsShownState] = useState(settingsView.shown);
  useEffect(() => {
    const unsubscribe = settingsView.subscribe(() => {
      setSettingsShownState(settingsView.shown);
    });
    // It can change between the first render and this subscription.
    setSettingsShownState(settingsView.shown);
    return unsubscribe;
  }, [settingsView]);

  let selected: AgentSession | undefined;
  if (state.selected) {
    selected = state.sessions.get(state.selected);
  }

  // The selected conversation's pinned widget, if the browser can show it
  // (../widgets/pinned-widget.ts). The settings screen takes its place.
  let pinned = null;
  if (selected && !settingsShown) {
    pinned = pinnedWidget(selected);
  }
  const pinnedLayout = usePinnedLayout();

  const activity = useActivityLayout();
  const windowWidth = activity.windowWidth;
  const overlay = isNarrowWindow(windowWidth);

  /**
   * Where the pinned widget sits for the list's shown state and preferred
   * width, beside the Activity column when that is shown. The window's
   * width and height both come from the pinned layout's one listener
   * (../layout/usePinnedLayout.ts), never one new and the other old.
   */
  function placeFor(listShown: boolean, listPreference: number): PinnedPlace {
    const placeWidth = pinnedLayout.windowWidth;
    return pinnedPlace({
      windowWidth: placeWidth,
      windowHeight: pinnedLayout.windowHeight,
      listShown,
      listPreference,
      activityReserved: activityReservedWidth(
        activity.preference,
        activity.shown,
        placeWidth,
        listShown,
      ),
      preference: pinnedLayout.preference,
    });
  }

  // The right column holds Activity, the pinned widget at the right, or
  // both. In a wide window it takes its width from the list's window first
  // (activity-width.ts); the list's own rules apply to the rest.
  const layout = useListLayout((listShown, listPreference) => {
    const pinnedRight = pinned !== null && placeFor(listShown, listPreference) === 'right';
    return activityReservedWidth(
      activity.preference,
      activity.shown || pinnedRight,
      windowWidth,
      listShown,
    );
  });
  const columnWidth = sideColumnWidth(activity.preference, windowWidth, layout.shown);
  const place = placeFor(layout.shown, layout.preference);
  const pinnedRight = pinned !== null && place === 'right';
  const sideShown = activity.shown || pinnedRight;

  // One marker and one set of pending requests per pairing: the workspace
  // is replaced on sign-out. The marker follows every render (each Store
  // change and each change of the column's shown state); `observe` is
  // idempotent, so observing during rendering is safe.
  const marker = useRef(new NewActivity());
  marker.current.observe(state, activity.shown);
  const newActivity = marker.current.count;
  const [requests] = useState(() => new ActivityRequests());
  // Confirmations of entries that left the history are not kept.
  requests.forgetConfirmations(state.activity.entries);
  // Which of chat and application the switch layout shows, per
  // conversation, and the application permission rows' state: both belong
  // to this pairing (../application/).
  const [applicationModes] = useState(() => new ApplicationModes());
  const [chatPermissions] = useState(() => new ChatPermissions());
  const applicationLayout = useApplicationLayout();
  // No conversation shown (Previous sessions, nothing selected): the rows'
  // reviews and a waiting change belong to none, as on the desktop. The
  // conversation's own area observes it while one is shown.
  if (!selected) {
    chatPermissions.observe('', '');
  }

  // The kind of conversation Start asks for, kept while the column is
  // hidden (its text is the Store's draft, kept too).
  const [startProfile, setStartProfile] = useState<StartProfile>('coding');

  // A request's start or end changes what the entries offer without a Store
  // change: re-render then. Subscribed here, for the whole pairing, rather
  // than in the column, which may mount while a request is on its way and
  // would miss an answer that arrives before its own subscription.
  const [, setRequestsVersion] = useState(0);
  useEffect(() => {
    return requests.subscribe(() => {
      setRequestsVersion((version) => version + 1);
    });
  }, [requests]);

  // Keyboard focus follows the ☰ that was pressed: showing the column from
  // the bar moves focus to the column's ☰, hiding it from there back to the
  // bar's (which reappears). The list's Activity entry keeps its focus.
  const barActivityButton = useRef<HTMLButtonElement>(null);
  const columnActivityButton = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef<'bar' | 'column' | ''>('');
  // A layout effect after every drawing: focus moves in the same frame the
  // buttons change, so the reader's next key press already reaches the new
  // button. The request is used once; one that names a ☰ that is not drawn
  // now is dropped, never kept for a later toggle.
  useLayoutEffect(() => {
    const target = focusAfterToggle.current;
    focusAfterToggle.current = '';
    if (target === 'column' && activity.shown) {
      columnActivityButton.current?.focus();
    }
    if (target === 'bar' && !activity.shown) {
      barActivityButton.current?.focus();
    }
  });

  /**
   * The focused ☰ went away without being pressed (another tab showed or
   * hid the column): focus moves to the ☰ that replaces it, as if pressed.
   */
  function barButtonLostFocus() {
    focusAfterToggle.current = 'column';
  }

  /** Focus was inside the column when another tab hid it: to the bar's ☰. */
  function columnLostFocus() {
    focusAfterToggle.current = 'bar';
  }

  // Whether the column is shown in the latest drawing. The divider's
  // hand-off below runs with the callback of the divider's own last drawing,
  // which predates the change that removed it, so it reads this instead.
  const activityShownNow = useRef(activity.shown);
  activityShownNow.current = activity.shown;

  /**
   * Focus was on the Activity divider when it went away: the window became
   * narrow (the column now lies over the chat: to its ☰) or another tab hid
   * the column (to the bar's ☰).
   */
  function activityDividerLostFocus() {
    if (activityShownNow.current) {
      focusAfterToggle.current = 'column';
    } else {
      focusAfterToggle.current = 'bar';
    }
  }

  // In a narrow window the shown column covers the chat: the chat is inert
  // then (no focus, no input, hidden from assistive technology), so the
  // keyboard cannot reach controls the reader cannot see. If the focus was
  // in the chat when the column came over it (a resize, another tab showing
  // it, the list's Activity entry keeps its own focus), it moves to the
  // column's ☰.
  const chatCovered = activity.shown && overlay;

  // The page's record of the same (layout/activity-overlay.ts), which the
  // Store reads for its `visible` report: set after each drawing that
  // changes it, and cleared when the workspace goes (sign-out).
  const activityOverlay = props.activityOverlay;
  useLayoutEffect(() => {
    activityOverlay.setCoversChat(chatCovered);
  }, [activityOverlay, chatCovered]);
  useEffect(() => {
    return () => activityOverlay.setCoversChat(false);
  }, [activityOverlay]);

  const mainArea = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!chatCovered) {
      return;
    }
    const focused = document.activeElement;
    if (focused && mainArea.current?.contains(focused)) {
      columnActivityButton.current?.focus();
    }
  }, [chatCovered]);

  // Inline widget frames count as not visible while this page's own
  // screens cover the chat: the settings screen, or the Activity column
  // over it in a narrow window (../widgets/frame-visibility.ts).
  const chatCover = props.chatCover;
  useLayoutEffect(() => {
    chatCover.setCovered(settingsShown || chatCovered);
  }, [chatCover, settingsShown, chatCovered]);

  function showFromBar() {
    focusAfterToggle.current = 'column';
    activity.setShown(true);
  }

  function hideFromColumn() {
    focusAfterToggle.current = 'bar';
    activity.setShown(false);
  }

  /**
   * The list's Settings entry. In a narrow window the shown Activity column
   * covers the main area, where the settings screen is drawn: it is hidden
   * (as its ☰ would), so the settings screen can be seen and reached.
   */
  function showSettingsFromList() {
    settingsView.setShown(true);
    if (activity.shown && overlay) {
      activity.setShown(false);
    }
  }

  /**
   * The gear: shows the settings screen, or leaves it. Leaving shows the
   * conversation underneath again, which counts as choosing it: the page
   * reports it as shown, so the listener clears its unread mark (an answer
   * completed behind the settings screen), and with an older listener the
   * Store's own mark is cleared (`Store.open` of the shown page changes no
   * browser history).
   */
  function toggleSettingsFromBar() {
    if (!settingsView.shown) {
      settingsView.setShown(true);
      return;
    }
    settingsView.setShown(false);
    if (state.selected && !state.showingPrevious) {
      store.open(state.selected);
    }
  }

  // A place button of the pinned widget pressed: its panel is drawn anew,
  // elsewhere or without that button, and the focus it had would fall to
  // the page. It goes to a place button of the new header instead (the way
  // back), else its first control, once, right after that drawing.
  const focusPinnedControls = useRef(false);
  function placePinned(preference: PinnedPlacePreference) {
    focusPinnedControls.current = true;
    pinnedLayout.setPreference(preference);
  }
  useLayoutEffect(() => {
    if (!focusPinnedControls.current) {
      return;
    }
    focusPinnedControls.current = false;
    const focused = document.activeElement;
    if (focused && focused !== document.body) {
      return;
    }
    const actions = `#${pinnedWidgetId} .inline-widget-actions`;
    const target =
      document.querySelector<HTMLElement>(`${actions} [data-place]`) ??
      document.querySelector<HTMLElement>(`${actions} button`);
    target?.focus();
  });

  let pinnedPanel = null;
  if (pinned) {
    pinnedPanel = (
      <PinnedWidgetPanel
        pinned={pinned}
        place={place}
        preference={pinnedLayout.preference}
        windowWidth={windowWidth}
        onPlace={placePinned}
        percent={bandPercent(pinnedLayout.heightPercent, pinned.heightPercent)}
        onPercent={pinnedLayout.setHeight}
        onRememberPercent={pinnedLayout.remember}
        folded={pinnedLayout.folded}
        onFolded={pinnedLayout.setFolded}
        environment={props.widgets}
      />
    );
  }

  // The right column: only Activity keeps its own arrangement (a flex item
  // of the workspace, or over the chat in a narrow window); with the pinned
  // widget at the right it is a column of that width, the widget above
  // Activity (when shown).
  let sideClass = 'side-column';
  let sideStyle: Record<string, string> = {};
  if (pinnedRight) {
    sideClass += ' with-pinned';
    sideStyle = { width: `${columnWidth}px` };
    if (activity.shown) {
      sideClass += ' with-activity';
    }
  }
  let sideLabel = 'Activity width';
  let sideTitle = 'Drag to change the width of Activity';
  let sideControls = activityColumnId;
  if (!activity.shown) {
    sideLabel = 'Right column width';
    sideTitle = 'Drag to change the width of the right column';
    sideControls = pinnedWidgetId;
  }

  // Over the chat, the column starts right of the list and its divider.
  let overlayLeft = 0;
  if (layout.shown) {
    overlayLeft = layout.width + 1;
  }

  // The width beside the list and the right column, where a conversation's
  // application and its chat share the room (../application/application-layout.ts).
  const conversationWidth = areaWidth({
    windowWidth,
    listShown: layout.shown,
    listWidth: layout.width,
    rightColumnBeside: sideShown && !overlay,
    rightColumnWidth: columnWidth,
  });

  let activityValueText = `${columnWidth} pixels`;
  if (columnWidth === activityMinimum) {
    activityValueText = `${columnWidth} pixels, the narrowest`;
  }

  return (
    <div class="workspace">
      {layout.shown && (
        <>
          <ConversationList
            appearance={layout.appearance}
            width={layout.width}
            bridge={props.bridge}
            activityShown={activity.shown}
            newActivity={newActivity}
            onToggleActivity={activity.toggleShown}
            settingsShown={settingsShown}
            onShowSettings={showSettingsFromList}
            onLeaveSettings={() => settingsView.setShown(false)}
            display={display}
            ticker={props.times.ticker}
          />
          <Divider
            width={layout.width}
            narrowest={stripWidth}
            widest={layout.widest}
            label="Conversation list width"
            title="Drag to change the width of the conversation list"
            valueText={listValueText(layout.width)}
            controls={conversationListId}
            fromPointer={(clientX, container) => widthFromPointer(clientX - container.left)}
            fromKey={widthFromKey}
            onWidth={layout.setWidth}
            onRemember={layout.remember}
          />
        </>
      )}
      {/* The page's main landmark, as slice 1's: the bar and the chat,
          Previous sessions or the empty view. */}
      <main class="workspace-main" ref={mainArea} inert={chatCovered}>
        <MainArea
          selected={selected}
          showingPrevious={state.showingPrevious}
          chat={props.chat}
          bridge={props.bridge}
          listShown={layout.shown}
          onToggleList={layout.toggleShown}
          activity={{
            shown: activity.shown,
            newActivity,
            onShow: showFromBar,
            button: barActivityButton,
            onFocusLost: barButtonLostFocus,
          }}
          settings={{
            shown: settingsShown,
            onToggle: toggleSettingsFromBar,
          }}
          times={props.times}
          requests={requests}
          listenHere={props.listenHere}
          pinnedBand={place === 'top' ? pinnedPanel : null}
          application={{
            widgets: props.widgets,
            windowWidth,
            areaWidth: conversationWidth,
            modes: applicationModes,
            permissions: chatPermissions,
            layout: applicationLayout,
          }}
        />
      </main>
      {sideShown && !overlay && (
        <Divider
          width={columnWidth}
          narrowest={activityMinimum}
          widest={sideColumnWidth(activityMaximum, windowWidth, layout.shown)}
          label={sideLabel}
          title={sideTitle}
          valueText={activityValueText}
          className="activity-divider"
          controls={sideControls}
          fromPointer={(clientX, container) => activityWidthFromPointer(container.right - clientX)}
          fromKey={activityWidthFromKey}
          onWidth={activity.setWidth}
          onRemember={activity.remember}
          onFocusLost={activityDividerLostFocus}
        />
      )}
      {sideShown && (
        <div class={sideClass} style={sideStyle}>
          {pinnedRight && pinnedPanel}
          {activity.shown && (
            <ActivityColumn
              overlay={overlay}
              width={columnWidth}
              left={overlayLeft}
              bridge={props.bridge}
              requests={requests}
              onHide={hideFromColumn}
              hideButton={columnActivityButton}
              onFocusLost={columnLostFocus}
              startProfile={startProfile}
              onStartProfile={setStartProfile}
              listenHere={props.listenHere}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The list divider's value in words. */
function listValueText(width: number): string {
  if (width === stripWidth) {
    return 'Strip';
  }
  return `Full list, ${width} pixels`;
}

/** The bar and what is selected below it (or the settings screen). */
function MainArea(props: {
  selected: AgentSession | undefined;
  showingPrevious: boolean;
  chat: ChatStore;
  bridge: GatewayChatBridge;
  listShown: boolean;
  onToggleList: () => void;
  activity: ActivityBar;
  settings: SettingsBar;
  times: PageTimes;
  requests: ActivityRequests;
  listenHere: ListenHere;
  /** The pinned widget's band above the chat, or null. */
  pinnedBand: ComponentChildren;
  /** What the selected conversation's application needs (ConversationArea.tsx). */
  application: ApplicationContext;
}) {
  const { selected } = props;
  const display = useDisplaySettings(props.times.settings);

  // The bar's parts every page has: ☰, the Activity ☰ and the gear.
  const barControls = {
    listShown: props.listShown,
    onToggleList: props.onToggleList,
    activityShown: props.activity.shown,
    newActivity: props.activity.newActivity,
    onShowActivity: props.activity.onShow,
    activityButton: props.activity.button,
    onActivityFocusLost: props.activity.onFocusLost,
    settingsShown: props.settings.shown,
    onToggleSettings: props.settings.onToggle,
    // Listen here's mark: on every page's bar, the settings screen's too.
    listenMark: <ListenMark listenHere={props.listenHere} onShowActivity={props.activity.onShow} />,
  };

  // What the Store selects, below the bar. Each kind has its own key, so a
  // change of selection never replaces the settings layer beside it.
  let bar = <ChatBar title="Conversations" state={null} {...barControls} />;
  let content = (
    <div key="empty" class="page-column" inert={props.settings.shown}>
      <HeldInput chat={props.chat} />
      <NothingSelected />
    </div>
  );
  if (!props.settings.shown) {
    bar = (
      <ChatBar title="Conversations" state={null} {...barControls}>
        <SignOut />
      </ChatBar>
    );
  }

  if (selected) {
    // The chat stays drawn while the settings screen covers it (inert and
    // hidden from assistive technology meanwhile), so its scroll position,
    // its following of the live end and its editor survive the round trip.
    // The picker belongs to one conversation lifetime (its ID and tool
    // epoch): another one starts with it closed.
    const lifetime = selected.id + ' ' + (selected.toolEpoch ?? '');
    bar = (
      <ChatBar
        title={selected.title || 'Untitled'}
        state={
          <BarState
            session={selected}
            admitted={props.bridge.admitted}
            settings={display}
            ticker={props.times.ticker}
          />
        }
        model={<ModelPicker key={lifetime} session={selected} admitted={props.bridge.admitted} />}
        {...barControls}
      />
    );
    content = (
      <ConversationArea
        key="chat"
        session={selected}
        chat={props.chat}
        bridge={props.bridge}
        environment={props.application.widgets}
        covered={props.settings.shown}
        windowWidth={props.application.windowWidth}
        areaWidth={props.application.areaWidth}
        modes={props.application.modes}
        permissions={props.application.permissions}
        layout={props.application.layout}
      />
    );
  } else if (props.showingPrevious) {
    bar = <ChatBar title="Previous sessions" state={null} {...barControls} />;
    if (!props.settings.shown) {
      bar = (
        <ChatBar title="Previous sessions" state={null} {...barControls}>
          <SignOut />
        </ChatBar>
      );
    }
    content = (
      <div key="previous" class="page-column" inert={props.settings.shown}>
        <HeldInput chat={props.chat} />
        <PreviousSessions bridge={props.bridge} />
      </div>
    );
  }

  if (props.settings.shown) {
    bar = <ChatBar title="Settings" state={null} {...barControls} />;
  }

  // The settings screen lies over what is selected, in the same place
  // whatever the selection does meanwhile (a conversation closed elsewhere
  // keeps the reader's focus and scroll position on the settings screen).
  return (
    <>
      {bar}
      <div class="main-body">
        {selected ? props.pinnedBand : null}
        {content}
        {props.settings.shown && (
          <div key="settings" class="settings-layer">
            <div class="page-column">
              <HeldInput chat={props.chat} />
              <SettingsScreen
                settings={props.times.settings}
                admitted={() => props.bridge.admitted}
                requests={props.requests}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function SignOut() {
  const store = useStore();
  return (
    <button class="bar-button" onClick={() => store.connection.forget()}>
      Sign out
    </button>
  );
}

/** What the main area says while no conversation is selected. */
function NothingSelected() {
  const state = useAppState();
  let message = 'Choose a conversation from the list.';
  if (state.order.length === 0) {
    message = 'No open conversations. Start one on the computer.';
    if (state.connection.status !== 'online' && !state.engine) {
      message = 'Waiting for Companion…';
    }
  }
  return <p class="workspace-empty">{message}</p>;
}

/**
 * Text only the chat editor holds (an input the bridge could not take, see
 * ChatStore.unresolved), shown while no conversation is, so it stays
 * reachable when its conversation is not shown, for example after it was
 * closed elsewhere: its length, Copy and Discard, as the chat page's own "No
 * conversation" view offers. The text itself is never shown or sent
 * anywhere.
 */
function HeldInput(props: { chat: ChatStore }) {
  const { chat } = props;
  const [held, setHeld] = useState(chat.unresolved());
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    const unsubscribe = chat.subscribe(() => setHeld(chat.unresolved()));
    // It can change between the first render and this effect.
    setHeld(chat.unresolved());
    return unsubscribe;
  }, [chat]);

  if (!held) {
    return null;
  }

  function copy() {
    const bridge = chat.native;
    if (!bridge || !held) {
      return;
    }
    setFeedback('Copying…');
    bridge.copyText(held.text, (json) => {
      let accepted = false;
      try {
        accepted = (JSON.parse(json) as { accepted: boolean }).accepted === true;
      } catch {
        accepted = false;
      }
      if (accepted) {
        setFeedback('Copied.');
      } else {
        setFeedback('The browser did not allow copying.');
      }
    });
  }

  return (
    <div class="held-input" role="status">
      <span>
        Text ({held.text.length} characters) typed in a conversation is only in this page. Copy it
        or discard it.
      </span>
      <button class="bar-button" onClick={copy}>
        Copy
      </button>
      <button class="bar-button" onClick={() => chat.setUnresolved(null)}>
        Discard
      </button>
      {feedback && <span class="held-feedback">{feedback}</span>}
    </div>
  );
}
