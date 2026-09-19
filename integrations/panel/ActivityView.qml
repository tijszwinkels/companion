import QtQuick
import QtQuick.Controls

// One measured column owns all Activity content, including keyboard help.
// Small screens scroll this page instead of stacking independently anchored
// footers over the controls. The listening animation has its own bounded area.
Flickable {
  id: root
  required property bool online
  required property bool paused
  property string pauseReason: ""
  required property bool speaking
  required property int processing
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property bool animationsEnabled: true
  property var history: []
  property var intents: []
  property var activityHistoryModel: null
  property bool activityHistoryAvailable: false
  property string shortcutLabel: ""
  signal intentEnabledRequested(string name, bool enabled)
  signal historyActionRequested(string action, string id, var value)

  contentWidth: width
  contentHeight: contents.height
  clip: true
  boundsBehavior: Flickable.StopAtBounds
  ScrollBar.vertical: ScrollBar {
    policy: root.contentHeight > root.height ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff
  }

  Column {
    id: contents
    width: root.width
    spacing: 28 * root.unit

    CollapsibleSection {
      id: listeningSection
      objectName: "listeningArea"
      width: parent.width
      title: "Listening"
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit

      Rectangle {
        width: parent.width
        // Leave a little extra room for the paused-state explanation.
        height: (root.paused ? 200 : 180) * root.unit
        radius: 16 * root.unit
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.025)
        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
        clip: true

        StatusView {
          anchors.fill: parent
          anchors.margins: 12 * root.unit
          online: root.online
          paused: root.paused
          pauseReason: root.pauseReason
          speaking: root.speaking
          processing: root.processing
          history: root.history
          foreground: root.foreground
          muted: root.muted
          accent: root.accent
          fontFamily: root.fontFamily
          unit: root.unit
          animationsEnabled: root.animationsEnabled && root.visible && listeningSection.expanded
        }
      }
    }

    CollapsibleSection {
      id: historySection
      objectName: "historySection"
      width: parent.width
      title: "History"
      detail: historyView.count + " · this run"
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit
      ActivityHistoryView {
        id: historyView
        width: parent.width
        historyModel: root.activityHistoryModel
        available: root.activityHistoryAvailable
        intents: root.intents
        online: root.online
        foreground: root.foreground
        muted: root.muted
        accent: root.accent
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        animationsEnabled: root.animationsEnabled && historySection.expanded
        onActionRequested: (action, id, value) => root.historyActionRequested(action, id, value)
      }
    }

    IntentControls {
      objectName: "intentControls"
      width: parent.width
      intents: root.intents
      online: root.online
      paused: root.paused
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      onIntentEnabledRequested: (name, enabled) => root.intentEnabledRequested(name, enabled)
    }

    Column {
      objectName: "activityKeyboardHelp"
      visible: root.shortcutLabel !== ""
      width: parent.width
      spacing: 12 * root.unit

      Rectangle {
        width: parent.width
        height: root.unit
        color: Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.18)
      }
      Text {
        text: "Keyboard shortcuts"
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 11 * root.unit
        font.weight: Font.DemiBold
      }
      Text {
        width: parent.width
        text: root.shortcutLabel
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 10 * root.unit
        lineHeight: 1.5
      }
    }
  }
}
