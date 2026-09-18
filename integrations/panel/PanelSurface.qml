import QtQuick

// Animate the visible card inside a stable native surface. Resizing a Wayland
// window every frame requires repeated compositor configuration and buffer
// allocation; these local item changes keep the native surface unchanged.
Item {
  id: root
  required property bool opened
  required property bool expanded
  property real unit: 1
  property real reveal: opened ? 1 : 0
  readonly property bool animating: slide.running || resizeWidth.running || resizeHeight.running

  width: Math.min(parent.width, (expanded ? 600 : 420) * unit)
  height: Math.min(parent.height, (expanded ? parent.height : 400 * unit))
  x: parent.width - width + (1 - reveal) * width
  y: parent.height - height

  Behavior on reveal {
    NumberAnimation { id: slide; duration: 180; easing.type: Easing.OutCubic }
  }
  Behavior on width {
    enabled: root.opened && root.visible
    NumberAnimation { id: resizeWidth; duration: 220; easing.type: Easing.OutCubic }
  }
  Behavior on height {
    enabled: root.opened && root.visible
    NumberAnimation { id: resizeHeight; duration: 220; easing.type: Easing.OutCubic }
  }
}
