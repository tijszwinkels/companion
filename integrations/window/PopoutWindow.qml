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
  minimumWidth: 320
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
    height: Math.max(returnButton.height, title.implicitHeight) + (noticeText.visible ? noticeText.height + 6 * root.theme.unit : 0)

    Text {
      id: title
      anchors.left: parent.left
      anchors.right: returnButton.left
      anchors.rightMargin: 8 * root.theme.unit
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
      anchors.topMargin: -4 * root.theme.unit
      text: "Return to sidebar"
      foreground: root.theme.foreground
      selection: root.theme.selection
      fontFamily: root.theme.fontFamily
      unit: root.theme.unit
      onTriggered: root.controller.returnToSidebar(root.sessionId, {focus: true, source: "button"})
      Accessible.name: "Return this conversation to the Companion sidebar"
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
    widgetsRunning: root.client.online && root.visible
    background: root.theme.background
    agentActions: root.client.agentActions
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
