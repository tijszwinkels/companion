import QtQuick
import "../panel" as Panel

// The HTML session surface of one conversation view (sidebar or pop-out
// window), loaded by SessionView when its host enables `htmlSurface`.
//
// Shows one of:
// - the trusted HTML chat (TrustedChatView), which every conversation starts
//   with; or
// - the conversation's own session application (SessionAppView), once its
//   agent applied one (`session.application`).
// While an application exists, a thin native bar above it switches between
// the two and opens the QML "Classic view". The bar is Qt Quick, outside both
// browsers, so application code can neither draw over nor remove the way
// back to chat. Without an application the chat page offers Classic view.
//
// Inputs: `view` (the SessionView model that owns this conversation's draft,
// pending send/choice, recording and rows). Output: `failed`, after which
// SessionView shows its QML presentation; `composerFocused` for voice
// routing (HTML chat composer only; an application is never a composer).
//
// Switching never moves or rewrites the draft: it stays in SessionView.
Item {
  id: root
  property var view: null
  readonly property var session: view ? view.session : null
  readonly property string sessionId: session ? session.id : ""
  readonly property var application: session && session.application ? session.application : null
  readonly property bool failed: chat.failed
  readonly property bool composerFocused: mode === "chat" && chat.composerFocused

  // Per conversation shown in this view: "chat" or "app", the user's latest
  // choice. A conversation without a choice shows its application.
  property var modes: ({})
  // Per conversation: "<application id>:<version>" last seen here, so a new
  // application or replaced code can be brought forward once.
  property var seen: ({})
  // A replacement that arrived while switching was unsafe (see below).
  property var readyNotices: ({})
  readonly property string mode: application !== null && root.modes[root.sessionId] !== "chat" ? "app" : "chat"
  readonly property string readyNotice: root.readyNotices[root.sessionId] || ""

  function setMode(id, next) {
    if (!id) return
    const modes = Object.assign({}, root.modes)
    modes[id] = next
    root.modes = modes
    const notices = Object.assign({}, root.readyNotices)
    delete notices[id]
    root.readyNotices = notices
  }

  // Leaving chat while a send, choice or recording started there is still
  // unconfirmed, or while the person is typing, could look like a discarded
  // input. The application then waits behind an explicit notice instead.
  function switchBlocker() {
    if (!root.view) return ""
    if (root.view.pendingSubmission !== null) return "a message is still being sent"
    if (root.view.pendingChoice !== null) return "a choice is still being confirmed"
    if (root.view.recordingBusy) return "recording into the text box is still running"
    if (chat.composerFocused) return "you are typing"
    return ""
  }

  function observeApplication() {
    const id = root.sessionId
    if (!id) return
    const key = root.application ? root.application.id + ":" + root.application.version : ""
    const previous = root.seen[id]
    if (previous === key) return
    const seen = Object.assign({}, root.seen)
    seen[id] = key
    root.seen = seen

    // First sight in this view (opening a tab or pop-out): keep the default
    // or the user's earlier choice; never announce anything.
    if (previous === undefined || key === "") return

    // The agent applied an application or replaced its code while this view
    // was showing it. Bring it forward unless that would interrupt input.
    const blocker = root.switchBlocker()
    if (blocker === "") {
      root.setMode(id, "app")
      return
    }
    const notices = Object.assign({}, root.readyNotices)
    notices[id] = "“" + root.application.name + "” is ready. It opens when you choose it; " + blocker + "."
    root.readyNotices = notices
  }

  onApplicationChanged: root.observeApplication()
  onSessionIdChanged: root.observeApplication()

  function focusComposer() {
    if (root.mode === "app") root.setMode(root.sessionId, "chat")
    chat.focusComposer()
  }

  function releaseComposerFocus() { chat.releaseComposerFocus() }

  function eventStatusText(status) {
    if (!status || status.state === "idle") return ""
    let text = ""
    if (status.state === "pending") text = status.undelivered + " change" + (status.undelivered === 1 ? "" : "s") + " waiting for the agent"
    else if (status.state === "queued") text = "Changes queued for the agent"
    else if (status.state === "delivering") text = "The agent is reading your changes"
    else if (status.state === "failed") text = "Changes may not have reached the agent"
    if (status.failed > 0 && status.state !== "failed") text += " · " + status.failed + " earlier delivery failed"
    if (status.failure) text += " · " + status.failure
    return text
  }

  Item {
    id: bar
    objectName: "sessionSurfaceBar"
    visible: root.application !== null
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    height: visible ? barColumn.implicitHeight + 8 * root.view.unit : 0

    Column {
      id: barColumn
      width: parent.width
      spacing: 4 * (root.view ? root.view.unit : 1)

      Row {
        spacing: 8 * (root.view ? root.view.unit : 1)

        Panel.PanelAction {
          objectName: "surfaceChatButton"
          text: root.mode === "chat" ? "● Chat" : "Chat"
          foreground: root.view ? root.view.foreground : "white"
          selection: root.view ? root.view.selection : "gray"
          fontFamily: root.view ? root.view.fontFamily : ""
          unit: root.view ? root.view.unit : 1
          onTriggered: root.setMode(root.sessionId, "chat")
          Accessible.name: "Show this conversation's chat and history"
        }
        Panel.PanelAction {
          objectName: "surfaceAppButton"
          text: (root.mode === "app" ? "● " : "") + (root.application ? root.application.name + " · v" + root.application.version : "")
          foreground: root.view ? root.view.foreground : "white"
          selection: root.view ? root.view.selection : "gray"
          fontFamily: root.view ? root.view.fontFamily : ""
          unit: root.view ? root.view.unit : 1
          onTriggered: root.setMode(root.sessionId, "app")
          Accessible.name: "Show this conversation's application"
        }
        Panel.PanelAction {
          objectName: "surfaceClassicButton"
          text: "Classic view"
          foreground: root.view ? root.view.foreground : "white"
          selection: root.view ? root.view.selection : "gray"
          fontFamily: root.view ? root.view.fontFamily : ""
          unit: root.view ? root.view.unit : 1
          onTriggered: root.view.classicView = true
          Accessible.name: "Show this conversation in the classic Companion view"
        }
      }

      Text {
        objectName: "surfaceStatus"
        width: parent.width
        readonly property bool draftKept: root.mode === "app" && root.view !== null && root.view.pageDraft().text !== ""
        readonly property string events: root.application ? root.eventStatusText(root.application.eventStatus) : ""
        text: [root.readyNotice, root.application && root.application.error ? "Application unavailable: " + root.application.error : "",
          root.mode === "app" && appView.error ? appView.error : "",
          events, draftKept ? "Your unsent message is kept in Chat." : ""].filter(part => part !== "").join("\n")
        visible: text !== ""
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.view ? root.view.muted : "gray"
        font.family: root.view ? root.view.fontFamily : ""
        font.pixelSize: 11 * (root.view ? root.view.unit : 1)
      }
    }
  }

  TrustedChatView {
    id: chat
    objectName: "trustedChat"
    anchors.top: bar.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    view: root.view
    visible: root.mode === "chat"
    running: visible && root.visible
    onClassicRequested: root.view.classicView = true
    onAppRequested: root.setMode(root.sessionId, "app")
  }

  SessionAppView {
    id: appView
    objectName: "sessionApp"
    anchors.top: bar.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    visible: root.mode === "app"
    application: root.application
    running: visible && root.visible && root.view !== null && root.view.widgetsRunning
    foreground: root.view ? root.view.foreground : "white"
    background: root.view ? root.view.background : "black"
    accent: root.view ? root.view.accent : "white"
    muted: root.view ? root.view.muted : "gray"
    textScale: root.view ? root.view.textScale : 1

    // An unavailable application (restore failure) keeps its saved data; its
    // readable description and the error remain visible here, chat stays one
    // click away.
    Text {
      anchors.fill: parent
      anchors.margins: 12 * (root.view ? root.view.unit : 1)
      visible: appView.viewUrl === "" && root.application !== null
      text: root.application ? root.application.text : ""
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.view ? root.view.foreground : "white"
      font.family: root.view ? root.view.proseFontFamily : ""
      font.pixelSize: 14 * (root.view ? root.view.textScale : 1)
    }
  }
}
