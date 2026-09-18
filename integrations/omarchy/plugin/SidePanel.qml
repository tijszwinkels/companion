import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "../../panel" as Panel
import "MonitorSelection.js" as Monitors

// The only platform-specific window for the side panel. Its body has no
// Omarchy dependency and can be hosted in a different window on another OS.
PanelWindow {
  id: root

  required property bool opened
  required property bool online
  required property bool paused
  required property bool speaking
  required property int processing
  property var history: []

  signal closeRequested()
  signal toggleRequested()

  // Re-evaluate on hotplug rather than retaining a disconnected screen object.
  readonly property var selectedScreen: Monitors.chooseScreen(Quickshell.screens)
  readonly property string monitorName: selectedScreen ? selectedScreen.name : ""
  readonly property real handleWidth: Math.min(Style.space(12), width)
  readonly property real panelWidth: Math.max(0, width - handleWidth)
  readonly property real panelHeight: Math.min(Style.space(400), height)
  // The window remains mapped for its handle. Diagnostics distinguish the
  // sliding body from that persistent surface, including during the close.
  readonly property bool panelVisible: visible && (opened || reveal > 0)
  property real reveal: opened ? 1 : 0

  screen: selectedScreen
  visible: selectedScreen !== null
  anchors { top: true; bottom: true; right: true }
  implicitWidth: Math.min(Style.space(432), selectedScreen ? selectedScreen.width : Style.space(432))
  color: "transparent"

  // Respect the bar's reserved space but never reserve space ourselves: this
  // first version overlays the workspace and leaves its window layout intact.
  exclusiveZone: 0
  exclusionMode: ExclusionMode.Normal
  WlrLayershell.namespace: "companion-panel"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

  // The narrow edge strip is always clickable. The larger input region follows
  // only the compact body, leaving the desktop below it usable even while open.
  // Drop body input immediately on close, keeping only the strip.
  mask: Region {
    item: handle

    Region {
      x: card.x
      width: root.opened ? card.width : 0
      height: card.height
    }
  }

  Behavior on reveal {
    NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
  }

  Item {
    anchors.fill: parent
    clip: true

    BorderSurface {
      id: card
      x: (1 - root.reveal) * root.width
      width: root.panelWidth
      height: root.panelHeight
      color: Color.menu.background
      borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
      radius: Style.cornerRadius

      Panel.PanelContent {
        anchors.fill: parent
        anchors.margins: Math.max(1, Style.space(2))
        online: root.online
        paused: root.paused
        speaking: root.speaking
        processing: root.processing
        history: root.history
        foreground: Color.menu.text
        muted: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.65)
        accent: Color.menu.selectedText
        selection: Color.menu.selectedBackground
        fontFamily: Style.font.menuFamily
        unit: Style.space(100) / 100
        animationsEnabled: root.opened && root.visible
        shortcutLabel: "Super + Alt + C to toggle"
        onCloseRequested: root.closeRequested()
      }
    }

    Panel.PanelHandle {
      id: handle
      objectName: "panelHandle"
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: root.handleWidth
      opened: root.opened
      background: Color.menu.background
      foreground: Color.menu.text
      borderColor: Color.menu.border
      selection: Color.menu.selectedBackground
      unit: Style.space(100) / 100
      onToggleRequested: root.toggleRequested()
    }
  }
}
