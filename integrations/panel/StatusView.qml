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
  // Manual recording ("Record" under a text box) is using the microphone.
  // It may run while listening stays paused; the pause itself is unchanged.
  property bool microphoneRecording: false
  required property color foreground
  required property color muted
  required property color accent
  required property string fontFamily
  required property real unit
  property real textScale: unit
  property var history: []
  property bool animationsEnabled: true
  property bool compact: false
  readonly property real iconUnit: unit * (compact ? 0.5 : 1)
  Accessible.role: Accessible.Indicator
  Accessible.name: root.title
  Accessible.description: root.description

  // The microphone keeps the same status colors as the top bar. Processing is
  // described beside the phrase; the sensor continues listening concurrently.
  // Manual recording takes precedence: the microphone is live even if
  // listening is paused, so the indicator must never look switched off.
  readonly property bool recordingShown: online && microphoneRecording
  readonly property color indicatorColor: recordingShown ? "#ef5350"
    : !online || paused ? muted
    : speaking ? "#ef5350" : processing > 0 ? "#66bb6a" : "#9e9e9e"
  readonly property string title: !online ? "Not running"
    : recordingShown ? "Recording into a text box"
    : paused ? (pauseReason === "media" ? "Paused for media" : "Paused") : "Listening"
  readonly property string description: !online ? "Companion will reconnect when it starts."
    : recordingShown && paused ? "The microphone is on for Record. Listening stays " + (pauseReason === "media" ? "paused for media." : "paused.")
    : recordingShown ? "The microphone is on for Record. Voice commands resume when recording stops."
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
    textScale: root.textScale
    compact: root.compact
  }

  // Draw the microphone directly so other desktop hosts need no icon font.
  // It stays still: all movement belongs to the transcribed phrase above it.
  Item {
    id: microphone
    anchors.horizontalCenter: parent.horizontalCenter
    y: root.compact ? Math.max(0, parent.height - height - 4 * root.unit)
      : Math.max(0, parent.height - height - statusCaption.height - 18 * root.unit)
    width: 36 * root.iconUnit
    height: 48 * root.iconUnit
    opacity: root.recordingShown || (root.online && !root.paused) ? 1 : 0.45

    Rectangle {
      anchors.horizontalCenter: parent.horizontalCenter
      width: 16 * root.iconUnit
      height: 29 * root.iconUnit
      radius: width / 2
      color: root.indicatorColor
    }

    Item {
      y: 17 * root.iconUnit
      width: parent.width
      height: 21 * root.iconUnit
      clip: true

      Rectangle {
        y: -15 * root.iconUnit
        width: parent.width
        height: 35 * root.iconUnit
        radius: width / 2
        color: "transparent"
        border.width: 2 * root.iconUnit
        border.color: root.indicatorColor
      }
    }

    Rectangle {
      anchors.horizontalCenter: parent.horizontalCenter
      y: 37 * root.iconUnit
      width: 2 * root.iconUnit
      height: 9 * root.iconUnit
      color: root.indicatorColor
    }

    Rectangle {
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.bottom: parent.bottom
      width: 16 * root.iconUnit
      height: 2 * root.iconUnit
      color: root.indicatorColor
    }
  }

  Column {
    id: statusCaption
    visible: !root.compact
    anchors.top: microphone.bottom
    anchors.topMargin: 18 * root.unit
    width: parent.width
    spacing: 8 * root.unit

    Text {
      width: parent.width
      text: root.title
      textFormat: Text.PlainText
      horizontalAlignment: Text.AlignHCenter
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: 18 * root.textScale
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
      font.pixelSize: 12 * root.textScale
    }
  }

}
