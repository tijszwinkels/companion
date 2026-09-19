import QtQuick
import QtQuick.Controls

Item {
  id: root
  property var historyModel: null
  property bool available: false
  required property var intents
  required property bool online
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property bool animationsEnabled: true
  signal actionRequested(string action, string id, var value)
  readonly property int count: historyModel ? historyModel.count : 0
  height: count ? Math.min(400 * unit, Math.max(110 * unit, list.contentHeight)) : 64 * unit

  Text {
    anchors.fill: parent
    visible: root.count === 0
    text: !root.available ? "Restart Companion to connect session history." : "Completed utterances will appear here.\nThis Companion run · all entries retained"
    textFormat: Text.PlainText
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 12 * root.unit
    lineHeight: 1.5
    wrapMode: Text.WordWrap
    verticalAlignment: Text.AlignVCenter
  }

  ListView {
    id: list
    objectName: "activityHistoryList"
    anchors.fill: parent
    clip: true
    model: root.historyModel
    spacing: 10 * root.unit
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar {
      policy: ScrollBar.AsNeeded
    }
    delegate: HistoryCard {
      required property var model
      width: list.width - 8 * root.unit
      entryId: model.entryId
      utterance: model.utterance
      intent: model.intent
      outcome: model.outcome
      observedAt: model.observedAt
      feedback: model.feedback
      actualIntent: model.actualIntent
      intents: root.intents
      online: root.online
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      onActionRequested: (action, id, value) => root.actionRequested(action, id, value)
    }
    add: Transition {
      enabled: root.animationsEnabled
      ParallelAnimation {
        NumberAnimation {
          property: "opacity"
          from: 0
          to: 1
          duration: 420
        }
        NumberAnimation {
          property: "x"
          from: 12 * root.unit
          to: 0
          duration: 420
          easing.type: Easing.OutCubic
        }
      }
    }
  }
}
