import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland

// This adapter owns Omarchy/Hyprland behavior. Companion only sees the portable
// JSON protocol documented in src/desktop/README.md.
Item {
  id: root

  property var shell: null
  property bool online: false
  property bool paused: false
  property bool soundsEnabled: false
  property bool soundsAvailable: false
  property int processing: 0
  property var history: []
  property string lastError: ""
  property bool opened: false
  property var rows: []
  property int selectedIndex: 0
  property string targetAddress: ""
  property var pickerScreen: null
  readonly property var transport: connection.item

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

  function receive(line) {
    try {
      const message = JSON.parse(line)

      if (message.type === "state" && message.protocol === 1) {
        root.online = message.ready
        root.paused = message.paused
        root.soundsEnabled = message.soundsEnabled === true
        root.soundsAvailable = typeof message.soundsEnabled === "boolean" && !message.preview
        root.processing = message.processing
        root.history = message.history
      } else if (message.type === "error") {
        root.lastError = message.message
      } else if (message.type === "result") {
        root.lastError = message.result === "skipped" ? "Paste skipped: focus changed" : ""
      }
    } catch (error) {
      root.lastError = "Could not read Companion state"
    }
  }

  function begin() {
    if (root.opened) {
      return
    }

    // Snapshot rows at press time. Arriving speech must never move the selected
    // utterance underneath a held shortcut. A tap starts on the newest row.
    root.rows = root.history.slice()
    root.selectedIndex = 0
    const address = Hyprland.activeToplevel ? Hyprland.activeToplevel.address : ""
    root.targetAddress = address && !address.startsWith("0x") ? "0x" + address : address
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
      root.send({ action: "paste", id: row.id, target: root.targetAddress })
    }
  }

  // The compositor sends both events to this already-running service. Unlike
  // spawning separate press/release commands, a quick tap cannot race startup.
  GlobalShortcut {
    appid: "companion"
    name: "history"
    description: "Hold for speech history; release to paste"
    onPressed: root.begin()
    onReleased: root.release()
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
        soundsEnabled: root.soundsEnabled, soundsAvailable: root.soundsAvailable,
        opened: root.opened, selectedIndex: root.selectedIndex,
        count: root.history.length, error: root.lastError })
    }
    function togglePause(): void { root.togglePause() }
    function toggleSounds(): void { root.toggleSounds() }
    function cancel(): void { root.cancel() }
  }

  function connectionLost() {
    root.online = false
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
}
