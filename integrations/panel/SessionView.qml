import QtQuick
import QtQuick.Controls
import QtQuick.Window
import "Markdown.mjs" as Markdown

// Chat rendering is independent of Pi and Omarchy. Stable ListModel rows keep
// selection and expanded tool bubbles intact while text deltas update a row.
Item {
  id: root
  clip: true
  required property var session
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  // Shell chrome may be monospace (Omarchy's default). Conversation text needs
  // its own proportional face so Markdown's native code font stays distinct.
  property string proseFontFamily: {
    const available = Qt.fontFamilies()
    return ["Adwaita Sans", "Inter", "Segoe UI", "Noto Sans"].find(name => available.includes(name)) || "sans-serif"
  }
  property bool online: true
  property bool paused: false
  property var agentActions: ({})
  property var pendingChoice: null
  readonly property bool actionsCurrent: session !== null && agentActions.sessionId === session.id
  // The desktop host supplies the shortcut; other hosts can leave it unset.
  property string focusShortcut: ""
  property real unit: 1
  // One zoom level follows the reader between tabs for this panel lifetime.
  property int zoomPercent: 100
  property real scrollSpeed: 3
  readonly property real textScale: root.unit * root.zoomPercent / 100
  // The host can budget choices against its available area before allocating a
  // pin. Using the resulting chat height for that budget would create a layout
  // cycle: pin height -> chat height -> choices -> minimum chat -> pin height.
  property real choiceHeightLimit: Math.max(48 * root.unit, Math.min(180 * root.unit, root.height * 0.3))
  readonly property real minimumHeight: inputSection.implicitHeight + 12 * root.unit + 96 * root.textScale
  readonly property bool composerReachable: root.visible && root.width > 0 && root.height >= inputSection.height
  onComposerReachableChanged: if (!composerReachable) root.releaseComposerFocus()
  readonly property bool zoomEnabled: visible && session !== null && root.Window.window !== null && root.Window.window.active
  property string displayedId: ""
  property bool followEnd: true
  property var drafts: ({})
  // One historical page, separate from the continuously updated recent window.
  // Never accumulate all pages or feed a page back into authoritative state.
  property var historyPage: null
  property var previousLive: null
  property string historyPending: ""
  property string historyError: ""
  property var historyRequest: null
  readonly property var shownHistory: historyPage ? historyPage.history : session ? session.history : null
  readonly property bool hasOlder: shownHistory !== null && shownHistory !== undefined && (shownHistory.start.index > 0 || shownHistory.start.offset > 0)
  readonly property bool historyChanged: historyPage !== null && session && session.history && historyPage.history.revision !== session.history.revision
  // Conversation id -> title of the agent conversation that drafted its unsent
  // text. Cleared when that composer becomes empty or its message is sent.
  property var draftSources: ({})
  // Sender conversation ID -> true when an agent heading can open it.
  property var openableOrigins: ({})
  readonly property string displayedDraftSource: composer.text !== "" && root.draftSources[root.displayedId] !== undefined
    ? root.draftSources[root.displayedId] : ""
  property var pendingSubmission: null
  property string inputError: ""
  property var selectedMessage: null
  property var hoveredWidget: null
  property bool widgetsRunning: true
  property bool nativeWidgets: false
  readonly property bool hasMessageSelection: selectedMessage !== null && selectedMessage.visible && selectedMessage.selectedText !== ""
  readonly property bool running: session && (session.status === "starting" || session.status === "running")
  readonly property int messageCount: messages.count
  readonly property bool canSend: online && session !== null && pendingSubmission === null
    && pendingChoice === null
    && composer.text.trim().length > 0 && composer.text.length <= 4000
  readonly property string composerFocusId: online && composerReachable && composer.activeFocus
    && root.Window.window && root.Window.window.active ? displayedId : ""
  signal toolPageRequested(var request)
  signal toolPageReceived(var message)
  signal stopRequested(string id)
  signal dismissRequested(string id)
  signal sendRequested(string id, string text)
  signal choiceRequested(string id, string revision, int index)
  signal stopRunRequested(string id, string runId)
  signal screenshotRequested(url source, string title)
  signal originRequested(string sessionId, string groupId)

  function loadHistory(direction, position, anchor, refresh) {
    if (!root.online || !root.session || !root.session.history || root.historyPending) return
    root.historyError = ""
    root.historyPending = "history-" + Date.now() + "-" + Math.random().toString(36).slice(2)
    root.historyRequest = {id: root.displayedId, epoch: root.session.toolEpoch,
      direction: direction, anchor: anchor || "", refresh: refresh === true, y: transcript.contentY}
    historyDeadline.restart()
    const request = {action: "agent-history-page", requestId: root.historyPending,
      id: root.displayedId, epoch: root.session.toolEpoch, direction: direction,
      index: position.index, offset: position.offset}
    if (anchor) request.anchor = anchor
    root.toolPageRequested(request)
  }

  function latestHistory() {
    root.historyPending = ""
    root.historyRequest = null
    historyDeadline.stop()
    root.historyPage = null
    root.historyError = ""
    root.followEnd = true
    root.synchronize()
  }

  onToolPageReceived: reply => {
    if (reply.action !== "agent-history-page" || !root.historyPending || reply.requestId !== root.historyPending) return
    const request = root.historyRequest
    root.historyPending = ""
    historyDeadline.stop()
    if (!root.session || request.id !== root.displayedId || request.epoch !== root.session.toolEpoch) return
    if (reply.type === "error") { root.historyError = reply.message || "History unavailable"; return }
    const page = reply.result
    if (!page || page.id !== request.id || page.epoch !== request.epoch) return
    root.followEnd = false
    root.historyPage = page
    root.synchronize()
    Qt.callLater(function() {
      if (root.historyPage !== page) return
      transcript.forceLayout()
      if (request.anchor) root.jumpToToolGroup(request.anchor)
      else if (request.refresh) transcript.contentY = Math.max(transcript.originY, Math.min(request.y, transcript.originY + Math.max(0, transcript.contentHeight - transcript.height)))
      else if (request.direction === "before") transcript.positionViewAtEnd()
      else transcript.positionViewAtBeginning()
    })
  }

  Timer {
    id: historyDeadline
    interval: 10000
    onTriggered: { root.historyPending = ""; root.historyError = "History request timed out; try again." }
  }

  function zoomBy(amount) { root.zoomPercent = Math.max(80, Math.min(200, root.zoomPercent + amount)) }

  function clearMessageSelection() {
    const previous = root.selectedMessage
    root.selectedMessage = null
    if (previous) previous.deselect()
  }

  function messageSelectionChanged(item) {
    if (item.selectedText !== "") {
      if (root.selectedMessage !== item) root.clearMessageSelection()
      root.selectedMessage = item
      composer.deselect()
    } else if (root.selectedMessage === item) {
      root.selectedMessage = null
    }
  }

  function copySelectedMessage() {
    if (!root.hasMessageSelection) return false
    root.selectedMessage.copy()
    return true
  }

  // A hidden plain-text buffer copies a whole message without moving keyboard
  // focus or disturbing the reader's selection. Assistant copies keep Markdown.
  TextEdit { id: copyBuffer; visible: false; textFormat: TextEdit.PlainText }
  function copyMessage(text) {
    copyBuffer.text = text
    copyBuffer.selectAll()
    copyBuffer.copy()
    copyBuffer.text = ""
  }

  // Window shortcuts also work while text is selected or the composer owns
  // focus. They never register with the compositor or affect other apps.
  Shortcut {
    sequences: [StandardKey.Copy]
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled && root.hasMessageSelection
    onActivated: root.copySelectedMessage()
  }
  Shortcut {
    sequences: ["Ctrl++", "Ctrl+=", "Ctrl+Shift++"]
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomBy(10)
  }
  Shortcut {
    sequence: "Ctrl+-"
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomBy(-10)
  }
  Shortcut {
    sequence: "Ctrl+0"
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomPercent = 100
  }

  function focusComposer() {
    if (root.online && root.composerReachable && root.session) composer.forceActiveFocus(Qt.ShortcutFocusReason)
  }

  function releaseComposerFocus() { composer.focus = false }

  function submit() {
    if (!root.canSend) return
    root.inputError = ""
    root.pendingSubmission = {id: root.session.id, text: composer.text}
    root.sendRequested(root.session.id, composer.text)
  }

  function submitted(id, text, error) {
    if (!root.pendingSubmission || root.pendingSubmission.id !== id || root.pendingSubmission.text !== text) return
    root.pendingSubmission = null
    root.inputError = error || ""
    if (!error) {
      if (root.drafts[id] === text) {
        delete root.drafts[id]
        root.forgetDraftSource(id)
      }
      if (root.displayedId === id && composer.text === text) composer.text = ""
    }
  }

  function forgetDraftSource(id) {
    if (root.draftSources[id] === undefined) return
    const sources = Object.assign({}, root.draftSources)
    delete sources[id]
    root.draftSources = sources
  }

  // An agent proposes unsent text. It never submits, and never replaces or
  // edits text the user already wrote: that is a conflict unless the agent
  // explicitly asked to append below it. Returns the outcome the listener
  // reports back to the agent. Runs synchronously in the UI event loop, so no
  // keystroke can interleave between reading and writing the composer.
  function applyDraft(request) {
    const id = request.id
    if (root.pendingSubmission && root.pendingSubmission.id === id) {
      return {outcome: "conflict", reason: "A message from that conversation's input is still being sent."}
    }

    const displayed = root.displayedId === id
    const current = displayed ? composer.text : (root.drafts[id] || "")
    let next = request.text
    let outcome = "inserted"
    if (current.trim() !== "") {
      if (request.ifDraftExists !== "append") return {outcome: "conflict", reason: ""}
      next = current + (current.endsWith("\n") ? "\n" : "\n\n") + request.text
      outcome = "appended"
    }
    if (next.length > 4000) {
      return {outcome: "conflict", reason: "The combined draft would exceed 4000 characters."}
    }

    const title = request.source && typeof request.source.title === "string" ? request.source.title : ""
    root.draftSources = Object.assign({}, root.draftSources, {[id]: (request.source && request.source.kind === "external" ? "external (unverified) · " : "") + (title || "another conversation")})
    if (displayed) {
      composer.text = next
      composer.cursorPosition = composer.length
    } else {
      root.drafts[id] = next
    }
    return {outcome: outcome, reason: ""}
  }

  function choiceSubmitted(id, revision, index, error) {
    if (!root.pendingChoice || root.pendingChoice.id !== id || root.pendingChoice.revision !== revision || root.pendingChoice.index !== index) return
    root.pendingChoice = null
    if (root.displayedId === id) root.inputError = error || ""
    // Choosing never edits or clears a freeform draft, including on failure.
  }

  function enterPressed(event) {
    event.accepted = true
    if (event.modifiers & Qt.ShiftModifier) {
      composer.insert(composer.cursorPosition, "\n")
    } else {
      root.submit()
    }
  }

  function followLatestMessage() {
    if (root.followEnd) {
      transcript.positionViewAtEnd()
    }
  }

  // The sender's tool call may be one of several in a collapsed group. Bring
  // that group into view without opening tool details or changing the composer.
  // Align its top edge: an expanded group can be taller than the viewport, and
  // centring it would push the heading being navigated to out of sight.
  function jumpToToolGroup(groupId) {
    const sessionId = root.displayedId
    if (!sessionId || !groupId) return
    for (let index = 0; index < messages.count; index++) {
      if (messages.get(index).messageId !== groupId) continue
      root.followEnd = false
      transcript.positionViewAtIndex(index, ListView.Beginning)
      // Delegate layout can change heights; settle the scroll position once more.
      Qt.callLater(function() {
        if (root.displayedId === sessionId) transcript.positionViewAtIndex(index, ListView.Beginning)
      })
      return
    }
    root.loadHistory("after", {index: 0, offset: 0}, groupId, false)
  }

  function synchronize() {
    const id = root.session ? root.session.id : ""
    if (id !== root.displayedId) {
      root.clearMessageSelection()
      if (root.displayedId) root.drafts[root.displayedId] = composer.text
      messages.clear()
      root.historyPage = null
      root.previousLive = null
      root.historyPending = ""
      root.historyError = ""
      historyDeadline.stop()
      root.displayedId = id
      root.followEnd = true
      composer.text = root.drafts[id] || ""
      root.inputError = ""
    }

    if (root.previousLive && root.session && root.previousLive.toolEpoch !== root.session.toolEpoch) {
      // A reconnect can reveal the same ID reopened by another client. Never
      // freeze rows from the old lifetime under its successor's page token.
      root.clearMessageSelection()
      root.historyPage = null
      root.previousLive = null
      root.historyPending = ""
      root.historyRequest = null
      root.historyError = ""
      root.followEnd = true
      historyDeadline.stop()
    }
    // If a rolling recent window would evict rows while reading, freeze the
    // old bounded page instead of jumping the reader to unrelated content.
    if (!root.historyPage && !root.followEnd && root.previousLive && root.previousLive.history && root.session && root.session.history
        && JSON.stringify(root.previousLive.history.start) !== JSON.stringify(root.session.history.start)) {
      root.historyPage = {id: root.displayedId, epoch: root.session.toolEpoch,
        history: root.previousLive.history, messages: root.previousLive.messages}
    }
    root.previousLive = root.session
    const incoming = root.historyPage ? root.historyPage.messages : root.session ? root.session.messages : []
    for (let index = 0; index < incoming.length; index++) {
      const message = incoming[index]
      const row = {messageId: message.id, kind: message.kind, body: message.text,
        toolName: message.toolName, input: message.input, state: message.state,
        toolCount: message.toolGroup ? message.toolGroup.count : 0,
        toolUnavailable: message.toolGroup ? message.toolGroup.unavailable === true : false,
        toolRevision: message.toolGroup ? message.toolGroup.revision : "",
        screenshot: message.screenshot, screenshotUrl: message.screenshotUrl || "",
        // False only when capture storage deliberately did not save it.
        screenshotNotSaved: message.screenshotSaved === false,
        fromExternal: message.origin ? message.origin.kind === "external" : false,
        fromAgent: message.origin !== undefined && message.origin !== null,
        originTitle: message.origin ? message.origin.title || "" : "",
        // External origins carry unverified labels, never a linkable conversation.
        originSessionId: message.origin && message.origin.kind === "agent" ? message.origin.sessionId || "" : "",
        originGroupId: message.origin && message.origin.kind === "agent" ? message.origin.sourceGroupId || "" : "",
        fragmentLabel: message.historyFragment ? " · text " + (message.historyFragment.start + 1) + "–" + message.historyFragment.end + " of " + message.historyFragment.total : "",
        widgetJson: message.widget ? JSON.stringify(message.widget) : ""}
      if (index >= messages.count || messages.get(index).messageId !== message.id) {
        let existing = -1
        for (let candidate = index + 1; candidate < messages.count; candidate++) {
          if (messages.get(candidate).messageId === message.id) { existing = candidate; break }
        }
        if (existing >= 0) messages.move(existing, index, 1)
        else messages.insert(index, row)
      }
      messages.set(index, row)
    }
    while (messages.count > incoming.length) {
      messages.remove(messages.count - 1)
    }
    Qt.callLater(root.followLatestMessage)
  }

  onSessionChanged: synchronize()
  onOnlineChanged: {
    if (!root.online) {
      root.historyPending = ""
      historyDeadline.stop()
    }
  }
  onVisibleChanged: Qt.callLater(root.followLatestMessage)
  Component.onCompleted: synchronize()
  ListModel { id: messages }

  Column {
    id: historyControls
    width: parent.width
    spacing: 4 * root.unit
    visible: root.hasOlder || root.historyPage !== null || root.historyError !== ""
    height: visible ? implicitHeight : 0
    Flow {
      width: parent.width
      spacing: 6 * root.unit
      Button { objectName: "olderHistory"; text: "Load older"; enabled: root.hasOlder && root.online && !root.historyPending
        onClicked: root.loadHistory("before", root.shownHistory.start, "", false) }
      Button { objectName: "newerHistory"; text: "Newer"; visible: root.historyPage !== null; enabled: !!(root.online && !root.historyPending && root.shownHistory && root.session && root.session.history && (root.shownHistory.end.index < root.session.history.total || root.shownHistory.end.offset > 0))
        onClicked: root.loadHistory("after", root.shownHistory.end, "", false) }
      Button { objectName: "refreshHistory"; text: "Refresh"; visible: root.historyPage !== null; enabled: root.online && !root.historyPending
        onClicked: root.loadHistory("after", root.shownHistory.start, "", true) }
      Button { objectName: "latestHistory"; text: "Latest"; visible: root.historyPage !== null; onClicked: root.latestHistory() }
    }
    Text {
      width: parent.width; wrapMode: Text.Wrap; color: root.muted; font.pixelSize: 11 * root.unit
      text: root.historyError || (root.historyPending ? "Loading history…" : root.historyChanged ? "History page · newer updates available" : root.historyPage ? "History page" : "Recent history")
    }
  }

  ListView {
    id: transcript
    objectName: "sessionTranscript"
    anchors.fill: parent
    anchors.topMargin: historyControls.height + (historyControls.visible ? 8 * root.unit : 0)
    anchors.bottomMargin: inputSection.height + 12 * root.unit
    clip: true
    spacing: 12 * root.unit
    model: messages
    boundsBehavior: Flickable.StopAtBounds
    onMovementEnded: root.followEnd = atYEnd && root.historyPage === null
    onContentHeightChanged: Qt.callLater(root.followLatestMessage)
    onHeightChanged: Qt.callLater(root.followLatestMessage)

    // Handle the transcript's wheel events before selectable message text.
    // Pixel deltas retain precise touchpad motion; wheel notches use the
    // desktop's line count. Both are faster without changing shell-wide input.
    WheelHandler {
      parent: transcript
      target: null
      acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
      onWheel: event => {
        if (root.hoveredWidget && root.hoveredWidget.hovered) { event.accepted = false; return }
        const pixels = event.pixelDelta.y || event.angleDelta.y / 120 * Qt.styleHints.wheelScrollLines * 24 * root.unit
        if (pixels === 0) {
          event.accepted = false
          return
        }

        transcript.cancelFlick()
        root.followEnd = false
        const beginning = transcript.originY
        const end = beginning + Math.max(0, transcript.contentHeight - transcript.height)
        transcript.contentY = Math.max(beginning, Math.min(end, transcript.contentY - pixels * root.scrollSpeed))
        // Changing contentY directly does not emit movementEnded. Update this
        // now, before a queued streaming update can jump back to the bottom.
        root.followEnd = transcript.atYEnd && root.historyPage === null
        event.accepted = true
      }
    }

    ScrollBar.vertical: ScrollBar {
      visible: transcript.contentHeight > transcript.height
      contentItem: Rectangle { color: root.muted; radius: 2; implicitWidth: 4 }
    }

    delegate: Item {
      id: bubble
      required property string messageId
      required property string kind
      required property string body
      required property string toolName
      required property string input
      required property string state
      required property bool screenshot
      required property string screenshotUrl
      required property bool screenshotNotSaved
      required property bool toolUnavailable
      required property int toolCount
      required property string toolRevision
      required property string widgetJson
      required property string fragmentLabel
      // Written by another conversation's agent through session tools.
      required property bool fromExternal
      required property bool fromAgent
      required property string originTitle
      required property string originSessionId
      required property string originGroupId
      readonly property bool originLinked: fromAgent && originSessionId !== ""
        && root.openableOrigins[originSessionId] === true
      readonly property var widget: widgetJson ? JSON.parse(widgetJson) : null
      property bool expanded: false
      property string ownerId: root.displayedId
      property string toolEpoch: root.session ? root.session.toolEpoch || "" : ""
      onMessageIdChanged: expanded = false
      onOwnerIdChanged: expanded = false
      onToolEpochChanged: expanded = false
      objectName: "bubble-" + messageId
      width: transcript.width
      height: bubbleSurface.height

      // A tool heading discloses its calls; a linked agent heading navigates.
      function activateHeading() {
        if (bubble.kind === "tool") {
          bubble.toggleExpanded()
        } else if (bubble.originLinked) {
          root.originRequested(bubble.originSessionId, bubble.originGroupId)
        }
      }

      function toggleExpanded() {
        // Keep the visible answer in place when a group above or crossing the
        // viewport's top edge shrinks. Never anchor to the shrinking group.
        let anchor = null
        if (expanded && toolCount > 0 && !root.followEnd && y < transcript.contentY) {
          const anchorTop = Math.max(transcript.contentY, y + height)
          let index = transcript.indexAt(0, anchorTop + 1)
          if (index < 0) index = transcript.indexAt(0, anchorTop + transcript.spacing + 1)
          anchor = transcript.itemAtIndex(index)
          if (anchor && anchor.y >= transcript.contentY + transcript.height) anchor = null
        }
        const anchorY = anchor ? anchor.y - transcript.contentY : 0
        expanded = !expanded
        if (anchor) {
          // Settle the Column before ListView computes the new content origin.
          contents.forceLayout()
          transcript.forceLayout()
          const beginning = transcript.originY
          const end = beginning + Math.max(0, transcript.contentHeight - transcript.height)
          transcript.contentY = Math.max(beginning, Math.min(end, anchor.y - anchorY))
        }
      }

      Rectangle {
        id: bubbleSurface
        // Keep a subtle 20px gutter opposite the sender, plus 8px for the
        // scrollbar. The full-width row lets ListView position messages vertically
        // without overriding each bubble's horizontal alignment.
        width: Math.max(0, transcript.width - 28 * root.unit)
        x: bubble.kind === "user" ? transcript.width - 8 * root.unit - width : 0
        height: contents.implicitHeight + 20 * root.unit
        radius: 10 * root.unit
        color: bubble.kind === "user" ? root.selection
          : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)

        HoverHandler { id: messageHover }

        Column {
          id: contents
          x: 10 * root.unit
          y: 10 * root.unit
          width: parent.width - 20 * root.unit
          spacing: 8 * root.unit

          Text {
            id: heading
            objectName: "messageHeading"
            width: parent.width - copyButton.width - 8 * root.unit
            height: Math.max(implicitHeight, copyButton.height)
            verticalAlignment: Text.AlignVCenter
            text: bubble.kind === "tool" ? (bubble.expanded ? "▾ " : "▸ ") + (bubble.toolCount ? bubble.toolCount + " tool call" + (bubble.toolCount === 1 ? "" : "s") : bubble.toolName)
              + (bubble.toolUnavailable ? " · details unavailable" : bubble.state === "running" ? " · running" : bubble.state === "error" ? " · failed or stopped" : "")
              : bubble.kind === "user" ? (bubble.fromAgent ? (bubble.fromExternal ? "External agent (unverified) · " : "Agent · ") + (bubble.originTitle || "another conversation") : "You")
                + (bubble.state === "queued" ? " · queued" : bubble.state === "error" ? " · not sent" : "")
                + (bubble.screenshot ? (bubble.screenshotUrl ? " · screenshot attached" : bubble.screenshotNotSaved ? " · screenshot not saved" : " · screenshot unavailable") : "") + bubble.fragmentLabel : "Pi" + bubble.fragmentLabel
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: bubble.originLinked ? root.accent
              : bubble.state === "error" ? "#ef5350" : root.muted
            font.underline: bubble.originLinked && headingMouse.containsMouse
            font.family: root.fontFamily
            font.pixelSize: 10 * root.unit

            MouseArea {
              anchors.fill: parent
              id: headingMouse
              hoverEnabled: true
              enabled: bubble.kind === "tool" || bubble.originLinked
              cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
              onClicked: bubble.activateHeading()
            }
            Accessible.role: headingMouse.enabled ? Accessible.Button : Accessible.StaticText
            Accessible.name: text
            Accessible.description: bubble.originLinked ? "Opens the source conversation" : ""
            Accessible.onPressAction: bubble.activateHeading()
          }

          Rectangle {
            objectName: "screenshotThumbnail"
            visible: bubble.kind === "user" && bubble.screenshot && bubble.screenshotUrl !== ""
            width: parent.width
            height: visible ? 132 * root.unit : 0
            radius: 6 * root.unit
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
            border.color: thumbnailHover.containsMouse ? root.accent : "transparent"
            Image {
              id: thumbnail
              anchors.fill: parent
              anchors.margins: 6 * root.unit
              source: parent.visible ? bubble.screenshotUrl : ""
              sourceSize.width: 600
              asynchronous: true
              fillMode: Image.PreserveAspectFit
            }
            Rectangle {
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              anchors.margins: 8 * root.unit
              width: zoomLabel.width + 16 * root.unit
              height: 24 * root.unit
              radius: 12 * root.unit
              color: root.selection
              Text {
                id: zoomLabel
                anchors.centerIn: parent
                text: thumbnail.status === Image.Error ? "Screenshot unavailable" : "↗  Enlarge"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: 10 * root.unit
              }
            }
            MouseArea {
              id: thumbnailHover
              anchors.fill: parent
              hoverEnabled: true
              enabled: thumbnail.status === Image.Ready
              cursorShape: Qt.PointingHandCursor
              onClicked: root.screenshotRequested(bubble.screenshotUrl, root.session.title)
            }
            Accessible.role: Accessible.Button
            Accessible.name: "Enlarge attached screenshot"
            Accessible.onPressAction: if (thumbnail.status === Image.Ready) root.screenshotRequested(bubble.screenshotUrl, root.session.title)
          }

          WidgetSurface {
            id: widgetView
            nativeRendering: root.nativeWidgets
            objectName: "inlineWidget"
            visible: bubble.widget !== null && bubble.widget.presentation.placement === "inline" && viewUrl !== ""
            width: parent.width
            height: visible ? preferredHeight : 0
            reference: bubble.widget
            summary: bubble.body
            foreground: root.foreground
            muted: root.muted
            accent: root.accent
            selection: root.selection
            fontFamily: root.proseFontFamily
            unit: root.unit
            textScale: root.textScale
            // ListView can retain offscreen delegates. Stop frame polling there
            // and while the desktop panel is hidden, without losing widget state.
            running: visible && root.widgetsRunning && bubble.y + bubble.height >= transcript.contentY
              && bubble.y <= transcript.contentY + transcript.height
            onInteractionStarted: root.clearMessageSelection()
            onHoveredChanged: {
              if (hovered) root.hoveredWidget = widgetView
              else if (root.hoveredWidget === widgetView) root.hoveredWidget = null
            }
            Component.onDestruction: if (root.hoveredWidget === widgetView) root.hoveredWidget = null
          }

          Loader {
            width: parent.width
            active: bubble.expanded && bubble.toolCount > 0
            // Unloading destroys the reader but can retain its previous size.
            // Release both its height and the Column spacing when collapsed.
            visible: active
            height: active ? implicitHeight : 0
            sourceComponent: ToolDetails {
              reader: root
              sessionId: root.displayedId
              epoch: root.session ? root.session.toolEpoch || "" : ""
              groupId: bubble.messageId
              revision: bubble.toolRevision
              count: bubble.toolCount
            }
          }

          TextEdit {
            id: messageText
            objectName: "messageText"
            width: parent.width
            height: visible ? contentHeight : 0
            visible: !bubble.toolCount && (bubble.kind !== "tool" || bubble.expanded)
              && (!widgetView.visible || !widgetView.rendered || widgetView.error !== "")
            text: bubble.kind === "assistant" ? Markdown.render(bubble.body, root.textScale, root.selection.toString(), root.accent.toString())
              : bubble.kind === "tool" ? bubble.input + (bubble.body ? "\n\n" + bubble.body : "") : bubble.body
            textFormat: bubble.kind === "assistant" ? TextEdit.RichText : TextEdit.PlainText
            readOnly: true
            selectByMouse: true
            activeFocusOnPress: false
            onSelectedTextChanged: root.messageSelectionChanged(messageText)
            Component.onDestruction: if (root.selectedMessage === messageText) root.selectedMessage = null
            onVisibleChanged: if (!visible && root.selectedMessage === messageText) root.clearMessageSelection()
            wrapMode: TextEdit.Wrap
            color: root.foreground
            selectionColor: root.selection
            selectedTextColor: root.foreground
            font.family: bubble.kind === "tool" ? "monospace" : root.proseFontFamily
            font.pixelSize: (bubble.kind === "tool" ? 14 : 16) * root.textScale
            onLinkActivated: link => {
              // Opening a link is an explicit click; commands and file URLs do
              // not become executable UI actions through generated Markdown.
              if (/^https?:\/\//i.test(link)) Qt.openUrlExternally(link)
            }
          }
        }

        Rectangle {
          id: copyButton
          objectName: "copyMessage"
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.margins: 10 * root.unit
          width: 58 * root.unit
          height: 24 * root.unit
          radius: 4 * root.unit
          color: root.selection
          opacity: messageHover.hovered || copyMouse.containsMouse || copied.running ? 1 : 0
          visible: !bubble.toolCount && messageText.text !== ""
          Behavior on opacity { NumberAnimation { duration: 120 } }
          function activate() {
            const source = bubble.kind === "tool" ? bubble.input + (bubble.body ? "\n\n" + bubble.body : "") : bubble.body
            root.copyMessage(source)
            copied.restart()
          }
          Timer { id: copied; interval: 1400 }
          Text {
            anchors.centerIn: parent
            text: copied.running ? "Copied" : "Copy"
            color: copyMouse.containsMouse || copied.running ? root.accent : root.foreground
            font.family: root.proseFontFamily
            font.pixelSize: 11 * root.unit
          }
          MouseArea {
            id: copyMouse
            anchors.fill: parent
            hoverEnabled: true
            enabled: copyButton.opacity > 0.5
            cursorShape: Qt.PointingHandCursor
            onClicked: copyButton.activate()
          }
          Accessible.role: Accessible.Button
          Accessible.name: "Copy message"
          Accessible.onPressAction: activate()
        }
      }
    }

    footer: Text {
      width: transcript.width - 8 * root.unit
      text: root.session && root.session.error ? root.session.error : ""
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.fontFamily
      font.pixelSize: 12 * root.unit
    }
  }

  Column {
    id: inputSection
    anchors.bottom: parent.bottom
    width: parent.width
    spacing: 8 * root.unit

    AgentChoices {
      objectName: "agentChoices"
      width: parent.width
      maximumHeight: root.choiceHeightLimit
      choices: root.actionsCurrent ? root.agentActions.choices || [] : []
      sessionId: root.actionsCurrent ? root.session.id : ""
      stopRunId: root.actionsCurrent ? root.agentActions.stopRunId || "" : ""
      online: root.online
      listening: !root.paused
      pending: root.pendingChoice !== null || root.pendingSubmission !== null
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.proseFontFamily
      unit: root.unit
      onChoiceRequested: (id, revision, index) => {
        root.inputError = ""
        root.pendingChoice = {id: id, revision: revision, index: index}
        root.choiceRequested(id, revision, index)
      }
      onStopRequested: (id, runId) => root.stopRunRequested(id, runId)
    }

    ScrollView {
      id: composerScroll
      width: parent.width
      height: 76 * root.textScale
      contentWidth: availableWidth
      clip: true
      TextArea {
        id: composer
        objectName: "sessionComposer"
        enabled: root.composerReachable
        width: composerScroll.availableWidth
        placeholderText: !root.composerFocusId && root.focusShortcut
          ? root.focusShortcut + " to focus"
          : root.running ? "Write a follow-up while Pi answers…" : "Ask a follow-up…"
        placeholderTextColor: root.muted
        color: root.foreground
        selectionColor: root.selection
        selectedTextColor: root.foreground
        wrapMode: TextEdit.Wrap
        textFormat: TextEdit.PlainText
        selectByMouse: true
        padding: 8 * root.unit
        font.family: root.proseFontFamily
        font.pixelSize: 16 * root.textScale
        background: Rectangle {
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.color: composer.activeFocus ? root.accent : root.muted
          radius: 4 * root.unit
        }
        onTextChanged: {
          if (root.displayedId) root.drafts[root.displayedId] = text
          if (text === "") root.forgetDraftSource(root.displayedId)
        }
        onSelectedTextChanged: if (selectedText !== "") root.clearMessageSelection()
        TapHandler { onPressedChanged: if (pressed) root.clearMessageSelection() }
        // TextArea consumes the standard copy key before window shortcuts.
        // When the reader selected a message, route that same key explicitly;
        // otherwise leave ordinary composer copying to TextArea.
        Keys.onPressed: event => {
          if (event.matches(StandardKey.Copy) && root.copySelectedMessage()) event.accepted = true
        }
        Keys.onReturnPressed: event => root.enterPressed(event)
        Keys.onEnterPressed: event => root.enterPressed(event)
        Accessible.name: "Message to the selected agent session"
      }
    }

    Text {
      objectName: "agentDraftSource"
      width: parent.width
      visible: root.displayedDraftSource !== ""
      text: "Drafted by agent · " + root.displayedDraftSource + " — review before sending"
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    Text {
      width: parent.width
      visible: text !== ""
      text: composer.text.length > 4000 ? "Keep messages under 4000 characters." : root.inputError
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    Row {
      spacing: 8 * root.unit
      PanelAction {
        objectName: "sendSession"
        enabled: root.canSend
        text: root.running ? "Queue" : "Send"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.submit()
      }
      PanelAction {
        objectName: "stopSession"
        visible: root.running && !(root.actionsCurrent && root.agentActions.stopRunId)
        enabled: root.online
        text: "Stop"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.stopRequested(root.session.id)
      }
      PanelAction {
        objectName: "dismissSession"
        enabled: root.online && root.session !== null
        text: "Close session"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.dismissRequested(root.session.id)
      }
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: !root.online ? "Disconnected" : root.running ? "Answering…"
          : root.session && root.session.status === "cancelled" ? "Stopped"
          : root.session && root.session.status === "error" ? "Failed" : "Done"
        textFormat: Text.PlainText
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 10 * root.unit
      }
    }
  }
}
