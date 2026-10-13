import QtQuick
import QtQuick.Window
import QtQml.Models

// Reusable panel body. The desktop adapter owns the window, shortcut, monitor
// selection, and theme; this item only renders the selected page and tab rail.
Item {
  id: root

  required property bool online
  required property bool paused
  property string pauseReason: ""
  required property bool speaking
  required property int processing
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  // Hosts supply their surface color for compositing translucent menu colors.
  property color background: tooltipBackground
  property color tooltipBackground: selection
  property color tooltipForeground: foreground
  property color tooltipBorder: muted
  property real unit: 1
  readonly property real tabUnit: 1.25 * unit
  property bool animationsEnabled: true
  property bool nativeWidgets: false
  property string shortcutLabel: ""
  property string focusShortcut: ""
  property var history: []
  property var intents: []
  property var transcriptionCleanup: null
  property var captureStorage: null
  property var activityHistoryModel: null
  property bool activityHistoryAvailable: false
  property bool historyDeletionAvailable: false
  property bool textInputAvailable: false
  // Manual recording into a conversation's text box (listener state).
  property bool recordingAvailable: false
  property var recording: null
  // The microphone is in use for manual recording (see StatusView).
  readonly property bool microphoneRecording: recording !== null && recording !== undefined && recording.capturing === true
  property var agentActions: ({})
  property var sessions: []
  property var sessionControls: null
  // Retained with this shared body across reconnects and Window/Sidebar/Dock.
  // Store the preference in logical theme units; a narrow host only clamps the
  // effective width, so growing it again restores the user's chosen width.
  property real railWidthUnits: 80
  readonly property real maximumRailWidth: Math.max(80 * unit, Math.min(280 * unit, width - 320 * unit))
  readonly property real railWidth: Math.max(80 * unit, Math.min(railWidthUnits * unit, maximumRailWidth))
  property string draggingSessionId: ""
  property string dragBeforeId: ""
  property bool dragDestinationValid: false
  property real dragSceneX: 0
  property real dragSceneY: 0
  property string dragOrderRevision: ""
  readonly property bool canMoveSessions: online && sessionControls !== null && sessionControls.controlsAvailable
  onCanMoveSessionsChanged: if (!canMoveSessions) cancelDrag()
  property var unreadSessionIds: ({})
  property var previousSessions: []
  property bool showingPrevious: false
  onShowingPreviousChanged: if (showingPrevious) clearPendingOrigin()
  property string controlError: ""
  property string selectedSessionId: ""
  // An archived sender is selected by the normal restore event, not by tab
  // membership: a quiet background reopen must never take over the user's view.
  property string pendingOriginId: ""
  property string pendingOriginGroupId: ""
  // True while the pending sender was archived when its heading was clicked.
  property bool pendingOriginRestoring: false
  // Senders an agent heading can actually open: an open tab or a saved Previous
  // session while connected. Deleted senders and offline panels show plain text.
  readonly property var openableOrigins: {
    const ids = {}
    if (!root.online) return ids
    for (const entry of root.sessions) ids[entry.id] = true
    for (const entry of root.previousSessions) ids[entry.id] = true
    return ids
  }
  onSelectedSessionIdChanged: {
    if (root.pendingOriginId && root.selectedSessionId !== root.pendingOriginId) clearPendingOrigin()
    Qt.callLater(ensureSelectedVisible)
  }
  function clearPendingOrigin() {
    root.pendingOriginId = ""
    root.pendingOriginGroupId = ""
    root.pendingOriginRestoring = false
  }
  // A user-requested reopen selects its tab in the same restore update. If the
  // sender arrived without selection (our reopen was refused, then an agent
  // reopened it quietly), forget the request so a later tab click is ordinary.
  function settlePendingRestore() {
    if (!root.pendingOriginRestoring || root.selectedSessionId === root.pendingOriginId) return
    if (root.sessions.some(entry => entry.id === root.pendingOriginId)) clearPendingOrigin()
  }
  // Each harness has its own catalogue. A Pi conversation needs Pi's
  // discovered models; a Claude Code conversation needs only the listener's
  // Claude allowlist, so it never starts Pi discovery.
  readonly property bool selectedClaude: selectedSession !== null && selectedSession.harness === "claude-code"
  readonly property bool catalogueReachable: online && selectedSession !== null && sessionControls !== null && sessionControls.controlsAvailable
  readonly property bool modelsNeeded: catalogueReachable && !selectedClaude
  readonly property bool claudeModelsNeeded: catalogueReachable && selectedClaude
  onModelsNeededChanged: if (modelsNeeded) Qt.callLater(ensureModels)
  onClaudeModelsNeededChanged: if (claudeModelsNeeded) Qt.callLater(ensureModels)
  onSessionControlsChanged: Qt.callLater(ensureModels)
  function ensureModels() {
    if (root.modelsNeeded) root.sessionControls.ensureModels()
    if (root.claudeModelsNeeded) root.sessionControls.ensureClaudeModels()
  }
  function refreshModels() {
    if (root.modelsNeeded) root.sessionControls.refreshModels()
    if (root.claudeModelsNeeded) root.sessionControls.refreshClaudeModels()
  }
  readonly property var selectedSession: !showingPrevious && sessions.find(entry => entry.id === selectedSessionId) || null
  property var locallyUnpinned: ({})
  function widgetMessages(session) {
    return session.pinnedMessage ? [session.pinnedMessage].concat(session.messages) : session.messages
  }
  readonly property var pinnedMessage: selectedSession && widgetMessages(selectedSession).find(message =>
    message.widget && message.widget.viewUrl && message.widget.presentation.placement === "pinned"
      && !root.isLocallyUnpinned(message.widget)) || null
  readonly property bool fullWidget: pinnedMessage !== null && pinnedMessage.widget.presentation.heightPercent === 100
  // The in-panel browser (PanelBrowser.qml) needs an initialized Qt WebEngine
  // and belongs in the standalone native window, so only that host sets
  // browserAvailable. The nativeWidgets marker alone is not enough: the
  // experimental Quickshell host sets it too. While browsing, the browser
  // replaces the page area; the selected conversation, drafts, pins and
  // widgets stay in place underneath, hidden, and reappear on return.
  property bool browserAvailable: false
  property bool browserOpen: false
  // Set on first open; the browser item then lives as long as this body.
  property bool browserStarted: false
  // PanelBrowser.qml needs Qt WebEngine 6.9+ (WebEngineProfilePrototype); the
  // rest of the panel builds with 6.8. A failed load shows a message instead.
  property url browserSource: Qt.resolvedUrl("PanelBrowser.qml")
  readonly property bool browsing: browserOpen && browserAvailable
  // The host's panel is on screen. Only a pinned page uses it: the full
  // browser keeps running in a hidden panel, as in a hidden browser window.
  property bool panelShown: true

  // Manual browser pin. Instead of replacing the chat, the same browser page
  // (one view, one profile) can sit above one conversation's chat. That
  // conversation owns the pin: the page is shown only while it is selected,
  // and is frozen and muted on other tabs, Activity, Previous sessions or in
  // a hidden panel. There is one page, so opening the full browser (the
  // header button or an agent) moves it out of the pin, and Close unloads it.
  // Ownership is kept across reconnects and Window/Sidebar/Dock moves for as
  // long as the conversation stays open; it is not saved across restarts.
  property string browserPinOwnerId: ""
  // The user's preferred pin height, as a share of the space below the header,
  // so it follows the panel's size. The measured chat input and a readable
  // transcript always win; see body.browserPinHeight. There is no full mode.
  property real browserPinPercent: 35
  readonly property real browserPinMinimumPercent: 15
  readonly property real browserPinMaximumPercent: 80
  // The pinned presentation applies (the full browser is not open), whether
  // or not its owner is on screen right now.
  readonly property bool browserPinned: browserPinOwnerId !== "" && browserAvailable && !browsing
  readonly property bool browserPinOwnerSelected: browserPinned && !showingPrevious
    && selectedSession !== null && selectedSessionId === browserPinOwnerId
  // One pin slot per conversation: a pinned widget always keeps its place.
  // When an agent pins a widget above a pinned page, the page waits, frozen,
  // behind it (suspended) until the widget is unpinned or the user unpins the
  // page; neither resource is dropped or changed.
  readonly property bool browserPinVisible: browserPinOwnerSelected && pinnedMessage === null
    && browserLoader.status === Loader.Ready
  readonly property bool browserPinSuspended: browserPinOwnerSelected && pinnedMessage !== null
  // The page is on screen and running. Otherwise its item is hidden, which
  // freezes and mutes it.
  readonly property bool browserShown: browsing || (browserPinVisible && panelShown)
  // The full browser is open only to answer a question from the pinned page
  // (the strip's Answer); the pin stays owned and comes back once answered.
  property bool browserAnsweringForPin: false
  readonly property bool inputFocused: root.keyboardFocused && (root.composerFocusId !== "" || activityView.inputFocused)
  readonly property string composerFocusId: fullWidget || browsing ? "" : chat.composerFocusId
  onFullWidgetChanged: if (fullWidget) chat.releaseComposerFocus()
  onBrowsingChanged: {
    if (browsing) root.releaseComposerFocus()
    else root.browserAnsweringForPin = false
  }
  readonly property bool keyboardFocused: root.Window.window !== null && root.Window.window.active
  // Activity and the session library share the conversation's reader zoom.
  // Keep geometry in theme units; only text and its measured layout grow.
  property alias zoomPercent: chat.zoomPercent
  readonly property bool pageZoomEnabled: root.visible && root.animationsEnabled && root.keyboardFocused
    && !root.browsing && (root.selectedSession === null || root.fullWidget)

  // Activity has its own explicit text submission, never an agent composer
  // or an automatic dictation destination. Clear the hidden composer when leaving a conversation.
  onSelectedSessionChanged: {
    if (selectedSession === null) {
      chat.releaseComposerFocus()
      // While browsing, the page or address field keeps focus: a conversation
      // closed in the background must not take the user's typing away.
      if (root.keyboardFocused && !root.browsing) root.forceActiveFocus(Qt.TabFocusReason)
    } else if (selectedSession.id === root.pendingOriginId) {
      const groupId = root.pendingOriginGroupId
      root.clearPendingOrigin()
      if (groupId) Qt.callLater(function() { chat.jumpToToolGroup(groupId) })
    }
  }

  signal utteranceRequested(string text)
  signal closeRequested()
  signal intentEnabledRequested(string name, bool enabled, string mode)
  signal transcriptionCleanupRequested(bool enabled)
  signal captureStorageRequested(bool enabled)
  signal historyActionRequested(string action, string id, var value)
  signal sessionSelected(string id)
  onSessionSelected: id => {
    if (id !== root.pendingOriginId) clearPendingOrigin()
    // Choosing a page in the rail, by pointer or shortcut, leaves the browser.
    root.browserOpen = false
  }
  signal previousRequested()
  onPreviousRequested: root.browserOpen = false
  signal reopenSessionRequested(string id)
  signal screenshotRequested(url source, string title)
  signal cancelWakeRequested(string id, string timerId)
  signal stopSessionRequested(string id)
  signal dismissSessionRequested(string id)
  signal sendSessionRequested(string id, string text)
  signal recordRequested(string id, int draftLength)
  signal stopRecordingRequested(string id)
  signal toolPageRequested(var request)
  function toolPageReceived(message) { chat.toolPageReceived(message) }
  signal choiceRequested(string id, string revision, int index)
  signal stopRunRequested(string id, string runId)

  function utteranceSubmitted(text, error) { activityView.utteranceSubmitted(text, error) }
  function submitted(id, text, error) { chat.submitted(id, text, error) }
  // Returns {outcome, reason}. A closed or unknown tab never receives text.
  function applyDraft(request) {
    if (!root.sessions.some(entry => entry.id === request.id)) {
      return {outcome: "unavailable", reason: "The conversation is not open in this panel."}
    }
    return chat.applyDraft(request)
  }
  function choiceSubmitted(id, revision, index, error) { chat.choiceSubmitted(id, revision, index, error) }
  function recordingStarted(id, recordingId, error) { chat.recordingStarted(id, recordingId, error) }
  function recordingStopAnswered(error) { chat.recordingStopAnswered(error) }
  // Returns {outcome, length} or {outcome: "unavailable", reason}. A closed
  // or unknown tab never receives recorded text.
  function appendRecording(request) {
    if (!root.sessions.some(entry => entry.id === request.id)) {
      return {outcome: "unavailable", reason: "The conversation is not open in this panel."}
    }
    return chat.appendRecording(request)
  }
  function recordingFinished(message) { chat.recordingFinished(message) }
  function recordingDisconnected() { chat.recordingDisconnected() }
  function focusComposer() {
    // The focus-input shortcut asks for the composer; the page stays loaded.
    root.browserOpen = false
    if (activityView.visible) activityView.focusInput()
    else if (!root.fullWidget) chat.focusComposer()
  }
  function releaseComposerFocus() {
    chat.releaseComposerFocus()
    activityView.releaseInputFocus()
  }

  // Preserve each tab's animation and hover state while tokens stream. Using
  // the sessions array directly as a Repeater model recreates every delegate.
  ListModel { id: sessionTabs }
  function synchronizeTabs() {
    for (let index = sessionTabs.count - 1; index >= 0; index--) {
      if (!root.sessions.some(entry => entry.id === sessionTabs.get(index).tabId)) {
        sessionTabs.remove(index)
      }
    }
    for (let index = 0; index < root.sessions.length; index++) {
      const session = root.sessions[index]
      const row = {tabId: session.id, tabTitle: session.title,
        tabWakeCount: (session.wakes || []).filter(t => t.state === "scheduled" || t.state === "waiting").length,
        tabRunning: session.status === "starting" || session.status === "running"}
      let position = index
      while (position < sessionTabs.count && sessionTabs.get(position).tabId !== session.id) position++
      if (position === sessionTabs.count) {
        sessionTabs.insert(index, row)
      } else {
        if (position !== index) sessionTabs.move(position, index, 1)
        sessionTabs.set(index, row)
      }
    }
    Qt.callLater(ensureSelectedVisible)
  }
  function ensureSelectedVisible() {
    if (root.draggingSessionId || root.showingPrevious) return
    for (const tab of tabs.children) {
      if (tab.tabId !== root.selectedSessionId) continue
      if (tab.y < sessionList.contentY) sessionList.contentY = tab.y
      else if (tab.y + tab.height > sessionList.contentY + sessionList.height) {
        sessionList.contentY = Math.max(0, tab.y + tab.height - sessionList.height)
      }
      break
    }
  }
  onSessionsChanged: {
    // Removing a delegate during a grabbed pointer gesture emits neither
    // release nor cancel. Membership, not the delegate, owns this cleanup.
    if (root.draggingSessionId && !root.sessions.some(entry => entry.id === root.draggingSessionId)) cancelDrag()
    if (root.pendingOriginRestoring) Qt.callLater(settlePendingRestore)
    synchronizeTabs()
    const dismissed = Object.assign({}, root.locallyUnpinned)
    for (const id of Object.keys(dismissed)) {
      const stillPinned = root.sessions.some(session => root.widgetMessages(session).some(message =>
        message.widget && message.widget.id === id && root.isLocallyUnpinned(message.widget)
          && message.widget.presentation.placement === "pinned"))
      if (!stillPinned) delete dismissed[id]
    }
    root.locallyUnpinned = dismissed

    // A closed conversation takes its browser pin with it. The page stays
    // loaded and frozen for the Browser button; it never moves to another tab.
    if (root.browserPinOwnerId && !root.sessions.some(entry => entry.id === root.browserPinOwnerId)) {
      root.browserPinOwnerId = ""
      // Answering for that pin was a temporary full view of its page; it ends
      // with the owner. The page (and its question) waits hidden and frozen.
      if (root.browserAnsweringForPin) {
        root.browserOpen = false
        Qt.callLater(function() {
          if (root.keyboardFocused && !root.browsing && root.selectedSession === null) root.forceActiveFocus(Qt.TabFocusReason)
        })
      }
    }
  }

  function isLocallyUnpinned(reference) {
    const dismissed = root.locallyUnpinned[reference.id]
    return dismissed && dismissed.viewUrl === reference.viewUrl && reference.revision <= dismissed.revision
  }

  // Explicit user action only. The browser takes keyboard focus once, when
  // it opens; nothing in the panel moves focus into it later.
  function openBrowser() {
    if (!root.browserAvailable) return
    root.browserStarted = true
    // The full browser shows the one page, so it is no longer pinned.
    root.browserPinOwnerId = ""
    root.browserOpen = true
    Qt.callLater(function() {
      if (root.browsing && browserLoader.item) browserLoader.item.focusBrowser()
    })
  }

  // companion_browser_open: an agent's own turn asks to show a web page.
  // `request` is {requestId, id (calling conversation), url}; `answer` must be
  // called exactly once with {outcome, reason, url?, title?}. It opens only for
  // the conversation the user has selected here, never while they are typing
  // an address or answering a page dialog, and it never shows the window or
  // moves keyboard focus to the address field.
  property var agentBrowserRequests: ({})
  function openBrowserFromAgent(request, answer) {
    // The listener sends each request once; ignore an impossible repeat.
    if (typeof request.requestId !== "string" || root.agentBrowserRequests[request.requestId]) return
    const seen = Object.assign({}, root.agentBrowserRequests)
    seen[request.requestId] = true
    const keys = Object.keys(seen)
    if (keys.length > 32) delete seen[keys[0]]
    root.agentBrowserRequests = seen

    if (!root.browserAvailable) {
      answer({outcome: "unsupported", reason: "This Companion panel has no built-in browser."})
      return
    }
    if (typeof request.id !== "string" || typeof request.url !== "string"
      || root.showingPrevious || root.selectedSession === null || root.selectedSessionId !== request.id) {
      answer({outcome: "not-selected",
        reason: "The user is looking at another page or conversation in Companion."})
      return
    }
    root.browserStarted = true
    const browser = browserLoader.item
    if (!browser) {
      answer({outcome: "unsupported", reason: "The panel browser could not load here (it needs Qt WebEngine 6.9 or newer)."})
      return
    }
    const busy = browser.userBusyReason()
    if (busy !== "") {
      answer({outcome: "busy", reason: busy})
      return
    }
    // Refuse a disallowed address before changing what is shown, so a refusal
    // leaves the chat, its input focus and any pin exactly as they were.
    const refusal = browser.addressRefusal(request.url)
    if (refusal !== "") {
      answer({outcome: "refused", reason: refusal})
      return
    }
    // Show the browser first, so the page is awake (not frozen) when it loads.
    // A pinned page moves into the full browser, like the header button. If
    // the request does not start (refused), the pin is untouched.
    const wasBrowsing = root.browsing
    const displacedPinOwnerId = root.browserPinOwnerId
    root.browserOpen = true
    const settle = function(result) {
      // The user chose to stay on a page that asked before leaving: the
      // request changed nothing, so the pin it displaced comes back, unless
      // the user has meanwhile left the full browser or pinned again.
      const restorePin = result.outcome === "cancelled" && displacedPinOwnerId !== ""
        && root.browsing && root.browserPinOwnerId === ""
        && root.sessions.some(entry => entry.id === displacedPinOwnerId)
      if (restorePin) {
        root.browserPinOwnerId = displacedPinOwnerId
        root.browserOpen = false
      }
      answer(result)
    }
    if (!browser.openFromAgent(request.url, settle)) {
      root.browserOpen = wasBrowsing
      return
    }
    // A successful request shows the full browser, never the pin.
    root.browserPinOwnerId = ""
    // Within an already focused window, typing continues in the page rather
    // than in the now hidden composer. An inactive window is left alone.
    if (!wasBrowsing && root.keyboardFocused) Qt.callLater(function() {
      if (root.browsing && browserLoader.item && browserLoader.item.page) browserLoader.item.page.forceActiveFocus()
    })
  }

  // Return from the browser to the page it covered, keeping the browser page.
  // From a pinned page (its Chat button) this only moves to the chat input.
  function closeBrowser() {
    if (!root.browserOpen && !root.browserPinVisible) return
    root.browserOpen = false
    Qt.callLater(function() { if (root.keyboardFocused && !root.browsing) root.focusComposer() })
  }

  // The browser's Pin: show the page above the selected conversation's chat
  // and return to that chat's input. Refused, with the reason in the browser's
  // strip, where there is no conversation or its one pin slot holds a widget;
  // the widget is never unpinned or replaced for it.
  function pinBrowser() {
    const browser = browserLoader.item
    if (!root.browsing || !browser) return
    if (root.showingPrevious || root.selectedSession === null) {
      browser.notify("Choose a conversation first; the page is pinned above its chat.")
      return
    }
    if (root.pinnedMessage !== null) {
      browser.notify("This conversation already has a pinned widget. Unpin it first to pin the page.")
      return
    }
    root.browserPinOwnerId = root.selectedSessionId
    root.browserOpen = false
    Qt.callLater(function() { if (root.keyboardFocused && root.browserPinVisible) chat.focusComposer() })
  }

  // The strip's Answer on a pin too short for its page's question: show the
  // page in the full browser, with the question focused (an explicit user
  // request), keeping the pin's owner. Answering the question returns the
  // page to its pin and the chat input; Chat does the same without answering.
  function answerInFullBrowser() {
    const browser = browserLoader.item
    if (!root.browserPinVisible || !browser || !browser.pendingDialog) return
    root.browserOpen = true
    root.browserAnsweringForPin = true
    Qt.callLater(function() { if (root.browsing && browserLoader.item) browserLoader.item.focusDialog() })
  }
  function browserDialogChanged() {
    const browser = browserLoader.item
    if (!root.browserAnsweringForPin || !browser || browser.pendingDialog !== null) return
    root.browserAnsweringForPin = false
    if (root.browsing && root.browserPinOwnerId !== "") {
      root.browserOpen = false
      Qt.callLater(function() { if (root.keyboardFocused && root.browserPinVisible) chat.focusComposer() })
    }
  }

  // Unpin keeps the page loaded and frozen; the Browser button reopens it.
  function unpinBrowser() {
    if (root.browserPinOwnerId === "") return
    root.browserPinOwnerId = ""
    Qt.callLater(function() { if (root.keyboardFocused && root.selectedSession !== null && !root.browsing) root.focusComposer() })
  }

  // Drag or keyboard resizing of the pin. `height` is in pixels below the
  // header; the stored preference is a percentage, clamped to what is
  // available right now, so a drag past the limit does not feel dead.
  function resizeBrowserPin(height) {
    if (body.contentHeight <= 0) return
    const available = 100 * body.browserPinMaximumHeight / body.contentHeight
    const largest = Math.min(root.browserPinMaximumPercent, available)
    const requested = 100 * height / body.contentHeight
    root.browserPinPercent = Math.max(root.browserPinMinimumPercent, Math.min(requested, largest))
  }
  function stepBrowserPin(percent) {
    root.resizeBrowserPin(body.browserPinHeight + body.contentHeight * percent / 100)
  }

  function backToChat() {
    if (!root.pinnedMessage) return
    const reference = root.pinnedMessage.widget
    // Keep the escape route usable after a disconnect or renderer failure.
    // Ask for durable unpin while the surface is still active, then reveal the
    // retained chat locally without waiting for an HTTP response.
    pinnedSurface.unpin()
    const dismissed = Object.assign({}, root.locallyUnpinned)
    // Suppress the revision the user escaped, including reconnect snapshots.
    // A newer server update can present the widget again; the local escape must
    // not permanently overrule later agent instructions for this conversation.
    dismissed[reference.id] = {viewUrl: reference.viewUrl, revision: reference.revision}
    root.locallyUnpinned = dismissed
    Qt.callLater(function() { if (root.keyboardFocused) chat.focusComposer() })
  }
  Component.onCompleted: synchronizeTabs()

  // Navigation only: select the sender's tab, or ask to reopen it from
  // Previous sessions. It never sends a message or moves composer focus.
  function openOrigin(id, groupId) {
    if (!id || root.openableOrigins[id] !== true) return
    const open = root.sessions.some(entry => entry.id === id)
    root.pendingOriginId = id
    root.pendingOriginGroupId = groupId
    root.pendingOriginRestoring = !open
    if (open) {
      root.sessionSelected(id)
    } else {
      root.reopenSessionRequested(id)
    }
  }

  function selectConversation(id) {
    root.clearPendingOrigin()
    root.sessionSelected(id)
    Qt.callLater(function() {
      if (root.selectedSession && root.selectedSessionId === id && root.keyboardFocused) root.focusComposer()
    })
  }

  function moveSelected(direction) {
    if (!root.canMoveSessions || root.showingPrevious) return
    const index = root.sessions.findIndex(entry => entry.id === root.selectedSessionId)
    const destination = index + direction
    if (index < 0 || destination < 0 || destination >= root.sessions.length) return
    const before = direction < 0 ? root.sessions[destination].id
      : destination + 1 < root.sessions.length ? root.sessions[destination + 1].id : ""
    root.sessionControls.move(root.selectedSessionId, before)
  }

  // The pointer moves independently of the delegates. Commit once on release,
  // preserving selection and every session/widget object throughout the drag.
  function beginDrag(id) {
    cancelDrag()
    if (!root.canMoveSessions || !root.sessions.some(entry => entry.id === id)) return
    root.draggingSessionId = id
    // Capture once per physical gesture, never from a preceding drag or from
    // the scroll timer. A membership/order change still invalidates this drop.
    root.dragOrderRevision = root.sessionControls.orderRevision
  }

  function cancelDrag() {
    root.draggingSessionId = ""
    root.dragBeforeId = ""
    root.dragDestinationValid = false
    root.dragSceneX = 0
    root.dragSceneY = 0
    root.dragOrderRevision = ""
    Qt.callLater(ensureSelectedVisible)
  }

  function updateDrag(id, sceneX, sceneY) {
    if (!id || id !== root.draggingSessionId) return
    root.dragSceneX = sceneX
    root.dragSceneY = sceneY
    const point = sessionList.mapFromItem(null, sceneX, sceneY)
    root.dragDestinationValid = point.x >= 0 && point.x <= sessionList.width
      && point.y >= 0 && point.y <= sessionList.height
    root.dragBeforeId = ""
    for (let index = 0; index < tabs.children.length; index++) {
      const tab = tabs.children[index]
      if (!tab.tabId || tab.tabId === id) continue
      if (point.y + sessionList.contentY < tab.y + tab.height / 2) {
        root.dragBeforeId = tab.tabId
        break
      }
    }
  }

  Timer {
    objectName: "sessionDragScrollTimer"
    interval: 40
    repeat: true
    running: root.draggingSessionId !== "" && root.dragDestinationValid
    onTriggered: {
      const point = sessionList.mapFromItem(null, root.dragSceneX, root.dragSceneY)
      const delta = point.y < 28 * root.unit ? -12 * root.unit
        : point.y > sessionList.height - 28 * root.unit ? 12 * root.unit : 0
      sessionList.contentY = Math.max(0, Math.min(Math.max(0, sessionList.contentHeight - sessionList.height), sessionList.contentY + delta))
      root.updateDrag(root.draggingSessionId, root.dragSceneX, root.dragSceneY)
    }
  }

  function finishDrag() {
    if (root.dragDestinationValid && root.canMoveSessions && root.draggingSessionId
      && root.dragOrderRevision === root.sessionControls.orderRevision) {
      root.sessionControls.move(root.draggingSessionId, root.dragBeforeId)
    }
    cancelDrag()
  }

  Shortcut {
    sequence: "Alt+Shift+Up"
    context: Qt.WindowShortcut
    enabled: root.visible && root.animationsEnabled && root.keyboardFocused && root.canMoveSessions
    onActivated: root.moveSelected(-1)
  }
  Shortcut {
    sequence: "Alt+Shift+Down"
    context: Qt.WindowShortcut
    enabled: root.visible && root.animationsEnabled && root.keyboardFocused && root.canMoveSessions
    onActivated: root.moveSelected(1)
  }

  // Cycle Activity -> Q1 -> Q2 -> ... -> Activity. Previous sessions joins
  // the sequence at Activity; a missing/closed conversation does the same.
  function nextTab() {
    const index = root.showingPrevious ? -1 : root.sessions.findIndex(entry => entry.id === root.selectedSessionId)
    const next = root.sessions[index + 1]
    if (next) root.selectConversation(next.id)
    else root.sessionSelected("")
  }

  // SessionView already owns these keys while a conversation is visible.
  // Enable this set only on the other pages, avoiding ambiguous shortcuts.
  Shortcut {
    sequences: ["Ctrl++", "Ctrl+=", "Ctrl+Shift++"]
    context: Qt.WindowShortcut
    enabled: root.pageZoomEnabled
    onActivated: chat.zoomBy(10)
  }
  Shortcut {
    sequence: "Ctrl+-"
    context: Qt.WindowShortcut
    enabled: root.pageZoomEnabled
    onActivated: chat.zoomBy(-10)
  }
  Shortcut {
    sequence: "Ctrl+0"
    context: Qt.WindowShortcut
    enabled: root.pageZoomEnabled
    onActivated: root.zoomPercent = 100
  }

  Shortcut {
    sequences: ["Alt+0", "Meta+Alt+0"]
    context: Qt.WindowShortcut
    enabled: root.visible && root.animationsEnabled && root.Window.window !== null && root.Window.window.active
    onActivated: root.sessionSelected("")
  }

  Shortcut {
    sequence: "Meta+Alt+Tab"
    context: Qt.WindowShortcut
    enabled: root.visible && root.animationsEnabled && root.keyboardFocused
    onActivated: root.nextTab()
  }

  // These are local to this focused panel, never desktop-global bindings.
  // Numbers follow the same current order as Q1–Q9 in the tab rail.
  Instantiator {
    model: Math.min(root.sessions.length, 9)
    delegate: Shortcut {
      required property int index
      sequence: "Alt+" + (index + 1)
      context: Qt.WindowShortcut
      enabled: root.visible && root.animationsEnabled && root.Window.window !== null && root.Window.window.active
      onActivated: {
        root.selectConversation(root.sessions[index].id)
      }
    }
  }

  // Activity remains the first tab. Questions get their own vertically stacked
  // tabs, scrollable independently of the conversation itself.
  Flickable {
    id: rail
    objectName: "tabRail"
    width: root.railWidth
    height: parent.height
    // Keep a full session tab between the fixed controls. On very short
    // surfaces the whole rail scrolls instead of overlapping those controls.
    contentHeight: Math.max(height, 244 * root.tabUnit)
    interactive: contentHeight > height
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Rectangle {
      width: rail.width
      height: rail.contentHeight
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)

      Rectangle {
        objectName: "activityTab"
        anchors.top: parent.top
        anchors.topMargin: 20 * root.tabUnit
        anchors.horizontalCenter: parent.horizontalCenter
        width: rail.width - 16 * root.tabUnit
        height: 64 * root.tabUnit
        color: !root.showingPrevious && root.selectedSession === null ? root.selection : "transparent"

        // Same right-edge selection marker as the conversation tabs.
        Rectangle {
          objectName: "activitySelectionMarker"
          visible: !root.showingPrevious && root.selectedSession === null
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          anchors.topMargin: 6 * root.tabUnit
          anchors.bottomMargin: 6 * root.tabUnit
          width: 3 * root.tabUnit
          radius: width / 2
          color: root.accent
        }

        Column {
          anchors.centerIn: parent
          spacing: 8 * root.tabUnit

          Row {
            anchors.horizontalCenter: parent.horizontalCenter
            height: 20 * root.tabUnit
            spacing: 3 * root.tabUnit

            Repeater {
              model: [8, 20, 14]
              Rectangle {
                objectName: "activityTabBar"
                required property int modelData
                anchors.verticalCenter: parent.verticalCenter
                width: 3 * root.tabUnit
                height: modelData * root.tabUnit
                radius: root.tabUnit
                color: root.accent
              }
            }
          }

          Text {
            objectName: "activityTabLabel"
            text: "Activity"
            textFormat: Text.PlainText
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: 8 * root.tabUnit
          }
        }

        Accessible.role: Accessible.PageTab
        Accessible.name: "Activity"
        Accessible.selected: !root.showingPrevious && root.selectedSession === null
        Accessible.onPressAction: root.sessionSelected("")
        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.sessionSelected("")
        }
      }

      Flickable {
        id: sessionList
        objectName: "sessionTabList"
        anchors.fill: parent
        anchors.topMargin: 100 * root.tabUnit
        anchors.bottomMargin: 82 * root.tabUnit
        contentHeight: tabs.height
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: root.draggingSessionId === ""

        Column {
          id: tabs
          width: parent.width
          spacing: 8 * root.tabUnit
          Repeater {
            model: sessionTabs
            SessionTab {
              required property string tabId
              required property string tabTitle
              required property int tabWakeCount
              required property bool tabRunning
              required property int index
              objectName: "tab-" + tabId
              width: rail.width - 16 * root.tabUnit
              anchors.horizontalCenter: parent.horizontalCenter
              title: tabTitle
              number: index + 1
              selected: !root.showingPrevious && root.selectedSessionId === tabId
              online: root.online
              wakeCount: tabWakeCount
              running: tabRunning
              unread: root.unreadSessionIds[tabId] === true
              animationsEnabled: root.animationsEnabled
              foreground: root.foreground
              muted: root.muted
              accent: root.accent
              selection: root.selection
              tooltipBackground: root.tooltipBackground
              tooltipForeground: root.tooltipForeground
              tooltipBorder: root.tooltipBorder
              fontFamily: root.fontFamily
              unit: root.unit
              dragEnabled: root.canMoveSessions
              opacity: root.draggingSessionId === tabId ? 0.55 : 1
              onDragStarted: root.beginDrag(tabId)
              onDragMoved: (sceneX, sceneY) => root.updateDrag(tabId, sceneX, sceneY)
              onDragFinished: root.finishDrag()
              onDragCancelled: root.cancelDrag()
              Rectangle {
                width: parent.width
                height: 3 * root.unit
                color: root.accent
                visible: root.dragDestinationValid && root.dragBeforeId === tabId
              }
              onSelectedRequested: root.sessionSelected(tabId)
              onCloseRequested: root.dismissSessionRequested(tabId)
            }
          }
        }
        Rectangle {
          x: 8 * root.tabUnit
          y: tabs.height
          width: rail.width - 16 * root.tabUnit
          height: 3 * root.unit
          color: root.accent
          visible: root.dragDestinationValid && root.dragBeforeId === ""
        }
      }

      Rectangle {
        objectName: "previousSessionsButton"
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 12 * root.tabUnit
        x: 8 * root.tabUnit
        width: rail.width - 16 * root.tabUnit
        height: 60 * root.tabUnit
        radius: 5 * root.tabUnit
        color: root.showingPrevious || previousMouse.containsMouse ? root.selection : "transparent"
        Rectangle {
          objectName: "previousSelectionMarker"
          visible: root.showingPrevious
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          anchors.topMargin: 6 * root.tabUnit
          anchors.bottomMargin: 6 * root.tabUnit
          width: 3 * root.tabUnit
          radius: width / 2
          color: root.accent
        }
        Text {
          anchors.centerIn: parent
          objectName: "previousSessionsLabel"
          text: "◷\nPrevious\nsessions"
          horizontalAlignment: Text.AlignHCenter
          color: root.showingPrevious ? root.accent : root.muted
          font.family: root.fontFamily
          font.pixelSize: 9 * root.tabUnit
          lineHeight: 1.2
        }
        MouseArea {
          id: previousMouse
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.previousRequested()
        }
        Accessible.role: Accessible.PageTab
        Accessible.name: "Previous sessions"
        Accessible.selected: root.showingPrevious
        Accessible.onPressAction: root.previousRequested()
      }
    }
  }

  // A generous hit target straddles the thin divider. Pointer coordinates are
  // mapped to the stable root, so resizing cannot feed back into drag distance.
  MouseArea {
    id: railDivider
    objectName: "railDivider"
    x: rail.width - width / 2
    width: 10 * root.unit
    height: parent.height
    z: 5
    hoverEnabled: true
    preventStealing: true
    cursorShape: Qt.SplitHCursor
    onPositionChanged: mouse => {
      if (pressed) {
        const point = mapToItem(root, mouse.x, mouse.y)
        root.railWidthUnits = Math.max(80, Math.min(point.x, root.maximumRailWidth) / root.unit)
      }
    }
    Rectangle {
      anchors.horizontalCenter: parent.horizontalCenter
      width: (railDivider.containsMouse || railDivider.pressed ? 3 : 1) * root.unit
      height: parent.height
      color: railDivider.containsMouse || railDivider.pressed ? root.accent : root.selection
    }
    Accessible.role: Accessible.Grip
    Accessible.name: "Resize session rail"
  }

  Item {
    id: body
    readonly property real contentTop: 44 * root.unit + (actionError.visible ? actionError.height + 12 * root.unit : 0)
    readonly property real contentHeight: Math.max(0, height - contentTop)
    // A pinned page shares this area with the Activity strip, the chat's
    // measured input and controls and a readable transcript (all of which grow
    // with text zoom), plus both gaps. Those win; the page gets the rest, but
    // never less than its status strip, which keeps Unpin and Close in reach.
    // Computed while the owner is not shown too, so a returning page keeps
    // its size and layout.
    readonly property real browserPinMaximumHeight: Math.max(0, contentHeight - chat.minimumHeight
      - 12 * root.unit - activityStrip.height - 12 * root.unit)
    readonly property real browserPinHeight: Math.max(browserLoader.item ? browserLoader.item.chromeHeight : 0,
      Math.min(contentHeight * root.browserPinPercent / 100, browserPinMaximumHeight))
    // Where the page below a pin (widget or browser) starts.
    readonly property real pinBottom: pinned.visible ? pinned.y + pinned.height + 12 * root.unit
      : root.browserPinVisible ? browserLoader.y + browserLoader.height + 12 * root.unit
      : contentTop
    anchors.left: rail.right
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.margins: 20 * root.unit
    anchors.bottomMargin: 20 * root.unit + (modelPicker.visible ? modelPicker.height : 0)

    Text {
      anchors.top: parent.top
      width: Math.max(0, parent.width - 38 * root.unit - (browserButton.visible ? browserButton.width + 6 * root.unit : 0)
        - (conversationControls.visible ? conversationControls.width + 6 * root.unit : 0))
      text: root.browsing ? "Browser" : root.showingPrevious ? "Previous sessions" : root.selectedSession ? root.selectedSession.title : "Companion"
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: 16 * root.unit
    }

    Rectangle {
      id: closeButton
      objectName: "closeButton"
      anchors.top: parent.top
      anchors.topMargin: -6 * root.unit
      anchors.right: parent.right
      width: 30 * root.unit
      height: width
      color: closeMouse.containsMouse ? root.selection : "transparent"

      Text {
        anchors.centerIn: parent
        text: "×"
        color: closeMouse.containsMouse ? root.accent : root.muted
        font.family: root.fontFamily
        font.pixelSize: 22 * root.unit
      }

      MouseArea {
        id: closeMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.closeRequested()
      }

      Accessible.role: Accessible.Button
      Accessible.name: "Close Companion panel"
      Accessible.onPressAction: root.closeRequested()
    }

    PanelAction {
      id: browserButton
      objectName: "panelBrowserButton"
      visible: root.browserAvailable && !root.browsing
      anchors.top: parent.top
      anchors.topMargin: -4 * root.unit
      anchors.right: closeButton.left
      anchors.rightMargin: 6 * root.unit
      text: "Browser"
      foreground: root.foreground
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      onTriggered: root.openBrowser()
      Accessible.name: root.browserPinVisible ? "Show the pinned page in the full panel" : "Open the panel browser"
    }

    // The conversation's own header controls: timers (only when something is
    // pending, running or needs attention) and a menu for secondary actions.
    // Both open bounded overlays that never move the transcript.
    Row {
      id: conversationControls
      objectName: "conversationControls"
      readonly property bool active: root.selectedSession !== null && !root.browsing && !root.showingPrevious
      visible: active && (timerControl.shown || timerControl.opened || conversationMenu.items.length > 0)
      anchors.top: parent.top
      anchors.topMargin: -4 * root.unit
      anchors.right: browserButton.visible ? browserButton.left : closeButton.left
      anchors.rightMargin: 6 * root.unit
      spacing: 4 * root.unit
      TimerControl {
        id: timerControl
        session: conversationControls.active ? root.selectedSession : null
        online: root.online
        compact: body.width < 320 * root.unit
        // Below the header and any control error, within the conversation area.
        overlayTop: body.contentTop - conversationControls.y
        overlayRightInset: body.width - conversationControls.x - x - width
        maximumWidth: body.width
        maximumHeight: Math.max(0, body.height - body.contentTop - 8 * root.unit)
        background: root.background
        foreground: root.foreground
        muted: root.muted
        accent: root.accent
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onCancelRequested: (id, timerId) => root.cancelWakeRequested(id, timerId)
      }
      ConversationMenu {
        id: conversationMenu
        items: {
          const entries = []
          if (!conversationControls.active) return entries
          if (timerControl.historyCount > 0) entries.push({id: "timers", text: "Timer history · " + timerControl.historyCount})
          if (chat.readingHistory) entries.push({id: "refresh", text: "Refresh loaded messages"})
          return entries
        }
        background: root.background
        foreground: root.foreground
        muted: root.muted
        accent: root.accent
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: id => {
          if (id === "timers") timerControl.openHistory()
          else if (id === "refresh") chat.refreshHistory()
        }
      }
    }

    Text {
      id: actionError
      objectName: "sessionControlError"
      y: 38 * root.unit
      width: parent.width
      visible: text !== ""
      text: root.controlError
      textFormat: Text.PlainText
      color: "#ef5350"
      wrapMode: Text.Wrap
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    ActivityStrip {
      id: activityStrip
      objectName: "activityStrip"
      visible: !root.browsing && (root.selectedSession !== null || root.showingPrevious)
        && !root.fullWidget && !(root.pinnedMessage && root.pinnedMessage.widget.presentation.replaceActivity)
      y: body.pinBottom
      width: parent.width
      online: root.online
      paused: root.paused
      pauseReason: root.pauseReason
      speaking: root.speaking
      microphoneRecording: root.microphoneRecording
      processing: root.processing
      history: root.history
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      animationsEnabled: root.animationsEnabled
    }

    Item {
      id: pinned
      objectName: "pinnedWidgetArea"
      visible: root.pinnedMessage !== null && !root.browsing
      y: body.contentTop
      width: parent.width
      // Below 100%, the requested percentage yields to the measured input,
      // controls and a readable transcript. Activity and both gaps also consume
      // this shared area; subtract them before allocating any widget space.
      height: !root.pinnedMessage ? 0 : root.fullWidget ? body.contentHeight : Math.min(
        body.contentHeight * root.pinnedMessage.widget.presentation.heightPercent / 100,
        Math.max(0, body.contentHeight - chat.minimumHeight - 12 * root.unit
          - (activityStrip.visible ? activityStrip.height + 12 * root.unit : 0)))
      Row {
        id: widgetControls
        spacing: 8 * root.unit
        PanelAction {
          objectName: "widgetBackToChat"
          text: root.fullWidget ? "Back to chat" : "Unpin"
          foreground: root.foreground
          selection: root.selection
          fontFamily: root.fontFamily
          unit: root.unit
          onTriggered: root.backToChat()
        }
        PanelAction {
          objectName: "widgetStopSession"
          visible: root.selectedSession !== null && (root.selectedSession.status === "running" || root.selectedSession.status === "starting")
          text: "Stop"
          foreground: root.foreground
          selection: root.selection
          fontFamily: root.fontFamily
          unit: root.unit
          onTriggered: root.stopSessionRequested(root.selectedSessionId)
        }
        // Escape from a browser pin that waits behind this widget.
        PanelAction {
          objectName: "browserPinSuspendedUnpin"
          visible: root.browserPinSuspended
          text: "Unpin browser"
          foreground: root.foreground
          selection: root.selection
          fontFamily: root.fontFamily
          unit: root.unit
          onTriggered: root.unpinBrowser()
          Accessible.name: "Unpin the browser page waiting behind this widget"
        }
      }
      Text {
        objectName: "browserPinSuspendedNote"
        visible: root.browserPinSuspended
        anchors.left: widgetControls.right
        anchors.leftMargin: 8 * root.unit
        anchors.right: parent.right
        anchors.verticalCenter: widgetControls.verticalCenter
        text: "The pinned browser page waits until this widget is unpinned."
        textFormat: Text.PlainText
        elide: Text.ElideRight
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 11 * root.unit
      }
      WidgetSurface {
        id: pinnedSurface
        nativeRendering: root.nativeWidgets
        objectName: "pinnedWidget"
        anchors.fill: parent
        anchors.topMargin: widgetControls.height + 6 * root.unit
        reference: root.pinnedMessage ? root.pinnedMessage.widget : null
        summary: root.pinnedMessage ? root.pinnedMessage.text : ""
        fitContent: false
        running: visible && root.online && root.animationsEnabled
        foreground: root.foreground
        muted: root.muted
        accent: root.accent
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        textScale: chat.textScale
      }
    }

    PreviousSessionsView {
      visible: root.showingPrevious && !root.browsing
      anchors.fill: parent
      anchors.topMargin: activityStrip.y + activityStrip.height + 12 * root.unit
      sessions: root.previousSessions
      online: root.online
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      textScale: chat.textScale
      onReopenRequested: id => root.reopenSessionRequested(id)
    }

    ActivityView {
      id: activityView
      textInputAvailable: root.textInputAvailable
      onUtteranceRequested: text => root.utteranceRequested(text)
      objectName: "fullActivityStatus"
      visible: !root.showingPrevious && root.selectedSession === null && !root.browsing
      anchors.fill: parent
      anchors.topMargin: 48 * root.unit + (actionError.visible ? actionError.height + 12 * root.unit : 0)
      online: root.online
      paused: root.paused
      pauseReason: root.pauseReason
      speaking: root.speaking
      microphoneRecording: root.microphoneRecording
      processing: root.processing
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit
      textScale: chat.textScale
      animationsEnabled: root.animationsEnabled && visible
      history: root.history
      intents: root.intents
      transcriptionCleanup: root.transcriptionCleanup
      captureStorage: root.captureStorage
      sessionControls: root.sessionControls
      activityHistoryModel: root.activityHistoryModel
      activityHistoryAvailable: root.activityHistoryAvailable
      historyDeletionAvailable: root.historyDeletionAvailable
      selection: root.selection
      shortcutLabel: root.shortcutLabel
      onIntentEnabledRequested: (name, enabled, mode) => root.intentEnabledRequested(name, enabled, mode)
      onTranscriptionCleanupRequested: enabled => root.transcriptionCleanupRequested(enabled)
      onCaptureStorageRequested: enabled => root.captureStorageRequested(enabled)
      onHistoryActionRequested: (action, id, value) => root.historyActionRequested(action, id, value)
    }

    SessionView {
      id: chat
      nativeWidgets: root.nativeWidgets
      objectName: "sessionView"
      visible: root.selectedSession !== null && !root.fullWidget && !root.browsing
      widgetsRunning: root.online && root.animationsEnabled
      choiceHeightLimit: Math.max(48 * root.unit, Math.min(180 * root.unit,
        (root.pinnedMessage || root.browserPinned ? body.contentHeight : chat.height) * 0.3))
      anchors.fill: parent
      anchors.topMargin: root.fullWidget ? body.contentTop : Math.min(body.height, activityStrip.visible ? activityStrip.y + activityStrip.height + 12 * root.unit
        : body.pinBottom)
      session: root.selectedSession
      background: root.background
      agentActions: root.agentActions
      paused: root.paused
      online: root.online
      focusShortcut: root.focusShortcut
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      onScreenshotRequested: (source, title) => root.screenshotRequested(source, title)
      openableOrigins: root.openableOrigins
      onOriginRequested: (id, groupId) => root.openOrigin(id, groupId)
      onStopRequested: id => root.stopSessionRequested(id)
      onDismissRequested: id => root.dismissSessionRequested(id)
      onSendRequested: (id, text) => root.sendSessionRequested(id, text)
      recordingAvailable: root.recordingAvailable
      recording: root.recording
      onRecordRequested: (id, draftLength) => root.recordRequested(id, draftLength)
      onStopRecordingRequested: id => root.stopRecordingRequested(id)
      onToolPageRequested: request => root.toolPageRequested(request)
      onChoiceRequested: (id, revision, index) => root.choiceRequested(id, revision, index)
      onStopRunRequested: (id, runId) => root.stopRunRequested(id, runId)
    }

    // Drag (or, when focused, Up/Down) to change the pin's height. It sits in
    // the gap below the page; pointer positions are mapped to the stable body,
    // so the moving grip cannot feed back into the drag. Declared before the
    // browser, so a revealed toolbar that extends below a short pin stays on
    // top of it.
    MouseArea {
      id: browserPinResize
      objectName: "browserPinResize"
      visible: root.browserPinVisible
      x: 0
      y: browserLoader.y + browserLoader.height
      width: parent.width
      height: 12 * root.unit
      hoverEnabled: true
      preventStealing: true
      activeFocusOnTab: true
      cursorShape: Qt.SplitVCursor
      onPositionChanged: mouse => {
        if (pressed) {
          const point = mapToItem(body, mouse.x, mouse.y)
          root.resizeBrowserPin(point.y - body.contentTop)
        }
      }
      Keys.onUpPressed: root.stepBrowserPin(-5)
      Keys.onDownPressed: root.stepBrowserPin(5)
      Rectangle {
        anchors.centerIn: parent
        readonly property bool active: browserPinResize.containsMouse || browserPinResize.pressed || browserPinResize.activeFocus
        width: Math.min(parent.width, 48 * root.unit)
        height: (active ? 3 : 1) * root.unit
        radius: height / 2
        color: active ? root.accent : root.selection
      }
      Accessible.role: Accessible.Grip
      Accessible.name: "Resize the pinned browser page"
      Accessible.description: Math.round(100 * browserLoader.height / Math.max(1, body.contentHeight)) + "% of the panel"
    }

    // Loaded by URL, not by type, so hosts without Qt WebEngine never compile
    // it. Once started it stays loaded (hidden while not shown), keeping its
    // page and profile across tab changes, reconnects and presentation moves.
    // The full browser and the pin are two geometries of this one item; a
    // hidden item freezes and mutes its page.
    Loader {
      id: browserLoader
      objectName: "panelBrowserLoader"
      active: root.browserAvailable && root.browserStarted
      visible: root.browserShown
      x: 0
      y: body.contentTop
      width: parent.width
      height: root.browserPinned ? body.browserPinHeight : body.contentHeight
      source: active ? root.browserSource : ""
      onLoaded: {
        item.foreground = Qt.binding(function() { return root.foreground })
        item.muted = Qt.binding(function() { return root.muted })
        item.accent = Qt.binding(function() { return root.accent })
        item.selection = Qt.binding(function() { return root.selection })
        item.background = Qt.binding(function() { return root.background })
        item.fontFamily = Qt.binding(function() { return root.fontFamily })
        item.unit = Qt.binding(function() { return root.unit })
        item.shown = Qt.binding(function() { return root.browserShown })
        item.pinned = Qt.binding(function() { return root.browserPinned })
        item.returnRequested.connect(root.closeBrowser)
        item.pinRequested.connect(root.pinBrowser)
        item.unpinRequested.connect(root.unpinBrowser)
        item.pageClosed.connect(root.unpinBrowser)
        item.answerRequested.connect(root.answerInFullBrowser)
        item.pendingDialogChanged.connect(root.browserDialogChanged)
      }
    }
    Text {
      objectName: "panelBrowserUnavailable"
      visible: root.browsing && browserLoader.status === Loader.Error
      anchors.fill: browserLoader
      text: "The panel browser needs Qt WebEngine 6.9 or newer. Choose a conversation or Activity to return."
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      horizontalAlignment: Text.AlignHCenter
      verticalAlignment: Text.AlignVCenter
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 12 * root.unit
    }
  }

  ModelPicker {
    id: modelPicker
    objectName: "sessionModelFooter"
    visible: !root.browsing && root.selectedSession !== null && root.sessionControls !== null && root.sessionControls.controlsAvailable
    anchors.left: rail.right
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.leftMargin: 20 * root.unit
    anchors.rightMargin: 20 * root.unit
    session: root.selectedSession
    // Loading and error state follow the selected conversation's catalogue.
    catalog: root.sessionControls ? root.sessionControls.modelCatalog : ({models: []})
    claudeCatalog: root.sessionControls ? root.sessionControls.claudeModelCatalog : ({models: []})
    catalogLoaded: !root.sessionControls ? false : root.selectedClaude ? root.sessionControls.claudeModelsLoaded : root.sessionControls.modelsLoaded
    loading: !root.sessionControls ? false : root.selectedClaude ? root.sessionControls.claudeModelsLoading : root.sessionControls.modelsLoading
    error: !root.sessionControls ? "" : root.selectedClaude ? root.sessionControls.claudeModelsError : root.sessionControls.modelsError
    online: root.online
    background: root.background
    foreground: root.foreground
    muted: root.muted
    selection: root.selection
    fontFamily: root.fontFamily
    unit: root.unit
    onRefreshRequested: root.refreshModels()
    onModelRequested: (id, model) => root.sessionControls.controlRequested({action: "set-agent-model", id: id, model: model})
    onThinkingRequested: (id, thinking) => root.sessionControls.controlRequested({action: "set-agent-thinking", id: id, thinking: thinking})
  }
}
