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
  property var activityHistoryModel: null
  property bool activityHistoryAvailable: false
  property bool historyDeletionAvailable: false
  property bool textInputAvailable: false
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
  property string controlError: ""
  property string selectedSessionId: ""
  // A source conversation may have been closed. Its restored tab arrives in a
  // later snapshot, so retain the requested ID until it becomes selectable.
  property string pendingOriginId: ""
  property string pendingOriginGroupId: ""
  onSelectedSessionIdChanged: Qt.callLater(ensureSelectedVisible)
  readonly property bool modelsNeeded: online && selectedSession !== null && sessionControls !== null && sessionControls.controlsAvailable
  onModelsNeededChanged: if (modelsNeeded) Qt.callLater(ensureModels)
  onSessionControlsChanged: Qt.callLater(ensureModels)
  function ensureModels() {
    if (root.modelsNeeded) root.sessionControls.ensureModels()
  }
  function refreshModels() {
    if (root.modelsNeeded) root.sessionControls.refreshModels()
  }
  readonly property var selectedSession: !showingPrevious && sessions.find(entry => entry.id === selectedSessionId) || null
  property var locallyUnpinned: ({})
  readonly property var pinnedMessage: selectedSession && selectedSession.messages.find(message =>
    message.widget && message.widget.viewUrl && message.widget.presentation.placement === "pinned"
      && !root.isLocallyUnpinned(message.widget)) || null
  readonly property bool fullWidget: pinnedMessage !== null && pinnedMessage.widget.presentation.heightPercent === 100
  readonly property bool inputFocused: root.keyboardFocused && (root.composerFocusId !== "" || activityView.inputFocused)
  readonly property string composerFocusId: fullWidget ? "" : chat.composerFocusId
  onFullWidgetChanged: if (fullWidget) chat.releaseComposerFocus()
  readonly property bool keyboardFocused: root.Window.window !== null && root.Window.window.active
  // Activity and the session library share the conversation's reader zoom.
  // Keep geometry in theme units; only text and its measured layout grow.
  property alias zoomPercent: chat.zoomPercent
  readonly property bool pageZoomEnabled: root.visible && root.animationsEnabled && root.keyboardFocused && (root.selectedSession === null || root.fullWidget)

  // Activity has its own explicit text submission, never an agent composer
  // or an automatic dictation destination. Clear the hidden composer when leaving a conversation.
  onSelectedSessionChanged: {
    if (selectedSession === null) {
      chat.releaseComposerFocus()
      if (root.keyboardFocused) root.forceActiveFocus(Qt.TabFocusReason)
    } else if (selectedSession.id === root.pendingOriginId) {
      const groupId = root.pendingOriginGroupId
      root.pendingOriginId = ""
      root.pendingOriginGroupId = ""
      if (groupId) Qt.callLater(function() { chat.jumpToToolGroup(groupId) })
    }
  }

  signal utteranceRequested(string text)
  signal closeRequested()
  signal intentEnabledRequested(string name, bool enabled, string mode)
  signal historyActionRequested(string action, string id, var value)
  signal sessionSelected(string id)
  signal previousRequested()
  signal reopenSessionRequested(string id)
  signal screenshotRequested(url source, string title)
  signal stopSessionRequested(string id)
  signal dismissSessionRequested(string id)
  signal sendSessionRequested(string id, string text)
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
  function focusComposer() {
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
    synchronizeTabs()
    const dismissed = Object.assign({}, root.locallyUnpinned)
    for (const id of Object.keys(dismissed)) {
      const stillPinned = root.sessions.some(session => session.messages.some(message =>
        message.widget && message.widget.id === id && root.isLocallyUnpinned(message.widget)
          && message.widget.presentation.placement === "pinned"))
      if (!stillPinned) delete dismissed[id]
    }
    root.locallyUnpinned = dismissed
    if (root.pendingOriginId && root.sessions.some(entry => entry.id === root.pendingOriginId)) {
      root.sessionSelected(root.pendingOriginId)
    }
  }

  function isLocallyUnpinned(reference) {
    const dismissed = root.locallyUnpinned[reference.id]
    return dismissed && dismissed.viewUrl === reference.viewUrl && reference.revision <= dismissed.revision
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

  function openOrigin(id, groupId) {
    if (!id || !root.online) return
    if (root.sessions.some(entry => entry.id === id) || root.previousSessions.some(entry => entry.id === id)) {
      root.pendingOriginId = id
      root.pendingOriginGroupId = groupId
      if (root.sessions.some(entry => entry.id === id)) root.sessionSelected(id)
      else root.reopenSessionRequested(id)
    }
  }

  function selectConversation(id) {
    root.pendingOriginId = ""
    root.pendingOriginGroupId = ""
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

        Rectangle {
          width: 2 * root.tabUnit
          height: parent.height
          color: !root.showingPrevious && root.selectedSession === null ? root.accent : "transparent"
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
              required property bool tabRunning
              required property int index
              objectName: "tab-" + tabId
              width: rail.width - 16 * root.tabUnit
              anchors.horizontalCenter: parent.horizontalCenter
              title: tabTitle
              number: index + 1
              selected: !root.showingPrevious && root.selectedSessionId === tabId
              online: root.online
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
    anchors.left: rail.right
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.margins: 20 * root.unit
    anchors.bottomMargin: 20 * root.unit + (modelPicker.visible ? modelPicker.height : 0)

    Text {
      anchors.top: parent.top
      width: parent.width - 38 * root.unit
      text: root.showingPrevious ? "Previous sessions" : root.selectedSession ? root.selectedSession.title : "Companion"
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
      visible: (root.selectedSession !== null || root.showingPrevious)
        && !root.fullWidget && !(root.pinnedMessage && root.pinnedMessage.widget.presentation.replaceActivity)
      y: pinned.visible ? pinned.y + pinned.height + 12 * root.unit : body.contentTop
      width: parent.width
      online: root.online
      paused: root.paused
      pauseReason: root.pauseReason
      speaking: root.speaking
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
      visible: root.pinnedMessage !== null
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
      visible: root.showingPrevious
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
      visible: !root.showingPrevious && root.selectedSession === null
      anchors.fill: parent
      anchors.topMargin: 48 * root.unit + (actionError.visible ? actionError.height + 12 * root.unit : 0)
      online: root.online
      paused: root.paused
      pauseReason: root.pauseReason
      speaking: root.speaking
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
      activityHistoryModel: root.activityHistoryModel
      activityHistoryAvailable: root.activityHistoryAvailable
      historyDeletionAvailable: root.historyDeletionAvailable
      selection: root.selection
      shortcutLabel: root.shortcutLabel
      onIntentEnabledRequested: (name, enabled, mode) => root.intentEnabledRequested(name, enabled, mode)
      onHistoryActionRequested: (action, id, value) => root.historyActionRequested(action, id, value)
    }

    SessionView {
      id: chat
      nativeWidgets: root.nativeWidgets
      objectName: "sessionView"
      visible: root.selectedSession !== null && !root.fullWidget
      widgetsRunning: root.online && root.animationsEnabled
      choiceHeightLimit: Math.max(48 * root.unit, Math.min(180 * root.unit,
        (root.pinnedMessage ? body.contentHeight : chat.height) * 0.3))
      anchors.fill: parent
      anchors.topMargin: root.fullWidget ? body.contentTop : Math.min(body.height, activityStrip.visible ? activityStrip.y + activityStrip.height + 12 * root.unit
        : pinned.visible ? pinned.y + pinned.height + 12 * root.unit : body.contentTop)
      session: root.selectedSession
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
      onOriginRequested: (id, groupId) => root.openOrigin(id, groupId)
      onStopRequested: id => root.stopSessionRequested(id)
      onDismissRequested: id => root.dismissSessionRequested(id)
      onSendRequested: (id, text) => root.sendSessionRequested(id, text)
      onToolPageRequested: request => root.toolPageRequested(request)
      onChoiceRequested: (id, revision, index) => root.choiceRequested(id, revision, index)
      onStopRunRequested: (id, runId) => root.stopRunRequested(id, runId)
    }

  }

  ModelPicker {
    id: modelPicker
    objectName: "sessionModelFooter"
    visible: root.selectedSession !== null && root.sessionControls !== null && root.sessionControls.controlsAvailable
    anchors.left: rail.right
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.leftMargin: 20 * root.unit
    anchors.rightMargin: 20 * root.unit
    session: root.selectedSession
    catalog: root.sessionControls ? root.sessionControls.modelCatalog : ({models: []})
    catalogLoaded: root.sessionControls ? root.sessionControls.modelsLoaded : false
    loading: root.sessionControls ? root.sessionControls.modelsLoading : false
    error: root.sessionControls ? root.sessionControls.modelsError : ""
    online: root.online
    background: root.background
    foreground: root.foreground
    muted: root.muted
    selection: root.selection
    fontFamily: root.fontFamily
    unit: root.unit
    onRefreshRequested: root.refreshModels()
    onModelRequested: (id, model) => root.sessionControls.controlRequested({action: "set-agent-model", id: id, model: model})
  }
}
