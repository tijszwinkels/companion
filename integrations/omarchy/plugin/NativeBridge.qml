import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons

// Optional local connection to Companion's own Qt process. The installed shell
// remains the owner of global shortcuts, media players and compositor focus.
Item {
  id: root
  property bool ready: false
  property var status: ({})
  readonly property var theme: ({background: Color.menu.background.toString(),
    foreground: Color.menu.text.toString(), accent: Color.menu.selectedText.toString(),
    muted: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.65).toString(),
    selection: Color.menu.selectedBackground.toString(), tooltipBackground: Color.tooltip.background.toString(),
    tooltipForeground: Color.tooltip.text.toString(), tooltipBorder: Color.tooltip.border.toString(),
    fontFamily: Style.font.menuFamily, unit: Style.space(100) / 100})
  signal event(var message)
  onThemeChanged: root.send({action: "theme", values: root.theme})

  function send(message) {
    if (!connection.item || !connection.item.connected) return false
    connection.item.write(JSON.stringify(message) + "\n")
    connection.item.flush()
    return true
  }
  function lost() {
    root.ready = false
    root.status = ({})
    Qt.callLater(() => { connection.active = false })
  }
  Loader {
    id: connection
    active: false
    sourceComponent: Component {
      Socket {
        path: Quickshell.env("XDG_RUNTIME_DIR") + "/companion/ui.sock"
        parser: SplitParser {
          onRead: line => {
            try {
              const message = JSON.parse(line)
              if (message.type === "status" && message.protocol === 1) {
                root.status = message
                root.ready = true
              } else if (message.type !== "ack") root.event(message)
            } catch (error) { root.lost() }
          }
        }
        Component.onCompleted: connected = true
        onConnectedChanged: {
          if (connected) {
            // Socket can connect while Loader is still constructing its item.
            // Defer writes until the transport is published by the Loader.
            Qt.callLater(function() {
              root.send({action: "bridge"})
              root.send({action: "theme", values: root.theme})
            })
          } else root.lost()
        }
        onError: root.lost()
      }
    }
  }
  Process {
    id: probe
    command: ["test", "-S", Quickshell.env("XDG_RUNTIME_DIR") + "/companion/ui.sock"]
    onExited: code => { if (code === 0) connection.active = true }
  }
  Timer {
    interval: 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: if (!connection.active && !probe.running) probe.running = true
  }
}
