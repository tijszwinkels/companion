import QtQuick
import QtQuick.Controls
import QtQuick.Shapes

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
  property color tooltipBackground: selection
  property color tooltipForeground: foreground
  property color tooltipBorder: muted
  property real unit: 1
  property bool online: true
  property bool running: false
  property bool unread: false
  property bool animationsEnabled: true
  readonly property bool spinning: running && online && animationsEnabled && visible
  readonly property color unreadColor: "#91dbb5"
  // Keep the entire leading emoji token: flags, skin tones and ZWJ sequences
  // must not be split into UTF-16 characters. Plain titles retain their Q number.
  readonly property string firstToken: title.trim().split(/\s+/)[0] || ""
  readonly property bool hasEmoji: {
    // Qt's JS engine does not implement Unicode property escapes. Recognize
    // common pictographs/flags and explicit emoji presentation/keycap tokens.
    const point = firstToken.codePointAt(0)
    return (point >= 0x1f000 && point <= 0x1faff)
      || (point >= 0x2600 && point <= 0x27bf)
      || firstToken.indexOf("\uFE0F") >= 0 || firstToken.indexOf("\u20E3") >= 0
  }
  readonly property string glyph: hasEmoji ? firstToken : "Q" + number
  readonly property string caption: hasEmoji ? title.trim().slice(firstToken.length).trim() : title
  readonly property bool hovered: hover.hovered
  signal selectedRequested()
  signal closeRequested()
  width: 48 * unit
  height: 62 * unit
  radius: 5 * unit
  color: unread ? Qt.rgba(unreadColor.r, unreadColor.g, unreadColor.b, 0.12)
    : selected ? selection : hovered ? Qt.rgba(foreground.r, foreground.g, foreground.b, 0.06) : "transparent"
  border.width: unread ? root.unit : 0
  border.color: Qt.rgba(unreadColor.r, unreadColor.g, unreadColor.b, 0.25)

  HoverHandler { id: hover }

  Item {
    id: badge
    anchors.top: parent.top
    anchors.topMargin: 3 * root.unit
    anchors.horizontalCenter: parent.horizontalCenter
    width: 28 * root.unit
    height: width

    Shape {
      id: ring
      objectName: "sessionRunningRing"
      anchors.fill: parent
      visible: root.running
      opacity: root.online ? 1 : 0.35
      // Rotate cached geometry rather than repainting a Canvas every frame.
      ShapePath {
        strokeColor: root.accent
        strokeWidth: 1.5 * root.unit
        capStyle: ShapePath.RoundCap
        fillColor: "transparent"
        PathAngleArc {
          centerX: badge.width / 2
          centerY: badge.height / 2
          radiusX: badge.width / 2 - 2 * root.unit
          radiusY: radiusX
          startAngle: -90
          sweepAngle: 265
        }
      }
      RotationAnimation on rotation {
        running: root.spinning
        from: 0
        to: 360
        duration: 1600
        loops: Animation.Infinite
      }
    }
    Text {
      objectName: "sessionGlyph"
      anchors.centerIn: parent
      text: root.glyph
      textFormat: Text.PlainText
      color: root.selected ? root.accent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: (root.hasEmoji ? 15 : 10) * root.unit
    }
    Rectangle {
      objectName: "sessionUnreadDot"
      visible: root.unread
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      width: 7 * root.unit
      height: width
      radius: width / 2
      color: root.unreadColor
    }
  }
  Text {
    visible: root.hasEmoji
    anchors.left: parent.left
    anchors.leftMargin: 3 * root.unit
    anchors.top: parent.top
    anchors.topMargin: 3 * root.unit
    text: root.number
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 8 * root.unit
  }
  Text {
    objectName: "sessionCaption"
    anchors.fill: parent
    anchors.margins: 3 * root.unit
    anchors.topMargin: 33 * root.unit
    text: root.caption
    textFormat: Text.PlainText
    maximumLineCount: 2
    elide: Text.ElideRight
    wrapMode: Text.Wrap
    horizontalAlignment: Text.AlignHCenter
    color: root.unread ? root.unreadColor : root.selected ? root.accent : root.muted
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
    color: root.selection
    border.width: closeMouse.containsMouse ? root.unit : 0
    border.color: root.accent
    opacity: root.hovered || activeFocus ? 1 : 0
    scale: 0.75 + 0.25 * opacity
    Behavior on opacity { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
    activeFocusOnTab: true
    Keys.onReturnPressed: if (root.online) root.closeRequested()
    Keys.onSpacePressed: if (root.online) root.closeRequested()
    Text {
      anchors.centerIn: parent
      text: "×"
      color: closeMouse.containsMouse ? root.accent : root.foreground
      font.family: root.fontFamily
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
    // Explicit colors keep the tooltip in the host theme instead of picking
    // Qt Quick Controls' unrelated default palette.
    ToolTip {
      id: closeTip
      visible: closeMouse.containsMouse
      text: "Close session · saved in Previous sessions"
      delay: 400
      padding: 8 * root.unit
      background: Rectangle {
        color: root.tooltipBackground
        border.color: root.tooltipBorder
        border.width: root.unit
        radius: 4 * root.unit
      }
      contentItem: Text {
        text: closeTip.text
        textFormat: Text.PlainText
        color: root.tooltipForeground
        font.family: root.fontFamily
        font.pixelSize: 11 * root.unit
      }
    }
    Accessible.role: Accessible.Button
    Accessible.name: "Close " + root.title
    Accessible.onPressAction: if (root.online) root.closeRequested()
  }
  Accessible.role: Accessible.PageTab
  Accessible.name: title + (running ? ", running" : "") + (unread ? ", unread answer" : "")
  Accessible.selected: selected
  Accessible.onPressAction: root.selectedRequested()
}
