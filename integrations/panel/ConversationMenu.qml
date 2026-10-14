import QtQuick
import QtQuick.Controls

// A small "⋯" menu in the conversation header for secondary actions that need
// no permanent control: finished-timer history and reloading older messages.
// `items` is [{id, text}]; the host shows the menu only when it has items and
// handles `triggered(id)`. Like the timer overlay, it never takes focus.
Item {
  id: root
  property var items: []
  // The button's symbol: "⋯", or a timer state when the header folds the
  // timer control in here; `summary` then extends its accessible name.
  property string glyph: "⋯"
  property color glyphColor: muted
  property string summary: ""
  // Overlay geometry relative to this control, like TimerControl's.
  property real overlayRightInset: 0
  property real overlayCeiling: -height
  property real bottomLimit: 1000 * unit
  property real maximumWidth: 220 * unit
  required property color background
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  signal triggered(string id)

  readonly property color overlayColor: Qt.tint(Qt.rgba(background.r, background.g, background.b, 1), selection)
  readonly property bool opened: menu.opened

  visible: items.length > 0
  implicitWidth: button.width
  implicitHeight: button.height
  onItemsChanged: if (items.length === 0) menu.close()

  function toggle() {
    if (menu.opened) menu.close()
    else menu.open()
  }

  Rectangle {
    id: button
    objectName: "conversationMenuButton"
    width: 28 * root.unit
    height: width
    radius: 4 * root.unit
    color: buttonMouse.containsMouse || menu.opened ? root.selection : "transparent"
    Text {
      anchors.centerIn: parent
      text: root.glyph
      color: buttonMouse.containsMouse ? root.accent : root.glyphColor
      font.family: root.fontFamily
      font.pixelSize: 16 * root.unit
    }
    MouseArea {
      id: buttonMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.toggle()
    }
    ToolTip.visible: buttonMouse.containsMouse && !menu.opened
    ToolTip.delay: 400
    ToolTip.text: "Conversation menu" + (root.summary ? " · " + root.summary : "")
    Accessible.role: Accessible.ButtonMenu
    Accessible.name: "Conversation menu" + (root.summary ? " · " + root.summary : "")
    Accessible.onPressAction: root.toggle()
  }

  Shortcut {
    sequence: "Escape"
    context: Qt.WindowShortcut
    enabled: menu.opened
    onActivated: menu.close()
  }

  Popup {
    id: menu
    objectName: "conversationMenu"
    modal: false
    focus: false
    closePolicy: Popup.CloseOnPressOutsideParent
    padding: 4 * root.unit
    x: root.width + root.overlayRightInset - width
    y: Math.max(root.overlayCeiling, Math.min(root.height + 4 * root.unit, root.bottomLimit - height))
    width: Math.min(220 * root.unit, root.maximumWidth)
    background: Rectangle {
      color: root.overlayColor
      radius: 6 * root.unit
      border.color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.45)
    }
    contentItem: Column {
      id: entries
      Repeater {
        model: root.items
        delegate: Rectangle {
          required property var modelData
          objectName: "conversationMenu-" + modelData.id
          width: entries.width
          height: 30 * root.unit
          radius: 4 * root.unit
          color: entryMouse.containsMouse ? root.selection : "transparent"
          function activate() {
            menu.close()
            root.triggered(modelData.id)
          }
          Text {
            id: entryLabel
            x: 10 * root.unit
            width: parent.width - 20 * root.unit
            anchors.verticalCenter: parent.verticalCenter
            elide: Text.ElideRight
            text: modelData.text
            textFormat: Text.PlainText
            color: entryMouse.containsMouse ? root.accent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: 12 * root.unit
          }
          MouseArea {
            id: entryMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: parent.activate()
          }
          Accessible.role: Accessible.MenuItem
          Accessible.name: modelData.text
          Accessible.onPressAction: activate()
        }
      }
    }
  }
}
