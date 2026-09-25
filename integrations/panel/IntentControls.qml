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
  property real textScale: unit
  // {enabled: bool} from the listener, or null when it has no cleanup support.
  property var transcriptionCleanup: null
  signal intentEnabledRequested(string name, bool enabled, string mode)
  signal transcriptionCleanupRequested(bool enabled)

  // Older listeners cannot honor independent switches; avoid silently changing
  // both modes if this UI was refreshed before its backend was restarted.
  readonly property bool separateModes: intents.length > 0 && intents.every(intent => intent.supportsInference !== undefined)
  readonly property color shortcutColor: "#d8b77a"
  readonly property var routes: {
    const entries = [];
    for (const intent of intents) {
      if (intent.supportsInference === true || (!root.separateModes && intent.inferenceAvailable))
        entries.push({intent: intent, mode: "inference"});
      if (intent.prefixes.length)
        entries.push({intent: intent, mode: "shortcut"});
    }
    return entries;
  }

  readonly property var shortcuts: {
    const labels = [];
    for (const intent of intents) {
      if ((intent.shortcutEnabled === undefined ? intent.enabled : intent.shortcutEnabled) && intent.prefixAvailable) {
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
      textScale: root.textScale

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
              font.pixelSize: 13 * root.textScale
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
        font.pixelSize: 12 * root.textScale
      }
    }

    CollapsibleSection {
      objectName: "intentionsSection"
      width: parent.width
      title: "Intentions"
      detail: "Intent / Shortcut · click separately"
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit
      textScale: root.textScale

      // One switch for automatic transcription cleanup of every text route.
      // Like the route chips, its state follows the backend snapshot only.
      Rectangle {
        id: cleanupChip
        readonly property bool available: root.transcriptionCleanup !== null && root.transcriptionCleanup !== undefined
        readonly property bool cleanupEnabled: available && root.transcriptionCleanup.enabled === true
        readonly property bool active: root.online && cleanupEnabled
        readonly property color cleanupColor: "#8fcf9f"
        readonly property string stateText: cleanupEnabled ? "On · text routes get cleaned-up text" : "Off · raw transcript"
        objectName: "transcriptionCleanupSwitch"
        visible: available
        width: parent.width
        height: visible ? cleanupLabels.height + 28 * root.unit : 0
        radius: 10 * root.unit
        color: active ? Qt.rgba(cleanupColor.r, cleanupColor.g, cleanupColor.b, 0.1) : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.08)
        border.color: cleanupMouse.containsMouse ? cleanupColor : active ? Qt.rgba(cleanupColor.r, cleanupColor.g, cleanupColor.b, 0.55) : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.2)

        Rectangle {
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.margins: 14 * root.unit
          width: 6 * root.unit
          height: width
          radius: width / 2
          color: cleanupChip.active ? cleanupChip.cleanupColor : root.muted
          opacity: cleanupChip.active ? 1 : 0.4
        }

        Column {
          id: cleanupLabels
          x: 14 * root.unit
          anchors.verticalCenter: parent.verticalCenter
          width: Math.max(0, parent.width - 40 * root.unit)
          spacing: 6 * root.unit
          Text {
            width: parent.width
            text: "Clean up transcriptions"
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: cleanupChip.active ? root.foreground : root.muted
            font.family: root.fontFamily
            font.pixelSize: 13 * root.textScale
          }
          Text {
            objectName: "transcriptionCleanupState"
            width: parent.width
            text: "Cleanup · " + cleanupChip.stateText
            wrapMode: Text.WordWrap
            color: cleanupChip.active ? cleanupChip.cleanupColor : root.muted
            font.family: root.fontFamily
            font.pixelSize: 11 * root.textScale
          }
        }
        MouseArea {
          id: cleanupMouse
          anchors.fill: parent
          enabled: root.online && cleanupChip.available
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.transcriptionCleanupRequested(!cleanupChip.cleanupEnabled)
        }
        ToolTip {
          id: cleanupTip
          visible: cleanupMouse.containsMouse
          delay: 400
          text: "Removes filler words and fixes punctuation before text is typed or sent.\nHistory keeps the raw transcript next to the cleaned text."
          background: Rectangle {
            color: root.selection
            border.color: root.muted
            radius: 4 * root.unit
          }
          contentItem: Text {
            text: cleanupTip.text
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: 11 * root.textScale
          }
        }
        Accessible.role: Accessible.CheckBox
        Accessible.name: "Clean up transcriptions: " + cleanupChip.stateText
        Accessible.checkable: true
        Accessible.checked: cleanupChip.cleanupEnabled
        Accessible.onToggleAction: if (root.online && cleanupChip.available)
          root.transcriptionCleanupRequested(!cleanupChip.cleanupEnabled)
      }

      GridLayout {
        width: parent.width
        columns: width >= 440 * root.unit ? 2 : 1
        columnSpacing: 10 * root.unit
        rowSpacing: 10 * root.unit
        Repeater {
          model: root.routes
          Rectangle {
            id: chip
            required property int index
            required property var modelData
            readonly property var intent: modelData.intent
            readonly property bool inference: modelData.mode === "inference"
            readonly property bool routeEnabled: inference ? intent.inferenceEnabled === true : intent.shortcutEnabled === true
            readonly property bool available: inference ? intent.inferenceAvailable : intent.prefixAvailable
            readonly property bool active: root.online && !root.paused && routeEnabled && available
            readonly property color routeColor: inference ? root.accent : root.shortcutColor
            readonly property string modeLabel: inference ? "Intent" : "Shortcut"
            readonly property string stateText: !routeEnabled ? "Off" : !available ? "Needs conversation context" : !intent.toggleable ? "Always on" : "On"
            objectName: (inference ? "intent-" : "shortcut-") + intent.name
            Layout.fillWidth: true
            Layout.columnSpan: index === root.routes.length - 1 && root.routes.length % 2 === 1 ? parent.columns : 1
            Layout.preferredWidth: 1
            Layout.minimumWidth: 0
            Layout.preferredHeight: Math.max(78 * root.unit, labels.height + 28 * root.unit)
            Layout.fillHeight: true
            radius: 10 * root.unit
            color: active ? Qt.rgba(routeColor.r, routeColor.g, routeColor.b, 0.1) : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.08)
            border.color: mouse.containsMouse && intent.toggleable ? routeColor : active ? Qt.rgba(routeColor.r, routeColor.g, routeColor.b, 0.55) : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.2)

            Rectangle {
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: 14 * root.unit
              width: 6 * root.unit
              height: width
              radius: width / 2
              color: chip.active ? chip.routeColor : root.muted
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
                text: chip.intent.label
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: chip.active ? root.foreground : root.muted
                font.family: root.fontFamily
                font.pixelSize: 13 * root.textScale
              }
              Text {
                id: stateLabel
                width: parent.width
                text: chip.modeLabel + " · " + chip.stateText
                wrapMode: Text.WordWrap
                color: chip.active ? chip.routeColor : root.muted
                font.family: root.fontFamily
                font.pixelSize: 11 * root.textScale
              }
              Flow {
                objectName: "intentCardShortcuts"
                width: parent.width
                spacing: 5 * root.unit
                Repeater {
                  model: chip.inference ? [] : chip.intent.prefixes
                  Rectangle {
                    required property string modelData
                    width: Math.min(parent.width, prefixLabel.implicitWidth + 12 * root.unit)
                    height: prefixLabel.height + 8 * root.unit
                    radius: 4 * root.unit
                    color: Qt.rgba(chip.routeColor.r, chip.routeColor.g, chip.routeColor.b, chip.active ? 0.10 : 0.035)
                    Text {
                      id: prefixLabel
                      anchors.centerIn: parent
                      width: Math.min(implicitWidth, parent.width - 12 * root.unit)
                      text: modelData + (chip.intent.acceptsEmptyPrefix ? "" : " …")
                      textFormat: Text.PlainText
                      wrapMode: Text.Wrap
                      color: chip.active ? chip.routeColor : root.muted
                      font.family: root.fontFamily
                      font.pixelSize: 10 * root.textScale
                    }
                  }
                }
              }
            }
            MouseArea {
              id: mouse
              anchors.fill: parent
              enabled: root.online && root.separateModes
              hoverEnabled: true
              cursorShape: chip.intent.toggleable ? Qt.PointingHandCursor : Qt.ArrowCursor
              onClicked: if (chip.intent.toggleable)
                root.intentEnabledRequested(chip.intent.name, !chip.routeEnabled, chip.modelData.mode)
            }
            ToolTip {
              id: intentTip
              visible: mouse.containsMouse
              delay: 400
              text: chip.intent.name + (chip.intent.toggleable ? "" : "\nRequired no-action fallback")
              background: Rectangle {
                color: root.selection
                border.color: root.muted
                radius: 4 * root.unit
              }
              contentItem: Text {
                text: intentTip.text
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: 11 * root.textScale
              }
            }
            Accessible.role: Accessible.CheckBox
            Accessible.name: chip.intent.label + ": " + chip.modeLabel + " · " + chip.stateText
            Accessible.checkable: chip.intent.toggleable
            Accessible.checked: chip.routeEnabled
            Accessible.onToggleAction: if (root.online && root.separateModes && chip.intent.toggleable)
              root.intentEnabledRequested(chip.intent.name, !chip.routeEnabled, chip.modelData.mode)
          }
        }
      }
      Text {
        width: parent.width
        visible: !root.separateModes
        text: "Restart Companion to load independent intent and shortcut controls."
        wrapMode: Text.WordWrap
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 11 * root.textScale
      }
    }
  }
}
