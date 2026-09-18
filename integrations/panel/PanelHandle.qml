import QtQuick

// A small, persistent drawer handle. The host owns the window and open state;
// clicking (or an accessibility press) requests the same toggle as the shortcut.
Rectangle {
  id: root

  required property bool opened
  required property color background
  required property color foreground
  required property color borderColor
  required property color selection
  property real unit: 1

  signal toggleRequested()

  implicitWidth: 24 * unit
  implicitHeight: 56 * unit
  topLeftRadius: 6 * unit
  bottomLeftRadius: 6 * unit
  color: pointer.containsMouse ? selection : background
  border.color: borderColor
  border.width: Math.max(1, unit)

  // Draw a chevron without depending on a particular font or icon package.
  Item {
    anchors.centerIn: parent
    width: 8 * root.unit
    height: 14 * root.unit
    rotation: root.opened ? 180 : 0

    Rectangle {
      x: 3 * root.unit
      y: 1 * root.unit
      width: 2 * root.unit
      height: 8 * root.unit
      radius: root.unit
      rotation: 45
      color: root.foreground
    }

    Rectangle {
      x: 3 * root.unit
      y: 5 * root.unit
      width: 2 * root.unit
      height: 8 * root.unit
      radius: root.unit
      rotation: -45
      color: root.foreground
    }
  }

  MouseArea {
    id: pointer
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.toggleRequested()
  }

  Accessible.role: Accessible.Button
  Accessible.name: root.opened ? "Collapse Companion panel" : "Expand Companion panel"
  Accessible.onPressAction: root.toggleRequested()
}
