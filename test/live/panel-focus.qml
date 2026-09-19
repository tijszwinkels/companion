import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "omarchy/plugin" as Companion

// Only used inside the private compositor owned by nested-hyprland.py.
ShellRoot {
  id: root
  property var activeWindow: Hyprland.activeToplevel
  property int toggleCount: 0
  property string previousApplication: ""

  function findItem(item, name) {
    if (item.objectName === name) return item
    for (const child of item.children || []) {
      const found = findItem(child, name)
      if (found) return found
    }
    return null
  }
  function toggleFocus() {
    root.toggleCount++
    const previous = root.activeWindow ? root.activeWindow.address : ""
    const address = previous && !previous.startsWith("0x") ? "0x" + previous : previous
    root.previousApplication = address
    panel.opened = true
    panel.toggleComposerFocus(address)
  }

  FloatingWindow {
    id: application
    title: "Companion focus fixture"
    visible: true
    implicitWidth: 640
    implicitHeight: 600
    TextInput {
      id: applicationInput
      anchors.fill: parent
      focus: true
      color: "white"
    }
  }

  FloatingWindow {
    id: otherApplication
    title: "Companion other focus fixture"
    visible: true
    implicitWidth: 320
    implicitHeight: 400
  }

  // Exercise the production restore helper too. This service has no backend:
  // the private runtime directory contains no Companion control socket.
  Companion.Service { id: adapter }

  Companion.SidePanel {
    id: panel
    opened: true
    online: true
    paused: false
    speaking: false
    processing: 0
    selectedSessionId: "fixture"
    onComposerFocusIdChanged: console.log("fixture composer:", composerFocusId)
    onComposerFocusPhaseChanged: console.log("fixture phase:", composerFocusPhase)
    sessions: [
      {id: "fixture", title: "Focus fixture", status: "completed", error: "", messages: [
        {id: "answer", kind: "assistant", text: "A useful answer to copy.", toolName: "", input: "", state: "done", screenshot: false}
      ]},
      {id: "fixture-two", title: "Second fixture", status: "completed", error: "", messages: []}
    ]
    onSessionSelected: id => selectedSessionId = id
    onRestoreFocusRequested: address => adapter.restoreApplicationFocus(address)
  }

  GlobalShortcut {
    appid: "FOCUS_FIXTURE_ID"
    name: "focus"
    onPressed: root.toggleFocus()
  }
  IpcHandler {
    target: "fixture"
    function state(): string {
      const input = root.findItem(panel.contentItem, "sessionComposer")
      return JSON.stringify({focused: panel.composerFocusId, phase: panel.composerFocusPhase,
        toggles: root.toggleCount,
        otherApplicationActive: otherApplication.contentItem.Window.window.active,
        applicationActive: applicationInput.Window.window.active,
        applicationWidth: application.width,
        applicationText: applicationInput.text, composerText: input ? input.text : null})
    }
    function closePanel(): void { panel.opened = false }
    function insertHistory(id: string): void { adapter.historyAction("paste", id, {}) }
    function labelHistory(id: string): void { adapter.historyAction("label-history", id, {correct: false, actualIntent: "START_CODING_AGENT_SESSION"}) }
    function startHistoryAgent(id: string): void { adapter.historyAction("start-history-agent", id, {}) }
    function restoreApplication(): void { adapter.restoreApplicationFocus(root.previousApplication) }
    function selectAnswer(): void {
      const bubble = root.findItem(panel.contentItem, "bubble-answer")
      root.findItem(bubble, "messageText").select(2, 8)
    }
  }
}
