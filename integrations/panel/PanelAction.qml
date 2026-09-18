import QtQuick

Rectangle {
  id: root
  required property string text
  required property color foreground
  required property color selection
  required property string fontFamily
  property real unit: 1
  signal triggered()

  implicitWidth: label.implicitWidth + 20 * unit
  implicitHeight: 28 * unit
  radius: 4 * unit
  color: selection
  opacity: enabled ? 1 : 0.45

  Text {
    id: label
    anchors.centerIn: parent
    text: root.text
    textFormat: Text.PlainText
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: 11 * root.unit
  }
  MouseArea {
    anchors.fill: parent
    cursorShape: Qt.PointingHandCursor
    onClicked: root.triggered()
  }
  Accessible.role: Accessible.Button
  Accessible.name: text
  Accessible.onPressAction: if (root.enabled) root.triggered()
}
