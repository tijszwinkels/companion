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
  readonly property string composerFocusPhase: focusControl.phase

  signal closeRequested()
  signal sessionSelected(string id)
  signal previousRequested()
  signal reopenSessionRequested(string id)
  signal stopSessionRequested(string id)
  signal dismissSessionRequested(string id)
  signal sendSessionRequested(string id, string text)
  signal restoreFocusRequested(string address)

  onOpenedChanged: if (!opened) screenshotSource = ""
  onSelectedSessionIdChanged: screenshotSource = ""
  onShowingPreviousChanged: screenshotSource = ""

  function submitted(id, text, error) { content.submitted(id, text, error) }
  function toggleComposerFocus(address) {
    root.screenshotSource = ""
    focusControl.toggle(address)
  }

  Panel.ComposerFocus {
    id: focusControl
    available: root.opened && root.online && root.selectedScreen !== null && !root.showingPrevious
      && root.screenshotSource.toString() === "" && content.selectedSession !== null
    mapped: root.backingWindowVisible
    actualFocus: root.composerFocusId !== ""
    sessionId: root.selectedSessionId
    onFocusRequested: content.focusComposer()
    onReleaseRequested: content.releaseComposerFocus()
    onRestoreRequested: address => root.restoreFocusRequested(address)
  }

  // Re-evaluate on hotplug rather than retaining a disconnected screen object.
  readonly property var selectedScreen: Monitors.chooseScreen(Quickshell.screens)
  readonly property string monitorName: selectedScreen ? selectedScreen.name : ""

  screen: selectedScreen
  visible: selectedScreen !== null && (opened || surface.reveal > 0)
  anchors { top: true; bottom: true; right: true }
  // Keep the native Wayland surface stable while the card slides/resizes. The
  // input region below excludes all transparent space beside and above it.
  implicitWidth: Math.min(Style.space(600), selectedScreen ? selectedScreen.width : Style.space(600))
  color: "transparent"

  // Respect the bar's reserved space but never reserve space ourselves: this
  // first version overlays the workspace and leaves its window layout intact.
  exclusiveZone: 0
  exclusionMode: ExclusionMode.Normal
  WlrLayershell.namespace: "companion-panel"
  WlrLayershell.layer: WlrLayer.Overlay
  // Like Omarchy's KeyboardPanel, explicitly summoned focus uses a 75ms
  // Exclusive prime, then OnDemand so normal clicks can leave the panel.
  // Activity, history, viewer transitions and toggle-off relinquish the keys.
  WlrLayershell.keyboardFocus: focusControl.keyboardMode === "exclusive" ? WlrKeyboardFocus.Exclusive
    : focusControl.keyboardMode === "on-demand" ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.None

  // Only the visible body captures clicks. Leave the surrounding desktop usable,
  // and release input immediately when closing, before the slide finishes.
  mask: Region {
    x: surface.x
    y: surface.y
    width: root.opened ? surface.width : 0
    height: surface.height
  }

  Item {
    anchors.fill: parent
    clip: true

    Panel.PanelSurface {
      id: surface
      opened: root.opened
      expanded: content.expanded
      unit: Style.space(100) / 100

      BorderSurface {
        anchors.fill: parent
        color: Color.menu.background
        borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
        radius: Style.cornerRadius
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
        shortcutLabel: "Super + Alt + C · panel\nSuper + Alt + A · conversation focus\nSuper + Alt + P · pause/resume"
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
