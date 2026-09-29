import QtQuick
import QtQuick.Controls

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
  // One card per activity, in the router's order, with only the modes that
  // activity supports. A route list is kept for callers that iterate modes.
  readonly property var activities: {
    const entries = [];
    for (const intent of intents) {
      const modes = [];
      if (intent.supportsInference === true || (!root.separateModes && intent.inferenceAvailable))
        modes.push("inference");
      if (intent.prefixes.length)
        modes.push("shortcut");
      if (modes.length)
        entries.push({intent: intent, modes: modes});
    }
    return entries;
  }
  readonly property var routes: {
    const entries = [];
    for (const activity of activities) {
      for (const mode of activity.modes)
        entries.push({intent: activity.intent, mode: mode});
    }
    return entries;
  }
  // Add columns as the panel widens instead of stretching two columns. The
  // minimum follows the reader zoom so enlarged text still wraps comfortably.
  readonly property real cardGap: 8 * unit
  readonly property real minimumCardWidth: 230 * textScale
  readonly property int columns: Math.max(1, Math.floor((width + cardGap) / (minimumCardWidth + cardGap)))
  readonly property real cardWidth: Math.max(0, (width - (columns - 1) * cardGap) / columns)

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
      detail: "Click each mode separately"
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit
      textScale: root.textScale

      // Color names the mode; each control's own On/Off text gives its state.
      Flow {
        objectName: "intentLegend"
        width: parent.width
        spacing: 4 * root.unit
        Text {
          rightPadding: 12 * root.unit
          text: "● Blue · intent recognition"
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: 11 * root.textScale
        }
        Text {
          text: "● Amber · voice shortcut"
          color: root.shortcutColor
          font.family: root.fontFamily
          font.pixelSize: 11 * root.textScale
        }
      }

      Flow {
        objectName: "activityCards"
        width: parent.width
        spacing: root.cardGap
        Repeater {
          model: root.activities
          // The card and its title are not clickable: only a mode control
          // changes that one mode.
          Rectangle {
            id: card
            required property var modelData
            readonly property var intent: modelData.intent
            objectName: "activity-" + intent.name
            width: root.cardWidth
            height: cardContents.height + 22 * root.unit
            radius: 10 * root.unit
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.03)
            border.color: Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.22)

            Column {
              id: cardContents
              x: 11 * root.unit
              y: 11 * root.unit
              width: Math.max(0, parent.width - 22 * root.unit)
              spacing: 8 * root.unit
              Text {
                objectName: "activityTitle"
                width: parent.width
                text: card.intent.label
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: 13 * root.textScale
              }
              Column {
                width: parent.width
                spacing: 6 * root.unit
                Repeater {
                  model: card.modelData.modes
                  ModeControl {
                    required property string modelData
                    width: parent.width
                    intent: card.intent
                    mode: modelData
                  }
                }
              }
            }
            Accessible.role: Accessible.Grouping
            Accessible.name: card.intent.label
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

      // Cleanup applies to every text route, so it stays apart from the
      // activity cards. Like them, its state follows the backend snapshot only.
      Text {
        objectName: "transcriptionHeading"
        visible: cleanupChip.visible
        topPadding: 4 * root.unit
        text: "Transcription"
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 11 * root.textScale
      }
      Rectangle {
        id: cleanupChip
        readonly property bool available: root.transcriptionCleanup !== null && root.transcriptionCleanup !== undefined
        readonly property bool cleanupEnabled: available && root.transcriptionCleanup.enabled === true
        readonly property bool active: root.online && cleanupEnabled
        readonly property color cleanupColor: "#8fcf9f"
        readonly property string stateText: cleanupEnabled ? "On · text routes get cleaned-up text" : "Off · raw transcript"
        objectName: "transcriptionCleanupSwitch"
        visible: available
        width: Math.min(parent.width, Math.max(root.cardWidth, 480 * root.textScale))
        height: visible ? cleanupLabels.height + 22 * root.unit : 0
        radius: 10 * root.unit
        color: active ? Qt.rgba(cleanupColor.r, cleanupColor.g, cleanupColor.b, 0.1) : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.08)
        border.color: cleanupMouse.containsMouse ? cleanupColor : active ? Qt.rgba(cleanupColor.r, cleanupColor.g, cleanupColor.b, 0.55) : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.2)

        Rectangle {
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.margins: 11 * root.unit
          width: 6 * root.unit
          height: width
          radius: width / 2
          color: cleanupChip.active ? cleanupChip.cleanupColor : root.muted
          opacity: cleanupChip.active ? 1 : 0.4
        }

        Column {
          id: cleanupLabels
          x: 11 * root.unit
          anchors.verticalCenter: parent.verticalCenter
          width: Math.max(0, parent.width - 34 * root.unit)
          spacing: 5 * root.unit
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
    }
  }

  // One clickable mode inside an activity card: blue intent recognition or
  // amber voice shortcut. A click requests only this mode's opposite state
  // and waits for the backend snapshot; nothing changes optimistically.
  component ModeControl: Rectangle {
    id: chip
    required property var intent
    required property string mode
    readonly property bool inference: mode === "inference"
    readonly property bool routeEnabled: inference ? intent.inferenceEnabled === true : intent.shortcutEnabled === true
    readonly property bool available: inference ? intent.inferenceAvailable : intent.prefixAvailable
    readonly property bool active: root.online && !root.paused && routeEnabled && available
    // Switched on but waiting for a conversation: keep the mode's color, softer
    // than active, so it never reads as Off.
    readonly property bool waiting: root.online && !root.paused && routeEnabled && !available
    readonly property bool clickable: root.online && root.separateModes && intent.toggleable
    readonly property color routeColor: inference ? root.accent : root.shortcutColor
    readonly property string modeLabel: inference ? "Intent recognition" : "Voice shortcut"
    readonly property string stateText: !routeEnabled ? "Off" : !intent.toggleable ? "Always on" : "On"
    readonly property string contextText: routeEnabled && !available ? "Needs conversation context" : ""
    objectName: (inference ? "intent-" : "shortcut-") + intent.name
    height: labels.height + 16 * root.unit
    radius: 7 * root.unit
    color: active ? Qt.rgba(routeColor.r, routeColor.g, routeColor.b, 0.1)
      : waiting ? Qt.rgba(routeColor.r, routeColor.g, routeColor.b, 0.045)
      : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.07)
    border.color: mouse.containsMouse && clickable ? routeColor
      : active ? Qt.rgba(routeColor.r, routeColor.g, routeColor.b, 0.55)
      : waiting ? Qt.rgba(routeColor.r, routeColor.g, routeColor.b, 0.32)
      : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.22)

    Column {
      id: labels
      objectName: "intentCardText"
      x: 10 * root.unit
      y: 8 * root.unit
      width: Math.max(0, parent.width - 20 * root.unit)
      spacing: 5 * root.unit
      Item {
        width: parent.width
        height: Math.max(modeText.height, stateLabel.height)
        Text {
          id: modeText
          width: Math.max(0, parent.width - stateLabel.width - 8 * root.unit)
          text: chip.modeLabel
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          color: chip.active || chip.waiting ? chip.routeColor : root.muted
          font.family: root.fontFamily
          font.pixelSize: 11 * root.textScale
        }
        Text {
          id: stateLabel
          objectName: "intentModeState"
          anchors.right: parent.right
          text: (chip.routeEnabled ? "● " : "○ ") + chip.stateText
          textFormat: Text.PlainText
          color: chip.active || chip.waiting ? chip.routeColor : root.muted
          font.family: root.fontFamily
          font.pixelSize: 11 * root.textScale
        }
      }
      Flow {
        objectName: "intentCardShortcuts"
        width: parent.width
        spacing: 5 * root.unit
        visible: !chip.inference
        Repeater {
          model: chip.inference ? [] : chip.intent.prefixes
          Rectangle {
            required property string modelData
            width: Math.min(parent.width, prefixLabel.implicitWidth + 12 * root.unit)
            height: prefixLabel.height + 6 * root.unit
            radius: 4 * root.unit
            color: Qt.rgba(chip.routeColor.r, chip.routeColor.g, chip.routeColor.b, chip.active ? 0.14 : 0.05)
            Text {
              id: prefixLabel
              anchors.centerIn: parent
              width: Math.min(implicitWidth, parent.width - 12 * root.unit)
              text: modelData + (chip.intent.acceptsEmptyPrefix ? "" : " …")
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: chip.active || chip.waiting ? chip.routeColor : root.muted
              font.family: root.fontFamily
              font.pixelSize: 10 * root.textScale
            }
          }
        }
      }
      Text {
        objectName: "intentModeContext"
        width: parent.width
        visible: text !== ""
        text: chip.contextText
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.78)
        font.family: root.fontFamily
        font.pixelSize: 10 * root.textScale
      }
    }
    MouseArea {
      id: mouse
      anchors.fill: parent
      enabled: root.online && root.separateModes
      hoverEnabled: true
      cursorShape: chip.intent.toggleable ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: if (chip.intent.toggleable)
        root.intentEnabledRequested(chip.intent.name, !chip.routeEnabled, chip.mode)
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
    Accessible.name: chip.intent.label + ": " + chip.modeLabel + " · " + chip.stateText + (chip.contextText ? " · " + chip.contextText : "")
    Accessible.checkable: chip.intent.toggleable
    Accessible.checked: chip.routeEnabled
    Accessible.onToggleAction: if (root.online && root.separateModes && chip.intent.toggleable)
      root.intentEnabledRequested(chip.intent.name, !chip.routeEnabled, chip.mode)
  }
}
