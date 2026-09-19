import QtQuick
import QtQuick.Controls

// Pinned above the composer. Backend-owned revisions travel with every click;
// neither a label nor a displayed description is treated as an action payload.
Column {
  id: root
  property var choices: []
  property string sessionId: ""
  property string stopRunId: ""
  property bool online: true
  property bool listening: true
  property bool pending: false
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property real maximumHeight: 180 * unit
  spacing: 6 * unit
  visible: choices.length > 0 || stopRunId !== ""
  signal choiceRequested(string id, string revision, int index)
  signal stopRequested(string id, string runId)

  PanelAction {
    objectName: "stopVoiceChoice"
    visible: root.stopRunId !== ""
    enabled: root.online
    text: "[stop]"
    foreground: root.listening && root.online ? root.accent : root.muted
    selection: root.selection
    fontFamily: root.fontFamily
    unit: root.unit
    onTriggered: root.stopRequested(root.sessionId, root.stopRunId)
  }

  ScrollView {
    id: scroll
    width: parent.width
    height: Math.min(options.implicitHeight, root.maximumHeight)
    visible: root.choices.length > 0
    contentWidth: availableWidth
    clip: true

    Column {
      id: options
      width: scroll.availableWidth
      spacing: 4 * root.unit
      Repeater {
        model: root.choices
        delegate: Rectangle {
          id: option
          required property var modelData
          objectName: "agentChoice-" + modelData.index
          readonly property bool selectable: root.online && !root.pending && modelData.available
          readonly property bool voiceActive: root.online && root.listening && !root.pending && modelData.voiceAvailable
          readonly property string hint: !root.online ? "Disconnected" : modelData.voiceReason
            || (!root.listening ? "Voice listening is paused" : "Say “" + modelData.label + "” to select")
          width: options.width
          height: Math.max(label.implicitHeight, description.implicitHeight, 20 * root.unit) + 12 * root.unit
          radius: 4 * root.unit
          color: optionMouse.containsMouse && selectable ? root.selection : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.color: voiceActive ? root.accent : "transparent"
          opacity: selectable ? 1 : 0.6

          function activate() {
            if (selectable) root.choiceRequested(modelData.sessionId, modelData.revision, modelData.index)
          }

          Text {
            id: label
            objectName: "choiceVoiceLabel"
            x: 8 * root.unit
            y: 6 * root.unit
            width: modelData.description ? Math.min(implicitWidth, option.width * 0.4) : option.width - 16 * root.unit
            text: "[" + modelData.label + "]"
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: option.voiceActive ? root.accent : root.muted
            font.family: root.fontFamily
            font.pixelSize: 12 * root.unit
          }
          Text {
            id: description
            x: label.x + label.width + 8 * root.unit
            y: 6 * root.unit
            width: Math.max(0, option.width - x - 8 * root.unit)
            text: modelData.description
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: 12 * root.unit
          }
          MouseArea {
            id: optionMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: option.selectable ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: option.activate()
          }
          ToolTip.visible: optionMouse.containsMouse
          ToolTip.delay: 600
          ToolTip.text: option.hint + (modelData.description ? "\n" + modelData.description : "")
          Accessible.role: Accessible.Button
          Accessible.name: modelData.label + (modelData.description ? ": " + modelData.description : "")
          Accessible.description: option.hint
          Accessible.onPressAction: option.activate()
        }
      }
    }
  }
}
