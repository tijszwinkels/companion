import QtQuick

// Presentation only: the host supplies application state and theme tokens.
// No socket, window-manager, or Omarchy dependency belongs in this component.
Item {
  id: root

  required property bool online
  required property bool paused
  required property bool speaking
  required property int processing
  required property color foreground
  required property color muted
  required property string fontFamily
  required property real unit
  property bool animationsEnabled: true

  // Keep the same priority and colors as the microphone in the top bar. New
  // speech remains visible while an earlier utterance is still processing.
  readonly property string mode: !online ? "offline" : paused ? "paused"
    : speaking ? "speaking" : processing > 0 ? "processing" : "listening"
  readonly property color indicatorColor: mode === "speaking" ? "#ef5350"
    : mode === "processing" ? "#66bb6a" : mode === "listening" ? "#9e9e9e" : muted
  readonly property string title: mode === "offline" ? "Not running"
    : mode === "paused" ? "Paused" : mode === "speaking" ? "Hearing you"
    : mode === "processing" ? "Processing" : "Listening"
  readonly property string description: mode === "offline" ? "Companion will reconnect when it starts."
    : mode === "paused" ? "Microphone capture is paused."
    : mode === "speaking" ? "Capturing your voice."
    : mode === "processing" ? "Working on your request." : "Ready when you are."

  Column {
    anchors.centerIn: parent
    width: parent.width
    spacing: 18 * root.unit

    Item {
      id: indicator
      anchors.horizontalCenter: parent.horizontalCenter
      width: 104 * root.unit
      height: width

      Rectangle {
        id: halo
        anchors.fill: parent
        radius: width / 2
        color: "transparent"
        border.width: root.unit
        border.color: root.indicatorColor
        opacity: 0.25

        // Animations stop when the panel is hidden, paused, or disconnected.
        SequentialAnimation on scale {
          running: root.animationsEnabled && root.visible
            && (root.mode === "listening" || root.mode === "speaking")
          loops: Animation.Infinite
          NumberAnimation {
            from: 0.87
            to: 1.05
            duration: root.mode === "speaking" ? 380 : 1500
            easing.type: Easing.InOutSine
          }
          NumberAnimation {
            from: 1.05
            to: 0.87
            duration: root.mode === "speaking" ? 380 : 1500
            easing.type: Easing.InOutSine
          }
        }
      }

      Item {
        anchors.fill: parent

        Rectangle {
          anchors.horizontalCenter: parent.horizontalCenter
          y: -2 * root.unit
          width: 5 * root.unit
          height: width
          radius: width / 2
          color: root.indicatorColor
          visible: root.mode === "processing"
        }

        RotationAnimation on rotation {
          running: root.animationsEnabled && root.visible && root.mode === "processing"
          from: 0
          to: 360
          duration: 1300
          loops: Animation.Infinite
        }
      }

      // Draw the microphone with QtQuick shapes rather than requiring a
      // platform-specific icon font in future desktop adapters.
      Item {
        anchors.centerIn: parent
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
    }

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
      text: root.description
      textFormat: Text.PlainText
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.WordWrap
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 12 * root.unit
    }
  }

  Accessible.role: Accessible.StaticText
  Accessible.name: title + ". " + description
}
