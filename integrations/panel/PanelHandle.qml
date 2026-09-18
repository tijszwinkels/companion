import QtQuick

// A thin, persistent edge strip. The host owns the window and open state;
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

  implicitWidth: 12 * unit
  implicitHeight: 400 * unit
  // Menu selection colors are usually translucent overlays. Keep an opaque
  // base beneath the hover tint instead of replacing it with that tint.
  color: Qt.rgba(background.r, background.g, background.b, 1)
  border.color: borderColor
  border.width: Math.max(1, unit)

  Rectangle {
    anchors.fill: parent
    color: root.selection
    visible: pointer.containsMouse
  }

  // Draw a chevron without depending on a particular font or icon package.
  Item {
    anchors.horizontalCenter: parent.horizontalCenter
    y: Math.max(0, Math.min(28 * root.unit - height / 2, parent.height - height))
    width: 8 * root.unit
    height: 14 * root.unit
    scale: 0.75
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
