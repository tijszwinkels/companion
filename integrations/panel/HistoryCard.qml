import QtQuick
import QtQuick.Controls

Rectangle {
  id: root
  required property string entryId
  required property string utterance
  required property string intent
  required property string outcome
  required property real observedAt
  required property string feedback
  required property string actualIntent
  // Transcription cleanup. `utterance` stays the raw transcript; a text route
  // that received cleaned text shows it below, and a fallback shows why the
  // raw transcript was used. Empty when cleanup was off or unknown.
  property string cleanedText: ""
  property string cleanupStatus: ""
  property string cleanupFallback: ""
  // "earlier-attempt": the text is from an earlier part of a continued
  // utterance, kept with the whole recording; the last words may be missing.
  property string transcriptSource: ""
  required property var intents
  required property bool online
  property bool historyDeletionAvailable: false
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property real textScale: unit
  property bool choosingIntent: false
  readonly property bool actionsVisible: hover.hovered || choosingIntent || deleteButton.activeFocus
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
  function copy(text) {
    copyBuffer.text = text;
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

    Item {
      width: parent.width
      height: Math.max(metadata.implicitHeight, 24 * root.unit)
      Rectangle {
        width: 4 * root.unit
        height: width
        radius: width / 2
        anchors.verticalCenter: parent.verticalCenter
        color: root.tone
      }
      Text {
        id: metadata
        x: 11 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width - x - 30 * root.unit
        text: Qt.formatTime(new Date(root.observedAt), "HH:mm:ss") + (root.feedback ? "  ·  " + root.feedback : "")
        elide: Text.ElideRight
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 9 * root.textScale
      }
      ToolButton {
        id: deleteButton
        objectName: "history-action-delete-history"
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        width: 24 * root.unit
        height: width
        visible: root.historyDeletionAvailable
        enabled: root.online
        opacity: root.actionsVisible ? (enabled ? 1 : 0.4) : 0
        hoverEnabled: true
        Accessible.name: "Delete utterance and recordings"
        ToolTip.visible: hovered
        ToolTip.text: "Delete utterance, screenshot and audio"
        ToolTip.delay: 500
        contentItem: Text {
          text: "×"
          color: deleteButton.hovered ? "#f17f90" : root.muted
          font.family: root.fontFamily
          font.pixelSize: 18 * root.textScale
          horizontalAlignment: Text.AlignHCenter
          verticalAlignment: Text.AlignVCenter
        }
        background: Rectangle {
          radius: 4 * root.unit
          color: deleteButton.hovered || deleteButton.activeFocus ? root.selection : "transparent"
        }
        Behavior on opacity {
          NumberAnimation { duration: 140 }
        }
        onClicked: root.actionRequested("delete-history", root.entryId, {})
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
      objectName: "historyTranscriptSource"
      width: parent.width
      visible: root.transcriptSource === "earlier-attempt"
      text: "Text from an earlier part of this utterance; the full recording was not transcribed"
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 10 * root.textScale
      lineHeight: 1.3
    }

    Text {
      objectName: "historyCleanup"
      width: parent.width
      visible: root.cleanupStatus === "cleaned" || root.cleanupStatus === "fallback"
      text: root.cleanupStatus === "cleaned" ? "Cleaned: " + root.cleanedText : "Cleanup fell back to the raw transcript (" + root.cleanupFallback + ")"
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.cleanupStatus === "cleaned" ? "#8fcf9f" : root.muted
      font.family: root.fontFamily
      font.pixelSize: (root.cleanupStatus === "cleaned" ? 13 : 10) * root.textScale
      lineHeight: 1.3
    }

    Text {
      objectName: "historyDetectedIntent"
      width: parent.width
      horizontalAlignment: Text.AlignRight
      text: (root.intent || "NO INTENT") + (["error", "skipped", "cancelled", "interrupted", "preview", "superseded"].includes(root.outcome) ? " · " + root.outcome : "") + (root.actualIntent ? "\nCorrected: " + root.actualIntent : "")
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
              action: "copy-cleaned",
              title: "Copy cleaned"
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
            visible: modelData.action !== "copy-cleaned" || root.cleanupStatus === "cleaned"
            text: modelData.title
            foreground: root.foreground
            selection: Qt.rgba(root.tone.r, root.tone.g, root.tone.b, 0.12)
            fontFamily: root.fontFamily
            unit: root.unit
            textScale: root.textScale
            enabled: root.actionsVisible && (modelData.action === "copy" || modelData.action === "copy-cleaned" || root.online) && (!["correct", "incorrect"].includes(modelData.action) || root.intent !== "")
            onTriggered: {
              const action = modelData.action;
              if (action === "copy")
                root.copy(root.utterance);
              else if (action === "copy-cleaned")
                root.copy(root.cleanedText);
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
