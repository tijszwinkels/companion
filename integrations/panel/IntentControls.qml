import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The router supplies both lists. This view never guesses registrations or
// updates a switch optimistically: its color follows the backend's snapshot.
Item {
  id: root
  required property var intents
  required property bool online
  required property bool paused
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  signal intentEnabledRequested(string name, bool enabled)

  readonly property var shortcuts: {
    const labels = [];
    for (const intent of intents) {
      if (intent.enabled && intent.prefixAvailable) {
        for (const prefix of intent.prefixes)
          labels.push({
            prefix: prefix,
            label: intent.label,
            standalone: intent.acceptsEmptyPrefix === true
          });
      }
    }
    return labels;
  }

  implicitHeight: contents.height
  height: implicitHeight

  Column {
    id: contents
    width: root.width
    spacing: 16 * root.unit

    CollapsibleSection {
      objectName: "voiceSection"
      width: parent.width
      title: "Voice shortcuts"
      detail: String(root.shortcuts.length)
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit

      Flow {
        width: parent.width
        spacing: 10 * root.unit
        Repeater {
          model: root.shortcuts
          Rectangle {
            required property var modelData
            objectName: "voice-" + modelData.prefix
            width: Math.min(parent.width, shortcutText.implicitWidth + 24 * root.unit)
            height: shortcutText.height + 18 * root.unit
            radius: height / 2
            color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.08)
            border.color: root.online && !root.paused ? root.accent : root.muted
            opacity: root.online && !root.paused ? 1 : 0.45
            Text {
              id: shortcutText
              anchors.centerIn: parent
              width: Math.min(implicitWidth, parent.width - 24 * root.unit)
              text: modelData.prefix + (modelData.standalone ? "" : " …")
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.accent
              font.family: root.fontFamily
              font.pixelSize: 13 * root.unit
            }
            Accessible.role: Accessible.StaticText
            Accessible.name: modelData.prefix + ": " + modelData.label
          }
        }
      }

      Text {
        width: parent.width
        text: !root.online ? "Connect Companion to use voice shortcuts." : root.paused ? "Resume listening to use voice shortcuts." : root.shortcuts.length ? "Say a shortcut; add your text where shown by …" : "No voice shortcuts are enabled in this context."
        wrapMode: Text.WordWrap
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 12 * root.unit
      }
    }

    CollapsibleSection {
      objectName: "intentionsSection"
      width: parent.width
      title: "Intentions"
      detail: "Click to toggle"
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit

      GridLayout {
        width: parent.width
        columns: width >= 440 * root.unit ? 2 : 1
        columnSpacing: 10 * root.unit
        rowSpacing: 10 * root.unit
        Repeater {
          model: root.intents
          Rectangle {
            id: chip
            required property int index
            required property var modelData
            objectName: "intent-" + modelData.name
            readonly property bool available: modelData.inferenceAvailable || modelData.prefixAvailable
            readonly property bool active: root.online && !root.paused && modelData.enabled && available
            readonly property string stateText: !modelData.enabled ? "Off" : !available ? "Needs conversation context" : !modelData.toggleable ? "Always on" : !modelData.inferenceAvailable ? "On · shortcut only" : modelData.prefixAvailable ? "On · intent + shortcut" : "On · intent"
            Layout.fillWidth: true
            Layout.columnSpan: index === root.intents.length - 1 && root.intents.length % 2 === 1 ? parent.columns : 1
            Layout.preferredWidth: 1
            Layout.minimumWidth: 0
            Layout.preferredHeight: Math.max(78 * root.unit, labels.height + 28 * root.unit)
            Layout.fillHeight: true
            radius: 10 * root.unit
            color: active ? root.selection : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.08)
            border.color: mouse.containsMouse && modelData.toggleable ? root.accent : active ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.55) : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.2)

            Rectangle {
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: 14 * root.unit
              width: 6 * root.unit
              height: width
              radius: width / 2
              color: chip.active ? root.accent : root.muted
              opacity: chip.active ? 1 : 0.4
            }

            Column {
              id: labels
              objectName: "intentCardText"
              x: 14 * root.unit
              anchors.verticalCenter: parent.verticalCenter
              width: Math.max(0, parent.width - 40 * root.unit)
              spacing: 6 * root.unit
              Text {
                id: intentLabel
                width: parent.width
                text: chip.modelData.label
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: chip.active ? root.foreground : root.muted
                font.family: root.fontFamily
                font.pixelSize: 13 * root.unit
              }
              Text {
                id: stateLabel
                width: parent.width
                text: chip.stateText
                wrapMode: Text.WordWrap
                color: chip.active ? root.accent : root.muted
                font.family: root.fontFamily
                font.pixelSize: 11 * root.unit
              }
              Flow {
                objectName: "intentCardShortcuts"
                width: parent.width
                spacing: 5 * root.unit
                Repeater {
                  model: chip.modelData.prefixes
                  Rectangle {
                    required property string modelData
                    width: Math.min(parent.width, prefixLabel.implicitWidth + 12 * root.unit)
                    height: prefixLabel.height + 8 * root.unit
                    radius: 4 * root.unit
                    color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, chip.active ? 0.10 : 0.035)
                    Text {
                      id: prefixLabel
                      anchors.centerIn: parent
                      width: Math.min(implicitWidth, parent.width - 12 * root.unit)
                      text: modelData + (chip.modelData.acceptsEmptyPrefix ? "" : " …")
                      textFormat: Text.PlainText
                      wrapMode: Text.Wrap
                      color: chip.active ? root.accent : root.muted
                      font.family: root.fontFamily
                      font.pixelSize: 10 * root.unit
                    }
                  }
                }
              }
            }
            MouseArea {
              id: mouse
              anchors.fill: parent
              enabled: root.online
              hoverEnabled: true
              cursorShape: chip.modelData.toggleable ? Qt.PointingHandCursor : Qt.ArrowCursor
              onClicked: if (chip.modelData.toggleable)
                root.intentEnabledRequested(chip.modelData.name, !chip.modelData.enabled)
            }
            ToolTip {
              id: intentTip
              visible: mouse.containsMouse
              delay: 400
              text: chip.modelData.name + (chip.modelData.toggleable ? "" : "\nRequired no-action fallback")
              background: Rectangle {
                color: root.selection
                border.color: root.muted
                radius: 4 * root.unit
              }
              contentItem: Text {
                text: intentTip.text
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: 11 * root.unit
              }
            }
            Accessible.role: Accessible.CheckBox
            Accessible.name: chip.modelData.label + ": " + chip.stateText
            Accessible.checkable: chip.modelData.toggleable
            Accessible.checked: chip.modelData.enabled
            Accessible.onToggleAction: if (root.online && chip.modelData.toggleable)
              root.intentEnabledRequested(chip.modelData.name, !chip.modelData.enabled)
          }
        }
      }
      Text {
        width: parent.width
        visible: root.intents.length === 0
        text: "Restart Companion to load intent controls."
        wrapMode: Text.WordWrap
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 11 * root.unit
      }
    }
  }
}
