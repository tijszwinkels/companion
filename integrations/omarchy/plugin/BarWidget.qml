import QtQuick
import qs.Ui

BarWidget {
  id: root
  moduleName: "companion.desktop"
  readonly property var companion: bar?.shell?.serviceFor("companion.desktop") ?? null
  readonly property bool online: companion?.online ?? false
  readonly property bool paused: companion?.paused ?? false

  implicitWidth: button.implicitWidth
  implicitHeight: barSize

  BarIconButton {
    id: button
    bar: root.bar
    text: root.online && !root.paused ? "󰍬" : "󰍭"
    dimmed: !root.online
    active: root.paused
    pressable: root.online
    tooltipText: !root.online ? "Companion is not running"
      : root.companion.lastError ? root.companion.lastError
      : root.paused ? "Companion paused · Click to resume"
      : root.companion.processing > 0 ? "Companion processing · Click to pause"
      : "Companion listening · Click to pause"
    onPressed: button => {
      if (button === Qt.LeftButton && root.companion) {
        root.companion.togglePause()
      }
    }
  }
}
