import QtQuick

// Every tab uses the same full-height card. Animate its slide inside a stable
// native surface so opening and closing do not resize the Wayland window.
Item {
  id: root
  required property bool opened
  property real unit: 1
  property real reveal: opened ? 1 : 0
  property real preferredWidth: 600
  property real availableWidth: parent.width

  // Remember the chosen width across tabs and closing. Start from the visible
  // width when resizing after a monitor change, avoiding invisible extra steps.
  function resizeBy(logicalPixels) {
    const maximum = availableWidth / unit
    const minimum = Math.min(360, maximum)
    preferredWidth = Math.max(minimum, Math.min(maximum, width / unit + logicalPixels))
  }

  width: Math.min(availableWidth, preferredWidth * unit)
  height: parent.height
  x: parent.width - width + (1 - reveal) * width
  y: parent.height - height

  Behavior on reveal {
    NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
  }
}
