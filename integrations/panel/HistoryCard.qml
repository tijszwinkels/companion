import QtQuick

Rectangle {
  id: root
  required property string entryId
  required property string utterance
  required property string intent
  required property string outcome
  required property real observedAt
  required property string feedback
  required property string actualIntent
  required property var intents
  required property bool online
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property real textScale: unit
  property bool choosingIntent: false
  readonly property bool actionsVisible: hover.hovered || choosingIntent
  readonly property color tone: feedback === "correct" ? "#65d6a1" : feedback === "incorrect" ? "#f17f90" : accent
  signal actionRequested(string action, string id, var value)

  objectName: "history-" + entryId
  height: body.height + 24 * unit
  radius: 12 * unit
  color: Qt.rgba(tone.r, tone.g, tone.b, feedback ? 0.10 : 0.035)
  border.color: Qt.rgba(tone.r, tone.g, tone.b, hover.hovered ? 0.6 : 0.23)
  Behavior on color {
    ColorAnimation {
      duration: 220
    }
  }
  Behavior on border.color {
    ColorAnimation {
      duration: 180
    }
  }

  HoverHandler {
    id: hover
  }
  Rectangle {
    x: 0
    y: 18 * root.unit
    width: 2 * root.unit
    height: parent.height - 36 * root.unit
    radius: width / 2
    color: root.tone
    opacity: 0.7
  }

  TextEdit {
    id: copyBuffer
    visible: false
    textFormat: TextEdit.PlainText
  }
  function copy() {
    copyBuffer.text = root.utterance;
    copyBuffer.selectAll();
    copyBuffer.copy();
    copyBuffer.text = "";
    copied.restart();
  }
  Timer {
    id: copied
    interval: 1200
  }

  Column {
    id: body
    x: 14 * root.unit
    y: 12 * root.unit
    width: parent.width - 28 * root.unit
    spacing: 10 * root.unit

    Row {
      spacing: 7 * root.unit
      Rectangle {
        width: 4 * root.unit
        height: width
        radius: width / 2
        anchors.verticalCenter: parent.verticalCenter
        color: root.tone
      }
      Text {
        text: Qt.formatTime(new Date(root.observedAt), "HH:mm:ss") + (root.feedback ? "  ·  " + root.feedback : "")
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 9 * root.textScale
      }
    }

    Text {
      objectName: "historyUtterance"
      width: parent.width
      text: root.utterance
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: 14 * root.textScale
      lineHeight: 1.3
    }

    Text {
      objectName: "historyDetectedIntent"
      width: parent.width
      horizontalAlignment: Text.AlignRight
      text: (root.intent || "NO INTENT") + (["error", "skipped", "cancelled", "interrupted", "preview"].includes(root.outcome) ? " · " + root.outcome : "") + (root.actualIntent ? "\nCorrected: " + root.actualIntent : "")
      textFormat: Text.PlainText
      wrapMode: Text.WrapAnywhere
      color: root.tone
      font.family: root.fontFamily
      font.pixelSize: 9 * root.textScale
      opacity: 0.8
    }

    Item {
      width: parent.width
      height: root.actionsVisible ? actions.height : 0
      visible: height > 0
      clip: true
      opacity: root.actionsVisible ? 1 : 0
      Behavior on opacity {
        NumberAnimation {
          duration: 140
        }
      }
      Flow {
        id: actions
        width: parent.width
        spacing: 6 * root.unit
        Repeater {
          model: [
            {
              action: "copy",
              title: copied.running ? "Copied" : "Copy"
            },
            {
              action: "paste",
              title: "Insert"
            },
            {
              action: "start-history-agent",
              title: "New coding session"
            },
            {
              action: "correct",
              title: "Label correct"
            },
            {
              action: "incorrect",
              title: "Label incorrect"
            }
          ]
          PanelAction {
            required property var modelData
            objectName: "history-action-" + modelData.action
            text: modelData.title
            foreground: root.foreground
            selection: Qt.rgba(root.tone.r, root.tone.g, root.tone.b, 0.12)
            fontFamily: root.fontFamily
            unit: root.unit
            textScale: root.textScale
            enabled: root.actionsVisible && (modelData.action === "copy" || root.online) && (!["correct", "incorrect"].includes(modelData.action) || root.intent !== "")
            onTriggered: {
              const action = modelData.action;
              if (action === "copy")
                root.copy();
              else if (action === "incorrect") {
                root.choosingIntent = !root.choosingIntent;
                if (root.feedback !== "incorrect")
                  root.actionRequested("label-history", root.entryId, {
                    correct: false
                  });
              } else if (action === "correct") {
                root.choosingIntent = false;
                root.actionRequested("label-history", root.entryId, {
                  correct: true
                });
              } else
                root.actionRequested(action, root.entryId, {});
            }
          }
        }
      }
    }

    Column {
      width: parent.width
      spacing: 8 * root.unit
      visible: root.choosingIntent
      opacity: root.choosingIntent ? 1 : 0
      Behavior on opacity {
        NumberAnimation {
          duration: 180
        }
      }
      Text {
        text: "What should it have been?"
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 11 * root.textScale
      }
      Flow {
        width: parent.width
        spacing: 6 * root.unit
        Repeater {
          model: root.intents.filter(intent => intent.name !== root.intent)
          Rectangle {
            required property var modelData
            objectName: "history-correction-" + modelData.name
            width: Math.min(parent.width, option.implicitWidth + 20 * root.unit)
            height: option.height + 14 * root.unit
            radius: 8 * root.unit
            color: optionMouse.containsMouse ? root.selection : Qt.rgba(root.tone.r, root.tone.g, root.tone.b, 0.07)
            border.color: Qt.rgba(root.tone.r, root.tone.g, root.tone.b, 0.4)
            Text {
              id: option
              anchors.centerIn: parent
              width: Math.min(implicitWidth, parent.width - 20 * root.unit)
              text: modelData.label
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: 11 * root.textScale
            }
            function choose() {
              if (!root.online)
                return;
              root.actionRequested("label-history", root.entryId, {
                correct: false,
                actualIntent: modelData.name
              });
              root.choosingIntent = false;
            }
            MouseArea {
              id: optionMouse
              anchors.fill: parent
              hoverEnabled: true
              enabled: root.online
              cursorShape: Qt.PointingHandCursor
              onClicked: parent.choose()
            }
            Accessible.role: Accessible.Button
            Accessible.name: "Correct intent to " + modelData.label
            Accessible.onPressAction: choose()
          }
        }
      }
      PanelAction {
        text: "Close choices"
        foreground: root.muted
        selection: "transparent"
        fontFamily: root.fontFamily
        unit: root.unit
        textScale: root.textScale
        onTriggered: root.choosingIntent = false
      }
    }
  }
}
