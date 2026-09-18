import QtQuick
import QtQuick.Controls

// HoverHandler observes the whole tab, including its close button. Crossing
// into the button cannot hide it or restart the entrance animation.
Rectangle {
  id: root
  required property string title
  required property int number
  required property bool selected
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property bool online: true
  readonly property bool hovered: hover.hovered
  signal selectedRequested()
  signal closeRequested()
  width: 48 * unit
  height: 62 * unit
  radius: 5 * unit
  color: selected ? selection : hovered ? Qt.rgba(foreground.r, foreground.g, foreground.b, 0.06) : "transparent"

  HoverHandler { id: hover }
  Text {
    anchors.fill: parent
    anchors.margins: 4 * root.unit
    anchors.topMargin: 10 * root.unit
    text: "Q" + root.number + "\n" + root.title
    textFormat: Text.PlainText
    maximumLineCount: 3
    elide: Text.ElideRight
    wrapMode: Text.Wrap
    horizontalAlignment: Text.AlignHCenter
    color: root.selected ? root.accent : root.muted
    font.family: root.fontFamily
    font.pixelSize: 9 * root.unit
  }
  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor
    onClicked: event => {
      if (event.button === Qt.RightButton) {
        if (root.online) root.closeRequested()
      } else {
        root.selectedRequested()
      }
    }
  }
  Rectangle {
    id: close
    objectName: "closeSessionTab"
    anchors.right: parent.right
    anchors.top: parent.top
    width: 22 * root.unit
    height: width
    radius: width / 2
    color: closeMouse.containsMouse ? root.accent : root.selection
    opacity: root.hovered || activeFocus ? 1 : 0
    scale: 0.75 + 0.25 * opacity
    Behavior on opacity { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
    activeFocusOnTab: true
    Keys.onReturnPressed: if (root.online) root.closeRequested()
    Keys.onSpacePressed: if (root.online) root.closeRequested()
    Text {
      anchors.centerIn: parent
      text: "×"
      color: root.foreground
      font.pixelSize: 16 * root.unit
    }
    MouseArea {
      id: closeMouse
      anchors.fill: parent
      hoverEnabled: true
      enabled: root.online && close.opacity > 0.5
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      cursorShape: Qt.PointingHandCursor
      onClicked: root.closeRequested()
    }
    ToolTip.visible: closeMouse.containsMouse
    ToolTip.text: "Close session · saved in Previous sessions"
    Accessible.role: Accessible.Button
    Accessible.name: "Close " + root.title
    Accessible.onPressAction: if (root.online) root.closeRequested()
  }
  Accessible.role: Accessible.PageTab
  Accessible.name: title
  Accessible.selected: selected
  Accessible.onPressAction: root.selectedRequested()
}
