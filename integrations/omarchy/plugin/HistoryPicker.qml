import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui

// Use the same menu surface, typography, and selection colors as Clipboard.
PanelWindow {
  id: panel

  required property bool opened
  required property bool online
  required property var rows
  required property int selectedIndex
  property var pickerScreen: null

  signal cancelled()

  visible: opened
  screen: pickerScreen
  anchors { top: true; bottom: true; left: true; right: true }
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.namespace: "companion-history"
  WlrLayershell.layer: WlrLayer.Overlay
  // Hyprland's temporary bindings navigate the list. Keeping focus in the
  // application avoids losing the key release when a new keyboard surface maps.
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

  onSelectedIndexChanged: resultList.positionViewAtIndex(selectedIndex, ListView.Contain)

  Rectangle {
    anchors.fill: parent
    color: Color.menu.scrim
  }

  MouseArea {
    anchors.fill: parent
    onClicked: panel.cancelled()
  }

  BorderSurface {
    id: card
    anchors.centerIn: parent
    width: Math.min(Style.space(875), panel.width - Style.gapsOut * 2)
    height: Math.min(Style.space(600), panel.height - Style.gapsOut * 2)
    radius: Style.cornerRadius
    color: Color.menu.background
    borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))
    padding: Style.spacing.panelPadding

    MouseArea { anchors.fill: parent; onClicked: {} }

    Column {
      anchors.fill: parent
      anchors.margins: card.padding
      spacing: Style.spacing.md

      Text {
        text: "Recent utterances"
        textFormat: Text.PlainText
        color: Color.menu.text
        font.family: Style.font.menuFamily
        font.pixelSize: Style.font.title
      }

      Text {
        text: "Hold Super + Alt + V · ↑ / ↓ select · Release to paste · Esc cancels"
        textFormat: Text.PlainText
        color: Color.menu.text
        opacity: 0.7
        font.family: Style.font.menuFamily
        font.pixelSize: Style.font.caption
      }

      ListView {
        id: resultList
        width: parent.width
        height: parent.height - y
        clip: true
        spacing: Style.space(4)
        model: panel.rows
        boundsBehavior: Flickable.StopAtBounds

        delegate: Rectangle {
          id: row
          required property var modelData
          required property int index
          width: resultList.width
          height: Style.space(76)
          radius: Style.cornerRadius
          color: index === panel.selectedIndex ? Color.menu.selectedBackground : "transparent"
          readonly property color textColor: index === panel.selectedIndex ? Color.menu.selectedText : Color.menu.text

          Column {
            anchors.fill: parent
            anchors.margins: Style.space(10)
            spacing: Style.space(5)

            Text {
              width: parent.width
              text: row.modelData.utterance
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: row.textColor
              font.family: Style.font.menuFamily
              font.pixelSize: Style.font.body
            }

            Text {
              width: parent.width
              text: Qt.formatDateTime(new Date(row.modelData.observedAt), "ddd HH:mm")
                + " · " + (row.modelData.application || "Unknown application")
                + " · " + row.modelData.outcome
                + (row.modelData.transcriptSource === "earlier-attempt" ? " · earlier words" : "")
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: row.textColor
              opacity: 0.7
              font.family: Style.font.menuFamily
              font.pixelSize: Style.font.caption
            }
          }
        }

        Text {
          anchors.centerIn: parent
          visible: panel.rows.length === 0
          text: panel.online ? "No utterances yet" : "Companion is not running"
          textFormat: Text.PlainText
          color: Color.menu.text
          font.family: Style.font.menuFamily
          font.pixelSize: Style.font.body
        }
      }
    }
  }
}
