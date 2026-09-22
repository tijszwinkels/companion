import QtQuick
import QtQuick.Controls

// Created only on disclosure, destroyed on collapse. A page replaces the last
// one. Group updates mark the page stale without moving the reader; per-call
// revisions prevent mixing chunks of different outputs. Disconnect clears it.
Column {
  id: root
  required property var reader
  required property string sessionId
  required property string epoch
  required property string groupId
  required property string revision
  required property int count
  property string pending: ""
  property string pendingCallRevision: ""
  property string body: ""
  property string error: ""
  property var next: null
  property int callIndex: 0
  property int offset: 0
  property bool loaded: false
  property string callState: ""
  property string callRevision: ""
  property bool outdated: false
  spacing: 8 * reader.unit
  objectName: "toolDetails"

  function invalidate(reason) {
    root.pending = ""
    root.body = ""
    root.next = null
    root.loaded = false
    root.callIndex = 0
    root.offset = 0
    root.callRevision = ""
    root.outdated = false
    root.error = reason
    deadline.stop()
  }

  function load(index, offset, continuation) {
    if (!reader.online) { root.error = "Disconnected. Reload after reconnecting."; return }
    if (root.pending) return
    root.error = ""
    root.pending = Date.now().toString(36) + Math.random().toString(36)
    root.pendingCallRevision = continuation || ""
    deadline.restart()
    reader.toolPageRequested({action: "agent-tool-page", requestId: root.pending,
      id: root.sessionId, epoch: root.epoch, groupId: root.groupId, revision: root.revision,
      index: index, offset: offset, callRevision: continuation || ""})
  }

  function receive(message) {
    if (!root.pending || message.requestId !== root.pending) return
    root.pending = ""
    deadline.stop()
    if (message.type === "error") {
      root.error = message.message || "Could not load tool details."
      return
    }
    const page = message.result
    if (!page || page.id !== root.sessionId || page.epoch !== root.epoch || page.groupId !== root.groupId) return
    if (page.revision !== root.revision && !root.pendingCallRevision) {
      root.outdated = true
      root.error = "Tool output changed. Refresh this page."
      return
    }
    if (root.pendingCallRevision && page.callRevision !== root.pendingCallRevision) return
    root.body = page.text
    root.next = page.next
    root.callIndex = page.index
    root.offset = page.offset
    root.callState = page.state || "done"
    root.callRevision = page.callRevision || ""
    root.outdated = page.revision !== root.revision
    root.loaded = true
  }

  onEpochChanged: invalidate("")
  onRevisionChanged: if (root.loaded || root.pending) root.outdated = true
  onSessionIdChanged: invalidate("")
  onGroupIdChanged: invalidate("")
  Component.onCompleted: load(0, 0)
  Connections {
    target: root.reader
    function onToolPageReceived(message) { root.receive(message) }
    function onOnlineChanged() {
      if (!root.reader.online) root.invalidate("Disconnected. Reload after reconnecting.")
    }
  }
  Timer {
    id: deadline
    interval: 10000
    onTriggered: root.invalidate("Tool details timed out. Try reloading.")
  }

  Text {
    objectName: "toolPageStatus"
    width: parent.width
    text: root.pending ? "Loading tool details…" : root.error ||
      (root.outdated ? "New tool output is available. Refresh this page to update it.\n" : "") +
      (root.loaded ? "Tool " + (root.callIndex + 1) + " of " + root.count +
        (root.callState === "running" ? " · running" : root.callState === "error" ? " · failed or stopped" : "") +
        " · characters " + (root.offset + 1) + "–" + (root.offset + root.body.length) : "")
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    color: root.error ? "#ef5350" : reader.muted
    font.family: reader.fontFamily
    font.pixelSize: 11 * reader.unit
  }
  TextEdit {
    id: pageText
    objectName: "toolPageText"
    width: parent.width
    height: contentHeight
    text: root.body
    textFormat: TextEdit.PlainText
    readOnly: true
    selectByMouse: true
    activeFocusOnPress: false
    wrapMode: TextEdit.Wrap
    color: reader.foreground
    selectionColor: reader.selection
    selectedTextColor: reader.foreground
    font.family: "monospace"
    font.pixelSize: 14 * reader.textScale
    onSelectedTextChanged: reader.messageSelectionChanged(pageText)
    Component.onDestruction: if (reader.selectedMessage === pageText) reader.selectedMessage = null
  }
  Flow {
    width: parent.width
    spacing: 8 * reader.unit
    PanelAction {
      objectName: "reloadToolDetails"
      text: root.loaded ? "Refresh page" : "Load details"
      enabled: reader.online && !root.pending
      foreground: reader.foreground
      selection: reader.selection
      fontFamily: reader.fontFamily
      unit: reader.unit
      onTriggered: root.load(root.callIndex, root.offset)
    }
    PanelAction {
      objectName: "restartToolDetails"
      text: "From start"
      visible: root.loaded && (root.callIndex > 0 || root.offset > 0)
      enabled: reader.online && !root.pending
      foreground: reader.foreground
      selection: reader.selection
      fontFamily: reader.fontFamily
      unit: reader.unit
      onTriggered: root.load(0, 0)
    }
    PanelAction {
      objectName: "nextToolPage"
      text: "Next page"
      visible: root.next !== null
      enabled: reader.online && !root.pending
      foreground: reader.foreground
      selection: reader.selection
      fontFamily: reader.fontFamily
      unit: reader.unit
      onTriggered: root.load(root.next.index, root.next.offset, root.next.index === root.callIndex ? root.callRevision : "")
    }
    PanelAction {
      objectName: "copyToolPage"
      text: "Copy page"
      visible: root.loaded
      foreground: reader.foreground
      selection: reader.selection
      fontFamily: reader.fontFamily
      unit: reader.unit
      onTriggered: reader.copyMessage(root.body)
    }
  }
}
