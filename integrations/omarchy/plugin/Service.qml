import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "../../panel" as Panel

// This adapter owns Omarchy/Hyprland behavior. Companion only sees the portable
// JSON protocol documented in src/desktop/README.md.
Item {
  id: root

  property var shell: null
  property bool online: false
  property bool paused: false
  property bool speaking: false
  property bool soundsEnabled: false
  property bool soundsAvailable: false
  property int processing: 0
  property var history: []
  property string lastError: ""
  property string lastErrorAction: ""
  property bool opened: false
  property var rows: []
  property int selectedIndex: 0
  property string targetAddress: ""
  property string targetComposerId: ""
  property var pickerScreen: null
  property bool panelOpened: false
  property var pendingAgentInput: null
  readonly property var transport: connection.item

  Panel.AgentSessionState {
    id: agentSessions
    onRevealRequested: root.panelOpened = true
  }

  function togglePanel() {
    // The history picker and status panel have separate lifetimes. Dismissing
    // history here cancels it; opening the panel must never trigger a paste.
    root.cancel()
    root.panelOpened = !root.panelOpened
  }

  function closePanel() {
    root.panelOpened = false
  }

  function send(request) {
    if (!root.online) {
      return
    }

    transport.write(JSON.stringify(request) + "\n")
    transport.flush()
  }

  function togglePause() {
    root.send({ action: "toggle-pause" })
  }

  function toggleSounds() {
    root.send({ action: "toggle-sounds" })
  }

  function sendAgentInput(id, text) {
    if (!root.online) {
      sidePanel.submitted(id, text, "Companion is disconnected; your draft is retained.")
      return
    }
    root.pendingAgentInput = {id: id, text: text}
    root.send({action: "send-agent", id: id, text: text})
  }

  function finishAgentInput(error) {
    if (root.pendingAgentInput) {
      sidePanel.submitted(root.pendingAgentInput.id, root.pendingAgentInput.text, error)
      root.pendingAgentInput = null
    }
  }

  function receive(line) {
    try {
      const message = JSON.parse(line)

      if (message.type === "state" && message.protocol === 1) {
        root.paused = message.paused
        root.speaking = message.speaking === true
        root.soundsEnabled = message.soundsEnabled === true
        root.soundsAvailable = typeof message.soundsEnabled === "boolean" && !message.preview
        root.processing = message.processing
        root.history = message.history
        agentSessions.replace(message.sessions || [])
        agentSessions.previousSessions = message.previousSessions || []
        // Activate the panel only after its first/reconnected snapshot is ready,
        // so it never animates a stale phrase retained from the old connection.
        root.online = message.ready
      } else if (message.type === "agent-session") {
        agentSessions.update(message.session)
      } else if (message.type === "agent-history") {
        agentSessions.previousSessions = message.sessions || []
      } else if (message.type === "agent-restored") {
        agentSessions.restore(message.session)
      } else if (message.type === "agent-removed") {
        agentSessions.remove(message.id)
      } else if (message.type === "error") {
        if (message.action === "send-agent") root.finishAgentInput(message.message)
        root.lastError = message.message
        root.lastErrorAction = message.action || ""
      } else if (message.type === "result") {
        if (message.action === "send-agent") root.finishAgentInput("")
        if (message.result === "skipped") {
          root.lastError = "Paste skipped: focus changed"
          root.lastErrorAction = "paste"
        } else if (root.lastErrorAction === (message.action || "")) {
          // A delayed paste result must not hide an unrelated control error.
          root.lastError = ""
          root.lastErrorAction = ""
        }
      }
    } catch (error) {
      root.lastError = "Could not read Companion state"
    }
  }

  function begin() {
    if (root.opened) {
      return
    }

    // The activity panel keeps its own visibility while history is selected.
    // Both overlays leave keyboard focus in the destination application.
    // Snapshot rows at press time. Arriving speech must never move the selected
    // utterance underneath a held shortcut. A tap starts on the newest row.
    root.rows = root.history.slice()
    root.selectedIndex = 0
    const address = Hyprland.activeToplevel ? Hyprland.activeToplevel.address : ""
    root.targetAddress = address && !address.startsWith("0x") ? "0x" + address : address
    root.targetComposerId = sidePanel.composerFocusId
    const monitor = Hyprland.focusedMonitor
    root.pickerScreen = Quickshell.screens.find(screen => screen.name === monitor?.name) || null
    root.lastError = ""
    root.opened = true
  }

  function moveSelection(delta) {
    root.selectedIndex = Math.max(0, Math.min(root.rows.length - 1, root.selectedIndex + delta))
  }

  function cancel() {
    root.opened = false
  }

  function release() {
    if (!root.opened) {
      return
    }

    root.opened = false
    const row = root.rows[root.selectedIndex]

    if (root.online && row && root.targetAddress) {
      root.send({ action: "paste", id: row.id, target: root.targetAddress, composer: root.targetComposerId })
    }
  }

  // Handle only the press: the matching release must not immediately resume.
  // Reuse the menu's socket action so the backend remains the source of state.
  GlobalShortcut {
    appid: "companion"
    name: "pause"
    description: "Pause or resume Companion listening"
    onPressed: root.togglePause()
  }

  GlobalShortcut {
    appid: "companion"
    name: "panel"
    description: "Toggle Companion side panel"
    onPressed: root.togglePanel()
  }

  // Only finish completes a chord, after V and both modifiers are up. Hyprland
  // also releases history on V-up, which is too early when modifiers remain.
  // Both shortcuts use this resident connection, so a tap cannot race startup.
  GlobalShortcut {
    appid: "companion"
    name: "history"
    description: "Hold for speech history; release to paste"
    onPressed: root.begin()
  }

  GlobalShortcut {
    appid: "companion"
    name: "previous"
    onPressed: { if (root.opened) root.moveSelection(-1) }
  }

  GlobalShortcut {
    appid: "companion"
    name: "next"
    onPressed: { if (root.opened) root.moveSelection(1) }
  }

  GlobalShortcut {
    appid: "companion"
    name: "cancel"
    onPressed: root.cancel()
  }

  GlobalShortcut {
    appid: "companion"
    name: "finish"
    onReleased: root.release()
  }

  // Small diagnostic/control surface for CLI use and the opt-in desktop test.
  // Transcript contents remain on Companion's private socket, not in status.
  IpcHandler {
    target: "companion"
    function status(): string {
      return JSON.stringify({ online: root.online, paused: root.paused,
        speaking: root.speaking, processing: root.processing,
        soundsEnabled: root.soundsEnabled, soundsAvailable: root.soundsAvailable,
        opened: root.opened, selectedIndex: root.selectedIndex,
        panelOpened: root.panelOpened, panelVisible: sidePanel.visible,
        panelMonitor: sidePanel.monitorName,
        count: root.history.length, error: root.lastError })
    }
    function togglePause(): void { root.togglePause() }
    function toggleSounds(): void { root.toggleSounds() }
    function cancel(): void { root.cancel() }
    function togglePanel(): void { root.togglePanel() }
    function closePanel(): void { root.closePanel() }
  }

  function connectionLost() {
    root.finishAgentInput("Connection lost before confirmation. Check the conversation before resending; your draft is retained.")
    root.online = false
    root.speaking = false
    root.processing = 0
    root.history = []
    root.cancel()

    // Quickshell's Socket retains its native socket after a failed initial
    // connect. Recreate the object instead of toggling its connected property.
    // Defer destruction until the native error signal has returned.
    Qt.callLater(() => { connection.active = false })
  }

  Loader {
    id: connection
    active: false
    sourceComponent: Component {
      Socket {
        path: Quickshell.env("XDG_RUNTIME_DIR") + "/companion/control.sock"
        parser: SplitParser {
          onRead: data => root.receive(data)
        }
        Component.onCompleted: connected = true
        onConnectedChanged: {
          if (!connected) {
            root.connectionLost()
          }
        }
        onError: root.connectionLost()
      }
    }
  }

  // Avoid logging a native socket error every second while Companion is
  // intentionally stopped. Probe existence before creating a connection.
  Process {
    id: socketProbe
    command: ["test", "-S", Quickshell.env("XDG_RUNTIME_DIR") + "/companion/control.sock"]
    onExited: code => {
      if (code === 0) {
        connection.active = true
      }
    }
  }

  Component.onCompleted: socketProbe.running = true

  Timer {
    interval: 1000
    running: true
    repeat: true
    onTriggered: {
      if (!connection.active && !socketProbe.running) {
        socketProbe.running = true
      }
    }
  }

  HistoryPicker {
    id: picker
    opened: root.opened
    online: root.online
    rows: root.rows
    selectedIndex: root.selectedIndex
    pickerScreen: root.pickerScreen
    onCancelled: root.cancel()
  }

  // Leave the panel open on socket loss so it can explain the offline state
  // and visibly reconnect when Companion starts again.
  SidePanel {
    id: sidePanel
    opened: root.panelOpened
    online: root.online
    paused: root.paused
    speaking: root.speaking
    processing: root.processing
    history: root.history
    sessions: agentSessions.sessions
    previousSessions: agentSessions.previousSessions
    showingPrevious: agentSessions.showingPrevious
    controlError: ["close-agent", "reopen-agent", "stop-agent"].includes(root.lastErrorAction) ? root.lastError : ""
    selectedSessionId: agentSessions.selectedId
    onCloseRequested: root.closePanel()
    onSessionSelected: id => {
      agentSessions.showingPrevious = false
      agentSessions.selectedId = id
    }
    onPreviousRequested: agentSessions.showingPrevious = true
    onReopenSessionRequested: id => root.send({action: "reopen-agent", id: id})
    onStopSessionRequested: id => root.send({action: "stop-agent", id: id})
    onDismissSessionRequested: id => root.send({action: "close-agent", id: id})
    onSendSessionRequested: (id, text) => root.sendAgentInput(id, text)
    onComposerFocusIdChanged: root.send({action: "composer-focus", id: composerFocusId})
  }
}
