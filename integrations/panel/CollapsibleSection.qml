import QtQuick

// Content stays alive when folded: selections and scroll positions survive.
Item {
  id: root
  required property string title
  required property color foreground
  required property color muted
  required property color accent
  required property string fontFamily
  property string detail: ""
  property real unit: 1
  property bool expanded: true
  default property alias content: body.data
  implicitHeight: header.height + (expanded ? body.height + 12 * unit : 0)
  height: implicitHeight
  clip: true

  data: [
    Rectangle {
      id: header
      objectName: "sectionToggle"
      width: parent.width
      height: 32 * root.unit
      radius: 6 * root.unit
      color: hover.containsMouse ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.06) : "transparent"
      Text {
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width - info.width - 32 * root.unit
        text: root.title
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: 13 * root.unit
        font.weight: Font.DemiBold
        elide: Text.ElideRight
      }
      Text {
        id: info
        anchors.right: arrow.left
        anchors.rightMargin: 12 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        text: root.detail
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 10 * root.unit
      }
      Text {
        id: arrow
        anchors.right: parent.right
        anchors.rightMargin: 4 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        text: "⌄"
        rotation: root.expanded ? 0 : -90
        color: hover.containsMouse ? root.accent : root.muted
        font.pixelSize: 18 * root.unit
        Behavior on rotation {
          NumberAnimation {
            duration: 160
          }
        }
      }
      MouseArea {
        id: hover
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.expanded = !root.expanded
      }
      Accessible.role: Accessible.Button
      Accessible.name: (root.expanded ? "Collapse " : "Expand ") + root.title
      Accessible.onPressAction: root.expanded = !root.expanded
    },
    Column {
      id: body
      width: root.width
      y: header.height + 12 * root.unit
      spacing: 12 * root.unit
      opacity: root.expanded ? 1 : 0
      enabled: root.expanded
      visible: opacity > 0
      Behavior on opacity {
        NumberAnimation {
          duration: 120
        }
      }
    }
  ]
}
