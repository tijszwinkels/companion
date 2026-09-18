pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls

Item {
  id: root
  required property var sessions
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property bool online: true
  signal reopenRequested(string id)

  Text {
    id: description
    width: parent.width
    text: root.online ? "Pick up where you left off." : "Reconnect to reopen a conversation."
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 12 * root.unit
    wrapMode: Text.Wrap
  }
  Text {
    anchors.centerIn: parent
    width: parent.width - 32 * root.unit
    visible: root.sessions.length === 0
    text: "Your conversations stay here\nwhen you close their tabs."
    horizontalAlignment: Text.AlignHCenter
    lineHeight: 1.4
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 14 * root.unit
  }
  ListView {
    id: list
    objectName: "previousSessionsList"
    anchors.fill: parent
    anchors.topMargin: description.height + 20 * root.unit
    spacing: 8 * root.unit
    clip: true
    model: root.sessions
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar {}
    delegate: Rectangle {
      id: row
      required property var modelData
      objectName: "previous-" + modelData.id
      width: list.width - 8 * root.unit
      height: labels.height + 28 * root.unit
      radius: 8 * root.unit
      color: rowMouse.containsMouse ? root.selection : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
      border.color: rowMouse.containsMouse ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.35) : "transparent"
      Column {
        id: labels
        x: 14 * root.unit
        y: 14 * root.unit
        width: parent.width - 56 * root.unit
        spacing: 7 * root.unit
        Text {
          width: parent.width
          text: row.modelData.title
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          maximumLineCount: 2
          elide: Text.ElideRight
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: 13 * root.unit
        }
        Text {
          width: parent.width
          text: Qt.formatDateTime(new Date(row.modelData.updatedAt), "ddd d MMM · hh:mm") + "  ·  "
            + (row.modelData.status === "cancelled" ? "Stopped" : row.modelData.status === "error" ? "Failed" : "Completed")
          textFormat: Text.PlainText
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: 10 * root.unit
          wrapMode: Text.Wrap
        }
      }
      Text {
        anchors.right: parent.right
        anchors.rightMargin: 16 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        text: "↗"
        color: root.accent
        font.pixelSize: 20 * root.unit
      }
      MouseArea {
        id: rowMouse
        anchors.fill: parent
        hoverEnabled: true
        enabled: root.online
        cursorShape: Qt.PointingHandCursor
        onClicked: root.reopenRequested(row.modelData.id)
      }
      Accessible.role: Accessible.Button
      Accessible.name: "Reopen " + modelData.title
      Accessible.onPressAction: if (root.online) root.reopenRequested(modelData.id)
    }
  }
}
