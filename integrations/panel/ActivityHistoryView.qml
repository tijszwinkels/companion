import QtQuick
import QtQuick.Controls

Item {
  id: root
  property var historyModel: null
  property bool available: false
  property bool historyDeletionAvailable: false
  required property var intents
  required property bool online
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property real textScale: unit
  property bool animationsEnabled: true
  signal actionRequested(string action, string id, var value)
  readonly property int count: historyModel ? historyModel.count : 0
  height: count ? Math.min(400 * unit, Math.max(110 * unit, list.contentHeight)) : Math.max(64 * unit, emptyLabel.implicitHeight + 16 * unit)

  Text {
    id: emptyLabel
    width: parent.width
    anchors.verticalCenter: parent.verticalCenter
    visible: root.count === 0
    text: !root.available ? "Restart Companion to connect session history." : "Completed utterances will appear here.\nThis Companion run"
    textFormat: Text.PlainText
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 12 * root.textScale
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
      cleanedText: model.cleanedText
      cleanupStatus: model.cleanupStatus
      cleanupFallback: model.cleanupFallback
      transcriptSource: model.transcriptSource
      intents: root.intents
      online: root.online
      historyDeletionAvailable: root.historyDeletionAvailable
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      textScale: root.textScale
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
