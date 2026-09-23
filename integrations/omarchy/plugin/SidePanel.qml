import QtQuick
import Quickshell
import Quickshell.Wayland
import Quickshell.Hyprland
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
  property string pauseReason: ""
  required property bool speaking
  required property int processing
  property var history: []
  property var intents: []
  property var activityHistoryModel: null
  property bool activityHistoryAvailable: false
  property bool historyDeletionAvailable: false
  property bool textInputAvailable: false
  property var agentActions: ({})
  property var sessions: []
  property var sessionControls: null
  property var unreadSessionIds: ({})
  property var previousSessions: []
  property bool showingPrevious: false
  property string controlError: ""
  property url screenshotSource: ""
  property string screenshotTitle: ""
  property string selectedSessionId: ""
  readonly property bool inputFocused: root.opened && content.inputFocused
  readonly property string composerFocusId: root.opened ? content.composerFocusId : ""
  readonly property string composerFocusPhase: focusControl.phase
  readonly property bool keyboardFocused: root.opened && content.keyboardFocused

  signal utteranceRequested(string text)
  signal closeRequested()
  signal intentEnabledRequested(string name, bool enabled, string mode)
  signal historyActionRequested(string action, string id, var value)
  signal sessionSelected(string id)
  signal previousRequested()
  signal reopenSessionRequested(string id)
  signal stopSessionRequested(string id)
  signal dismissSessionRequested(string id)
  signal sendSessionRequested(string id, string text)
  signal composerFocusRequested()
  signal composerFocusReleased()
  signal toolPageRequested(var request)
  function toolPageReceived(message) { content.toolPageReceived(message) }
  signal choiceRequested(string id, string revision, int index)
  signal stopRunRequested(string id, string runId)
  signal restoreFocusRequested(string address)

  onOpenedChanged: if (!opened) screenshotSource = ""
  onSelectedSessionIdChanged: screenshotSource = ""
  onShowingPreviousChanged: screenshotSource = ""

  function utteranceSubmitted(text, error) { content.utteranceSubmitted(text, error) }
  function submitted(id, text, error) { content.submitted(id, text, error) }
  function applyDraft(request) { return content.applyDraft(request) }
  function choiceSubmitted(id, revision, index, error) { content.choiceSubmitted(id, revision, index, error) }
  function toggleComposerFocus(address) {
    root.screenshotSource = ""
    focusControl.toggle(address, root.inputFocused)
  }
  function nextTab() { content.nextTab() }
  function resizeBy(logicalPixels) { surface.resizeBy(logicalPixels) }
  function releaseForInsertion(address) {
    root.screenshotSource = ""
    focusControl.previousWindow = address
    focusControl.toggle(address, true)
  }

  Panel.ComposerFocus {
    id: focusControl
    available: root.opened && root.online && root.selectedScreen !== null
      && root.screenshotSource.toString() === ""
    mapped: root.backingWindowVisible
    actualFocus: root.keyboardFocused
    sessionId: root.selectedSessionId
    onFocusRequested: {
      content.focusComposer()
      // Only the shortcut's acquisition path asks to quiet media. Ordinary tab
      // changes, clicks, focus release and cancelled acquisition do not.
      root.composerFocusRequested()
    }
    onReleaseRequested: {
      content.releaseComposerFocus()
      root.composerFocusReleased()
    }
    onRestoreRequested: address => root.restoreFocusRequested(address)
  }

  // The protocol both acquires keyboard focus and retains it until an outside
  // click or explicit release. An Exclusive -> OnDemand timer instead makes
  // Hyprland simulate mouse movement and refocus the app under the pointer.
  HyprlandFocusGrab {
    active: focusControl.grabRequested && root.backingWindowVisible
    windows: [root]
    onCleared: if (focusControl.grabRequested) focusControl.reset()
  }

  // Re-evaluate on hotplug rather than retaining a disconnected screen object.
  readonly property var selectedScreen: Monitors.chooseScreen(Quickshell.screens)
  readonly property string monitorName: selectedScreen ? selectedScreen.name : ""

  screen: selectedScreen
  visible: selectedScreen !== null && (opened || surface.reveal > 0)
  anchors { top: true; bottom: true; right: true }
  // Keep the native Wayland surface stable while the card slides. The input
  // region below excludes the transparent space beside it.
  implicitWidth: surface.width
  color: "transparent"

  // Respect the bar's reserved space but never reserve space ourselves: this
  // first version overlays the workspace and leaves its window layout intact.
  exclusiveZone: 0
  exclusionMode: ExclusionMode.Normal
  WlrLayershell.namespace: "companion-panel"
  WlrLayershell.layer: WlrLayer.Overlay
  // Clicks may focus Activity or a conversation. Keyboard summoning uses the
  // dismissible grab above; no timed interactivity change can steal it back.
  WlrLayershell.keyboardFocus: focusControl.keyboardMode === "on-demand" ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.None

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
      unit: Style.space(100) / 100
      availableWidth: root.selectedScreen ? root.selectedScreen.width : Style.space(600)

      BorderSurface {
        anchors.fill: parent
        color: Color.menu.background
        borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
        radius: Style.cornerRadius
      }

      Panel.PanelContent {
        id: content
        nativeWidgets: Qt.application.arguments.indexOf("--companion-native-widgets") >= 0
        anchors.fill: parent
        anchors.margins: Math.max(1, Style.space(2))
        online: root.online
        paused: root.paused
        pauseReason: root.pauseReason
        speaking: root.speaking
        processing: root.processing
        history: root.history
        intents: root.intents
        activityHistoryModel: root.activityHistoryModel
        activityHistoryAvailable: root.activityHistoryAvailable
        historyDeletionAvailable: root.historyDeletionAvailable
        textInputAvailable: root.textInputAvailable
        onUtteranceRequested: text => root.utteranceRequested(text)
        agentActions: root.agentActions
        sessions: root.sessions
        sessionControls: root.sessionControls
        unreadSessionIds: root.unreadSessionIds
        previousSessions: root.previousSessions
        showingPrevious: root.showingPrevious
        controlError: root.controlError
        selectedSessionId: root.selectedSessionId
        background: Color.menu.background
        foreground: Color.menu.text
        muted: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.65)
        accent: Color.menu.selectedText
        selection: Color.menu.selectedBackground
        tooltipBackground: Color.tooltip.background
        tooltipForeground: Color.tooltip.text
        tooltipBorder: Color.tooltip.border
        fontFamily: Style.font.menuFamily
        unit: Style.space(100) / 100
        animationsEnabled: root.opened && root.visible
        focusShortcut: "⌥⌘D"
        shortcutLabel: "Super + Alt + C · panel / D · input focus\nIn panel: Super + Alt + 0 · Activity / Tab · next tab\nIn panel: Alt + 1–9 · conversations / Super + − or = · width\nIn panel: Ctrl + plus/minus · text size / Ctrl + 0 · reset\nSuper + Alt + P · pause/resume"
        onCloseRequested: root.closeRequested()
        onIntentEnabledRequested: (name, enabled, mode) => root.intentEnabledRequested(name, enabled, mode)
        onHistoryActionRequested: (action, id, value) => root.historyActionRequested(action, id, value)
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
        onToolPageRequested: request => root.toolPageRequested(request)
        onChoiceRequested: (id, revision, index) => root.choiceRequested(id, revision, index)
        onStopRunRequested: (id, runId) => root.stopRunRequested(id, runId)
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
