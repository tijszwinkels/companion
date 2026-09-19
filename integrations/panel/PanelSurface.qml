import QtQuick

// Every tab uses the same full-height card. Animate its slide inside a stable
// native surface so opening and closing do not resize the Wayland window.
Item {
  id: root
  required property bool opened
  property real unit: 1
  property real reveal: opened ? 1 : 0

  width: Math.min(parent.width, 600 * unit)
  height: parent.height
  x: parent.width - width + (1 - reveal) * width
  y: parent.height - height

  Behavior on reveal {
    NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
  }
}
