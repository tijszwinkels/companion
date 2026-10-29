import QtQuick
import QtQuick.Window
import "../panel" as Panel

// One real Companion conversation in its own ordinary desktop window.
//
// The window is only a view. The conversation, its agent, history and queue
// stay in the listener; this view reads the same session state as the
// sidebar through the host's single Client connection and sends follow-ups,
// choices, history pages and recordings through it. While the window exists
// it owns the conversation's composer and draft (the sidebar shows none).
//
// Closing the window returns the conversation to the sidebar; it never closes
// the conversation. The controller refuses that while a send, choice or
// recording started here is still unconfirmed, and says why.
//
// The compositor owns placement, size and tiling. The window only asks for an
// initial size, like any other application window.
Window {
  id: root
  required property string sessionId
  required property var controller
  readonly property var client: controller.client
  readonly property var theme: controller.theme
  readonly property var session: client.sessions.sessions.find(entry => entry.id === root.sessionId) || null
  // The conversation's current number: its position in the same list the
  // sidebar numbers and voice session navigation ("go to session 3") uses,
  // the listener's conversation order. It follows reordering, closing and
  // restoring other conversations. 0 (no number shown) while the
  // conversation is not in that list, never a remembered old position.
  readonly property int sessionNumber: client.sessions.sessions.findIndex(entry => entry.id === root.sessionId) + 1
  // The last known title, kept for an orphaned draft after the conversation
  // was closed elsewhere.
  property string lastTitle: "conversation"
  onSessionChanged: if (session) lastTitle = session.title
  // A short explanation shown in the header, e.g. why Return was refused.
  property string notice: ""
  property string screenshotSource: ""
  readonly property alias view: view
  // A Window declared inside an Item becomes transient for that item's window
  // by default. Pop-outs are independent top-level windows, never dialogs of
  // the sidebar's layer surface.
  transientParent: null
  objectName: "popout-" + sessionId
  title: (session ? session.title : "Conversation") + " — Companion"
  width: 560
  height: 720
  // Asks the compositor for at least the width the header needs at this
  // theme scale: the number with a readable part of the title, and the full
  // "Return to sidebar", each on a row of their own if necessary (see the
  // header). That is 320 px up to about theme unit 2; larger scales ask for
  // more. This is only a size hint: the header also fits a narrower window.
  minimumWidth: Math.max(320, Math.ceil(2 * header.anchors.margins + header.minimumContentWidth))
  minimumHeight: 360
  color: theme.background

  onClosing: close => {
    close.accepted = false
    root.controller.returnToSidebar(root.sessionId, {focus: false, source: "window-close"})
  }

  Rectangle {
    anchors.fill: parent
    color: root.theme.background
  }

  Item {
    id: header
    objectName: "popoutHeader"
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: 12 * root.theme.unit

    // The number and a readable part of the title come first. When the
    // window is too narrow for them beside "Return to sidebar" (a small
    // window or a large theme scale), the button moves to its own row
    // below instead of covering them. If even that row is too narrow for
    // the full label (the compositor did not keep the minimum width), the
    // button says just "Return"; its accessible name stays complete.
    readonly property real gap: 8 * root.theme.unit
    readonly property real rowGap: 6 * root.theme.unit
    readonly property real numberSpace: sessionNumberText.visible ? sessionNumberText.width + gap : 0
    readonly property real minimumTitleWidth: 96 * root.theme.unit
    // The button's width with its full label, measured with the button's own
    // font. Measured separately so that the layout does not depend on the
    // label it chooses.
    readonly property real fullReturnWidth: fullReturnLabel.implicitWidth + 20 * root.theme.unit
    readonly property bool stacked: width < numberSpace + minimumTitleWidth + gap + fullReturnWidth
    // The narrowest header where both stacked rows fit with the full label;
    // the window's minimum width follows it.
    readonly property real minimumContentWidth: Math.max(numberSpace + minimumTitleWidth, fullReturnWidth)

    height: (stacked ? title.implicitHeight + rowGap + returnButton.height : Math.max(returnButton.height, title.implicitHeight))
      + (noticeText.visible ? noticeText.height + 6 * root.theme.unit : 0)

    // Always visible beside the title (no hover), so the person can read the
    // number to say. Display only: it changes no focus, routing or voice
    // target.
    Text {
      id: sessionNumberText
      objectName: "popoutSessionNumber"
      anchors.left: parent.left
      anchors.baseline: title.baseline
      visible: root.sessionNumber > 0
      width: visible ? implicitWidth : 0
      text: String(root.sessionNumber)
      textFormat: Text.PlainText
      color: root.theme.accent
      font.family: root.theme.fontFamily
      font.pixelSize: 16 * root.theme.unit
      font.bold: true
      Accessible.role: Accessible.StaticText
      Accessible.name: "Session " + root.sessionNumber
    }

    Text {
      id: title
      objectName: "popoutTitle"
      anchors.left: parent.left
      anchors.leftMargin: header.numberSpace
      anchors.right: header.stacked ? parent.right : returnButton.left
      anchors.rightMargin: header.stacked ? 0 : header.gap
      anchors.top: parent.top
      text: root.session ? root.session.title : "Conversation closed"
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: root.theme.foreground
      font.family: root.theme.fontFamily
      font.pixelSize: 16 * root.theme.unit
    }

    Panel.PanelAction {
      id: returnButton
      objectName: "popoutReturnButton"
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.topMargin: header.stacked ? title.implicitHeight + header.rowGap : -4 * root.theme.unit
      text: header.width >= header.fullReturnWidth ? fullReturnLabel.text : "Return"
      foreground: root.theme.foreground
      selection: root.theme.selection
      fontFamily: root.theme.fontFamily
      unit: root.theme.unit
      onTriggered: root.controller.returnToSidebar(root.sessionId, {focus: true, source: "button"})
      Accessible.name: "Return this conversation to the Companion sidebar"
    }

    // Measures the full Return label in the PanelAction's font (11 px per
    // unit); never shown.
    Text {
      id: fullReturnLabel
      visible: false
      text: "Return to sidebar"
      textFormat: Text.PlainText
      font.family: root.theme.fontFamily
      font.pixelSize: 11 * root.theme.unit
    }

    Text {
      id: noticeText
      objectName: "popoutNotice"
      anchors.top: returnButton.bottom
      anchors.topMargin: 6 * root.theme.unit
      width: parent.width
      visible: text !== ""
      text: root.notice
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.theme.fontFamily
      font.pixelSize: 11 * root.theme.unit
    }
  }

  Panel.SessionView {
    id: view
    objectName: "popoutSessionView"
    anchors.top: header.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.margins: 12 * root.theme.unit
    session: root.session
    nativeWidgets: root.controller.nativeWidgets
    htmlSurface: root.controller.htmlSessions
    appChatPermissionTransportReady: root.controller.htmlSessions
    sharedDrafts: root.client.serverDrafts
    onDraftWritten: (id, text, recording) => root.client.writeDraft(id, text, recording)
    onAppChatPermissionRequested: request => { root.client.reportPanel(); root.client.send(request) }
    widgetsRunning: root.client.online && root.visible
    background: root.theme.background
    agentActions: root.client.agentActions
    viewAgentActions: root.client.viewAgentActions
    paused: root.client.paused
    online: root.client.online
    foreground: root.theme.foreground
    muted: root.theme.muted
    accent: root.theme.accent
    selection: root.theme.selection
    fontFamily: root.theme.fontFamily
    unit: root.theme.unit
    recordingAvailable: root.client.recordingAvailable
    recording: root.client.recording
    openableOrigins: root.controller.panel.openableOrigins
    onOriginRequested: (id, groupId) => root.controller.panel.openOrigin(id, groupId)
    onScreenshotRequested: (source, title) => root.screenshotSource = source
    onStopRequested: id => root.client.send({action: "stop-agent", id: id})
    onDismissRequested: id => root.client.send({action: "close-agent", id: id})
    onSendRequested: (id, text) => root.client.sendInput(id, text)
    onRecordRequested: (id, draftLength) => root.client.startRecording(id, draftLength)
    onStopRecordingRequested: id => root.client.stopRecording(id)
    onToolPageRequested: request => { root.client.reportPanel(); root.client.send(request) }
    onChoiceRequested: (id, revision, index) => root.client.choose(id, revision, index)
    onStopRunRequested: (id, runId) => {
      root.client.reportPanel()
      root.client.send({action: "stop-agent-run", id: id, runId: runId})
    }
  }

  Panel.ScreenshotViewer {
    anchors.fill: parent
    visible: root.screenshotSource !== ""
    source: root.screenshotSource
    background: root.theme.background
    foreground: root.theme.foreground
    muted: root.theme.muted
    accent: root.theme.accent
    selection: root.theme.selection
    fontFamily: root.theme.fontFamily
    unit: root.theme.unit
    onDismissed: root.screenshotSource = ""
  }
}
