import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import "../../panel" as Panel

// Separate from the sliding panel: the original image can use the whole display
// without resizing the chat or clipping to its input region.
PanelWindow {
  id: root
  property url source: ""
  property string title: "Screenshot"
  signal dismissed()
  visible: source.toString() !== "" && screen !== null
  anchors { top: true; bottom: true; left: true; right: true }
  color: "transparent"
  exclusiveZone: 0
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.namespace: "companion-screenshot"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: visible ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None

  Panel.ScreenshotViewer {
    id: viewer
    anchors.fill: parent
    source: root.source
    title: root.title
    background: Color.menu.background
    foreground: Color.menu.text
    muted: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.65)
    accent: Color.menu.selectedText
    selection: Color.menu.selectedBackground
    fontFamily: Style.font.menuFamily
    unit: Style.space(100) / 100
    onDismissed: root.dismissed()
    opacity: 0
    Connections {
      target: root
      function onVisibleChanged() {
        if (root.visible) {
          viewer.fit()
          viewer.forceActiveFocus()
          entrance.restart()
        } else {
          viewer.opacity = 0
        }
      }
    }
    NumberAnimation { id: entrance; target: viewer; property: "opacity"; from: 0; to: 1; duration: 160; easing.type: Easing.OutCubic }
  }
}
