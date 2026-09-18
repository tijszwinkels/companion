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
  property var sessions: []
  property var previousSessions: []
  property bool showingPrevious: false
  property string controlError: ""
  property url screenshotSource: ""
  property string screenshotTitle: ""
  property string selectedSessionId: ""
  readonly property string composerFocusId: root.opened ? content.composerFocusId : ""

  signal closeRequested()
  signal sessionSelected(string id)
  signal previousRequested()
  signal reopenSessionRequested(string id)
  signal stopSessionRequested(string id)
  signal dismissSessionRequested(string id)
  signal sendSessionRequested(string id, string text)

  onOpenedChanged: if (!opened) screenshotSource = ""
  onSelectedSessionIdChanged: screenshotSource = ""
  onShowingPreviousChanged: screenshotSource = ""

  function submitted(id, text, error) { content.submitted(id, text, error) }

  // Re-evaluate on hotplug rather than retaining a disconnected screen object.
  readonly property var selectedScreen: Monitors.chooseScreen(Quickshell.screens)
  readonly property string monitorName: selectedScreen ? selectedScreen.name : ""
  readonly property real panelHeight: content.expanded ? height : Math.min(Style.space(400), height)
  property real reveal: opened ? 1 : 0

  screen: selectedScreen
  visible: selectedScreen !== null && (opened || reveal > 0)
  anchors { top: true; bottom: true; right: true }
  implicitWidth: Math.min(Style.space(content.expanded ? 600 : 420), selectedScreen ? selectedScreen.width : Style.space(420))
  color: "transparent"

  // Respect the bar's reserved space but never reserve space ourselves: this
  // first version overlays the workspace and leaves its window layout intact.
  exclusiveZone: 0
  exclusionMode: ExclusionMode.Normal
  WlrLayershell.namespace: "companion-panel"
  WlrLayershell.layer: WlrLayer.Overlay
  // Activity never accepts keyboard input. Conversation tabs permit ordinary
  // compositor-directed focus so clicking the composer supports typing.
  WlrLayershell.keyboardFocus: root.opened && !root.showingPrevious && root.selectedSessionId
    ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.None

  // Only the compact body captures clicks. Leave the desktop below it usable,
  // and release input immediately when closing, before the slide finishes.
  mask: Region {
    x: card.x
    width: root.opened ? card.width : 0
    height: card.height
  }

  Behavior on reveal {
    NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
  }

  // The right/top anchors stay fixed while conversation overflow or a tab
  // change resizes the body. Behaviors retarget from the current size when
  // switching tabs mid-animation; hidden panels adopt their size immediately.
  Behavior on implicitWidth {
    enabled: root.opened && root.visible
    NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
  }

  Item {
    anchors.fill: parent
    clip: true

    BorderSurface {
      id: card
      x: (1 - root.reveal) * root.width
      width: root.width
      height: root.panelHeight
      color: Color.menu.background
      borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
      radius: Style.cornerRadius

      Behavior on height {
        enabled: root.opened && root.visible
        NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
      }

      Panel.PanelContent {
        id: content
        anchors.fill: parent
        anchors.margins: Math.max(1, Style.space(2))
        online: root.online
        paused: root.paused
        speaking: root.speaking
        processing: root.processing
        history: root.history
        sessions: root.sessions
        previousSessions: root.previousSessions
        showingPrevious: root.showingPrevious
        controlError: root.controlError
        selectedSessionId: root.selectedSessionId
        foreground: Color.menu.text
        muted: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.65)
        accent: Color.menu.selectedText
        selection: Color.menu.selectedBackground
        fontFamily: Style.font.menuFamily
        unit: Style.space(100) / 100
        animationsEnabled: root.opened && root.visible
        shortcutLabel: "Super + Alt + C · panel\nSuper + Alt + P · pause/resume"
        onCloseRequested: root.closeRequested()
        onPreviousRequested: root.previousRequested()
        onReopenSessionRequested: id => root.reopenSessionRequested(id)
        onScreenshotRequested: (source, title) => {
          root.screenshotTitle = title
          root.screenshotSource = source
        }
        onSessionSelected: id => root.sessionSelected(id)
        onStopSessionRequested: id => root.stopSessionRequested(id)
        onDismissSessionRequested: id => root.dismissSessionRequested(id)
        onSendSessionRequested: (id, text) => root.sendSessionRequested(id, text)
      }
    }
  }

  ScreenshotWindow {
    screen: root.selectedScreen
    source: root.screenshotSource
    title: root.screenshotTitle
    onDismissed: root.screenshotSource = ""
  }
}
