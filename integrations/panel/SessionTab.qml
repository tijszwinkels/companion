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
  // Tabs have their own scale; reader zoom never changes these controls.
  readonly property real tabUnit: 1.25 * unit
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
  property bool dragEnabled: false
  signal dragStarted()
  signal dragMoved(real sceneX, real sceneY)
  signal dragFinished()
  signal dragCancelled()
  width: 48 * tabUnit
  height: 62 * tabUnit
  radius: 5 * tabUnit
  color: unread ? Qt.rgba(unreadColor.r, unreadColor.g, unreadColor.b, 0.12)
    : selected ? selection : hovered ? Qt.rgba(foreground.r, foreground.g, foreground.b, 0.06) : "transparent"
  border.width: unread ? root.tabUnit : 0
  border.color: Qt.rgba(unreadColor.r, unreadColor.g, unreadColor.b, 0.25)

  HoverHandler { id: hover }

  // Persistent selection marker. Hover only tints the background, running
  // spins the ring and unread adds the green tint, border and dot, so the
  // right-edge line is the one cue that means "this conversation is shown".
  Rectangle {
    objectName: "sessionSelectionMarker"
    visible: root.selected
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.topMargin: 6 * root.tabUnit
    anchors.bottomMargin: 6 * root.tabUnit
    width: 3 * root.tabUnit
    radius: width / 2
    color: root.accent
  }

  // Show the complete title without changing the compact tab layout. Suppress
  // this tip over the close button so the two explanations never overlap.
  ToolTip {
    id: titleTip
    objectName: "sessionTitleTooltip"
    visible: root.hovered && !closeMouse.containsMouse
    delay: 400
    text: root.title
    padding: 8 * root.tabUnit
    width: Math.min(280 * root.tabUnit, titleText.implicitWidth + 2 * padding)
    background: Rectangle {
      color: root.tooltipBackground
      border.color: root.tooltipBorder
      border.width: root.tabUnit
      radius: 4 * root.tabUnit
    }
    contentItem: Text {
      id: titleText
      text: titleTip.text
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.tooltipForeground
      font.family: root.fontFamily
      font.pixelSize: 11 * root.tabUnit
    }
  }

  Item {
    id: badge
    anchors.top: parent.top
    anchors.topMargin: 3 * root.tabUnit
    anchors.horizontalCenter: parent.horizontalCenter
    width: 28 * root.tabUnit
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
        strokeWidth: 1.5 * root.tabUnit
        capStyle: ShapePath.RoundCap
        fillColor: "transparent"
        PathAngleArc {
          centerX: badge.width / 2
          centerY: badge.height / 2
          radiusX: badge.width / 2 - 2 * root.tabUnit
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
      font.pixelSize: (root.hasEmoji ? 15 : 10) * root.tabUnit
    }
    Rectangle {
      objectName: "sessionUnreadDot"
      visible: root.unread
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      width: 7 * root.tabUnit
      height: width
      radius: width / 2
      color: root.unreadColor
    }
  }
  Text {
    visible: root.hasEmoji
    anchors.left: parent.left
    anchors.leftMargin: 3 * root.tabUnit
    anchors.top: parent.top
    anchors.topMargin: 3 * root.tabUnit
    text: root.number
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 8 * root.tabUnit
  }
  Text {
    objectName: "sessionCaption"
    anchors.fill: parent
    anchors.margins: 3 * root.tabUnit
    anchors.topMargin: 33 * root.tabUnit
    text: root.caption
    textFormat: Text.PlainText
    maximumLineCount: 2
    elide: Text.ElideRight
    wrapMode: Text.Wrap
    horizontalAlignment: Text.AlignHCenter
    color: root.unread ? root.unreadColor : root.selected ? root.accent : root.muted
    font.family: root.fontFamily
    font.pixelSize: 9 * root.tabUnit
  }
  MouseArea {
    id: tabMouse
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor
    property real pressY: 0
    property bool moving: false
    property bool moved: false
    preventStealing: root.dragEnabled
    onPressed: mouse => {
      pressY = mapToItem(null, mouse.x, mouse.y).y
      moving = false
      moved = false
    }
    onPositionChanged: mouse => {
      if (!pressed || !root.dragEnabled || !(pressedButtons & Qt.LeftButton)) return
      const sceneY = mapToItem(null, mouse.x, mouse.y).y
      if (!moving && Math.abs(sceneY - pressY) > 8 * root.unit) {
        moving = true
        root.dragStarted()
      }
      if (moving) {
        moved = true
        root.dragMoved(mapToItem(null, mouse.x, mouse.y).x, sceneY)
      }
    }
    onReleased: {
      if (moving) root.dragFinished()
      moving = false
    }
    onCanceled: {
      moving = false
      root.dragCancelled()
    }
    onClicked: event => {
      if (moved) return
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
    width: 22 * root.tabUnit
    height: width
    radius: width / 2
    color: root.selection
    border.width: closeMouse.containsMouse ? root.tabUnit : 0
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
      font.pixelSize: 16 * root.tabUnit
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
      padding: 8 * root.tabUnit
      background: Rectangle {
        color: root.tooltipBackground
        border.color: root.tooltipBorder
        border.width: root.tabUnit
        radius: 4 * root.tabUnit
      }
      contentItem: Text {
        text: closeTip.text
        textFormat: Text.PlainText
        color: root.tooltipForeground
        font.family: root.fontFamily
        font.pixelSize: 11 * root.tabUnit
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
