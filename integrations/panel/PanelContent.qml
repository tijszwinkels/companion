import QtQuick

// Reusable panel body. The desktop adapter owns the window, shortcut, monitor
// selection, and theme; this item only renders the selected page and tab rail.
Item {
  id: root

  required property bool online
  required property bool paused
  required property bool speaking
  required property int processing
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property bool animationsEnabled: true
  property string shortcutLabel: ""

  signal closeRequested()

  // A vertical rail leaves room for session tabs without inventing a session
  // model before those interactions have been designed.
  Rectangle {
    id: rail
    width: 64 * root.unit
    height: parent.height
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)

    Rectangle {
      anchors.top: parent.top
      anchors.topMargin: 20 * root.unit
      anchors.horizontalCenter: parent.horizontalCenter
      width: 48 * root.unit
      height: 64 * root.unit
      color: root.selection

      Rectangle {
        width: 2 * root.unit
        height: parent.height
        color: root.accent
      }

      Column {
        anchors.centerIn: parent
        spacing: 8 * root.unit

        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          height: 20 * root.unit
          spacing: 3 * root.unit

          Repeater {
            model: [8, 20, 14]
            Rectangle {
              required property int modelData
              anchors.verticalCenter: parent.verticalCenter
              width: 3 * root.unit
              height: modelData * root.unit
              radius: root.unit
              color: root.accent
            }
          }
        }

        Text {
          text: "Activity"
          textFormat: Text.PlainText
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: 8 * root.unit
        }
      }

      Accessible.role: Accessible.PageTab
      Accessible.name: "Activity"
    }
  }

  Item {
    anchors.left: rail.right
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.margins: 24 * root.unit

    Text {
      anchors.top: parent.top
      text: "Companion"
      textFormat: Text.PlainText
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
        color: root.muted
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

    StatusView {
      anchors.fill: parent
      anchors.topMargin: 64 * root.unit
      anchors.bottomMargin: 64 * root.unit
      online: root.online
      paused: root.paused
      speaking: root.speaking
      processing: root.processing
      foreground: root.foreground
      muted: root.muted
      fontFamily: root.fontFamily
      unit: root.unit
      animationsEnabled: root.animationsEnabled
    }

    Text {
      anchors.bottom: parent.bottom
      width: parent.width
      text: root.shortcutLabel
      textFormat: Text.PlainText
      horizontalAlignment: Text.AlignHCenter
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }
  }
}
