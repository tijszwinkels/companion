import QtQuick
import qs.Ui
import qs.Commons

BarWidget {
  id: root
  moduleName: "companion.desktop"
  readonly property var companion: bar?.shell?.serviceFor("companion.desktop") ?? null
  readonly property bool online: companion?.online ?? false
  readonly property bool paused: companion?.paused ?? false
  property bool popupOpen: false

  function close() {
    root.popupOpen = false
  }

  onOnlineChanged: {
    if (!online) {
      root.close()
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: barSize

  BarIconButton {
    id: button
    bar: root.bar
    text: root.online && !root.paused ? "󰍬" : "󰍭"
    dimmed: !root.online
    active: root.paused || root.popupOpen
    // Processing takes precedence while the microphone continues listening.
    // Opening the menu must not replace the status color with the bar accent.
    useActiveColor: false
    foreground: !root.online || root.paused ? (root.bar ? root.bar.barForeground : Color.foreground)
      : root.companion.processing > 0 ? "#66bb6a" : "#ef5350"
    pressable: root.online
    tooltipText: !root.online ? "Companion is not running"
      : root.companion.lastError ? root.companion.lastError
      : root.paused ? "Companion paused · Click for controls"
      : root.companion.processing > 0 ? "Companion processing · Click for controls"
      : "Companion listening · Click for controls"
    onPressed: button => {
      if (button === Qt.LeftButton && root.online) {
        root.popupOpen = !root.popupOpen
      }
    }
  }

  // Use the shell's shared popup so positioning, theme, and outside-click
  // dismissal follow the other bar controls. State comes from Companion.
  PopupCard {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: popup.fittedContentWidth(Style.space(280))
    contentHeight: popup.fittedContentHeight(controls.implicitHeight)

    Column {
      id: controls
      anchors.fill: parent
      spacing: Style.space(10)

      Toggle {
        width: parent.width
        label: "Listening"
        description: root.paused ? "Paused" : "Microphone active"
        checked: !root.paused
        enabled: root.online
        onClicked: root.companion.togglePause()
      }

      Toggle {
        width: parent.width
        label: "Sound effects"
        description: !root.companion?.soundsAvailable ? "Unavailable in this session"
          : checked ? "Bleeps on" : "Muted"
        checked: root.companion?.soundsEnabled ?? false
        enabled: root.online && (root.companion?.soundsAvailable ?? false)
        opacity: enabled ? 1 : 0.5
        onClicked: root.companion.toggleSounds()
      }
    }
  }
}
