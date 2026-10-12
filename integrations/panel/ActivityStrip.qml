import QtQuick

// A fixed conversation header, outside the transcript's scrolling viewport.
// Collapsing keeps a one-line status and stops the hidden phrase animation.
Rectangle {
  id: root
  required property bool online
  required property bool paused
  property string pauseReason: ""
  required property bool speaking
  property bool microphoneRecording: false
  required property int processing
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property var history: []
  property bool animationsEnabled: true
  property bool collapsed: false

  height: (collapsed ? 28 : 124) * unit
  radius: 5 * unit
  color: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.025)
  clip: true
  Behavior on height {
    enabled: root.visible && root.animationsEnabled
    NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
  }

  Rectangle {
    x: 10 * root.unit
    y: 11 * root.unit
    width: 6 * root.unit
    height: width
    radius: width / 2
    color: status.indicatorColor
  }
  Text {
    objectName: "activityStripTitle"
    x: 24 * root.unit
    height: 28 * root.unit
    width: Math.max(0, parent.width - x - toggle.width - 6 * root.unit)
    text: "Activity · " + status.title
    textFormat: Text.PlainText
    elide: Text.ElideRight
    verticalAlignment: Text.AlignVCenter
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: 11 * root.unit
  }
  Rectangle {
    id: toggle
    objectName: "toggleActivity"
    anchors.right: parent.right
    width: 28 * root.unit
    height: width
    radius: 4 * root.unit
    color: toggleMouse.containsMouse ? root.selection : "transparent"
    Text {
      anchors.centerIn: parent
      text: root.collapsed ? "▾" : "▴"
      color: toggleMouse.containsMouse ? root.accent : root.muted
      font.family: root.fontFamily
      font.pixelSize: 14 * root.unit
    }
    MouseArea {
      id: toggleMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.collapsed = !root.collapsed
    }
    Accessible.role: Accessible.Button
    Accessible.name: root.collapsed ? "Expand activity visualization" : "Collapse activity visualization"
    Accessible.onPressAction: root.collapsed = !root.collapsed
  }

  StatusView {
    id: status
    objectName: "compactActivityStatus"
    x: 8 * root.unit
    y: 28 * root.unit
    width: Math.max(0, parent.width - 16 * root.unit)
    height: 96 * root.unit
    compact: true
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
    fontFamily: root.fontFamily
    unit: root.unit
    animationsEnabled: root.animationsEnabled && root.visible && !root.collapsed
  }
}
