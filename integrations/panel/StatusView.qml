import QtQuick

// Presentation only: the host supplies application state and theme tokens.
// No socket, window-manager, or Omarchy dependency belongs in this component.
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
  required property string fontFamily
  required property real unit
  property var history: []
  property bool animationsEnabled: true

  // The microphone keeps the same status colors as the top bar. Processing is
  // described beside the phrase; the sensor continues listening concurrently.
  readonly property color indicatorColor: !online || paused ? muted
    : speaking ? "#ef5350" : processing > 0 ? "#66bb6a" : "#9e9e9e"
  readonly property string title: !online ? "Not running"
    : paused ? (pauseReason === "media" ? "Paused for media" : "Paused") : "Listening"
  readonly property string description: !online ? "Companion will reconnect when it starts."
    : paused && pauseReason === "media" ? "Listening resumes when playback stops."
    : paused ? "Microphone capture is paused." : ""

  PhraseActivity {
    objectName: "phraseActivity"
    width: parent.width
    height: microphone.y + microphone.height / 2
    history: root.history
    active: root.online && root.animationsEnabled && root.visible
    muted: root.muted
    accent: root.accent
    fontFamily: root.fontFamily
    unit: root.unit
  }

  // Draw the microphone directly so other desktop hosts need no icon font.
  // It stays still: all movement belongs to the transcribed phrase above it.
  Item {
    id: microphone
    anchors.horizontalCenter: parent.horizontalCenter
    y: Math.max(0, (parent.height - height) / 2)
    width: 36 * root.unit
    height: 48 * root.unit
    opacity: root.online && !root.paused ? 1 : 0.45

    Rectangle {
      anchors.horizontalCenter: parent.horizontalCenter
      width: 16 * root.unit
      height: 29 * root.unit
      radius: width / 2
      color: root.indicatorColor
    }

    Item {
      y: 17 * root.unit
      width: parent.width
      height: 21 * root.unit
      clip: true

      Rectangle {
        y: -15 * root.unit
        width: parent.width
        height: 35 * root.unit
        radius: width / 2
        color: "transparent"
        border.width: 2 * root.unit
        border.color: root.indicatorColor
      }
    }

    Rectangle {
      anchors.horizontalCenter: parent.horizontalCenter
      y: 37 * root.unit
      width: 2 * root.unit
      height: 9 * root.unit
      color: root.indicatorColor
    }

    Rectangle {
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.bottom: parent.bottom
      width: 16 * root.unit
      height: 2 * root.unit
      color: root.indicatorColor
    }
  }

  Column {
    anchors.top: microphone.bottom
    anchors.topMargin: 24 * root.unit
    width: parent.width
    spacing: 18 * root.unit

    Text {
      width: parent.width
      text: root.title
      textFormat: Text.PlainText
      horizontalAlignment: Text.AlignHCenter
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: 22 * root.unit
    }

    Text {
      width: parent.width
      visible: text !== ""
      text: root.description
      textFormat: Text.PlainText
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.WordWrap
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 12 * root.unit
    }
  }
}
