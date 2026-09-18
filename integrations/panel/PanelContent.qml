import QtQuick

// Reusable panel body. The desktop adapter owns the window, shortcut, monitor
// selection, and theme; this item only renders the selected page and tab rail.
Item {
  id: root

  required property bool online
  required property bool paused
  required property bool speaking
  required property int processing
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  property bool animationsEnabled: true
  property string shortcutLabel: ""
  property var history: []
  property var sessions: []
  property string selectedSessionId: ""
  property var expandedSessions: ({})
  readonly property var selectedSession: sessions.find(entry => entry.id === selectedSessionId) || null
  readonly property bool expanded: selectedSession !== null && expandedSessions[selectedSessionId] === true
  readonly property string composerFocusId: chat.composerFocusId

  signal closeRequested()
  signal sessionSelected(string id)
  signal stopSessionRequested(string id)
  signal dismissSessionRequested(string id)
  signal sendSessionRequested(string id, string text)

  function submitted(id, text, error) { chat.submitted(id, text, error) }

  // Activity remains the first tab. Questions get their own vertically stacked
  // tabs, scrollable independently of the conversation itself.
  Rectangle {
    id: rail
    width: 64 * root.unit
    height: parent.height
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)

    Rectangle {
      anchors.top: parent.top
      anchors.topMargin: 20 * root.unit
      anchors.horizontalCenter: parent.horizontalCenter
      width: 48 * root.unit
      height: 64 * root.unit
      color: root.selectedSession === null ? root.selection : "transparent"

      Rectangle {
        width: 2 * root.unit
        height: parent.height
        color: root.selectedSession === null ? root.accent : "transparent"
      }

      Column {
        anchors.centerIn: parent
        spacing: 8 * root.unit

        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          height: 20 * root.unit
          spacing: 3 * root.unit

          Repeater {
            model: [8, 20, 14]
            Rectangle {
              required property int modelData
              anchors.verticalCenter: parent.verticalCenter
              width: 3 * root.unit
              height: modelData * root.unit
              radius: root.unit
              color: root.accent
            }
          }
        }

        Text {
          text: "Activity"
          textFormat: Text.PlainText
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: 8 * root.unit
        }
      }

      Accessible.role: Accessible.PageTab
      Accessible.name: "Activity"
      Accessible.selected: root.selectedSession === null
      Accessible.onPressAction: root.sessionSelected("")
      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: root.sessionSelected("")
      }
    }

    Flickable {
      anchors.fill: parent
      anchors.topMargin: 100 * root.unit
      anchors.bottomMargin: 8 * root.unit
      contentHeight: tabs.height
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      Column {
        id: tabs
        width: parent.width
        spacing: 8 * root.unit
        Repeater {
          model: root.sessions
          Rectangle {
            required property var modelData
            required property int index
            anchors.horizontalCenter: parent.horizontalCenter
            width: 48 * root.unit
            height: 62 * root.unit
            color: root.selectedSessionId === modelData.id ? root.selection : "transparent"
            Text {
              anchors.fill: parent
              anchors.margins: 4 * root.unit
              text: "Q" + (parent.index + 1) + "\n" + parent.modelData.title
              textFormat: Text.PlainText
              maximumLineCount: 3
              elide: Text.ElideRight
              wrapMode: Text.Wrap
              horizontalAlignment: Text.AlignHCenter
              color: root.selectedSessionId === parent.modelData.id ? root.accent : root.muted
              font.family: root.fontFamily
              font.pixelSize: 9 * root.unit
            }
            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onClicked: root.sessionSelected(parent.modelData.id)
            }
            Accessible.role: Accessible.PageTab
            Accessible.name: modelData.title
            Accessible.selected: root.selectedSessionId === modelData.id
            Accessible.onPressAction: root.sessionSelected(modelData.id)
          }
        }
      }
    }
  }

  Item {
    anchors.left: rail.right
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.margins: 20 * root.unit

    Text {
      anchors.top: parent.top
      width: parent.width - 38 * root.unit
      text: root.selectedSession ? root.selectedSession.title : "Companion"
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: 16 * root.unit
    }

    Rectangle {
      id: closeButton
      objectName: "closeButton"
      anchors.top: parent.top
      anchors.topMargin: -6 * root.unit
      anchors.right: parent.right
      width: 30 * root.unit
      height: width
      color: closeMouse.containsMouse ? root.selection : "transparent"

      Text {
        anchors.centerIn: parent
        text: "×"
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 22 * root.unit
      }

      MouseArea {
        id: closeMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.closeRequested()
      }

      Accessible.role: Accessible.Button
      Accessible.name: "Close Companion panel"
      Accessible.onPressAction: root.closeRequested()
    }

    StatusView {
      visible: root.selectedSession === null
      anchors.fill: parent
      anchors.topMargin: 48 * root.unit
      anchors.bottomMargin: 36 * root.unit
      online: root.online
      paused: root.paused
      speaking: root.speaking
      processing: root.processing
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit
      animationsEnabled: root.animationsEnabled && visible
      history: root.history
    }

    SessionView {
      id: chat
      objectName: "sessionView"
      visible: root.selectedSession !== null
      anchors.fill: parent
      anchors.topMargin: 44 * root.unit
      session: root.selectedSession
      online: root.online
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      onStopRequested: id => root.stopSessionRequested(id)
      onDismissRequested: id => root.dismissSessionRequested(id)
      onSendRequested: (id, text) => root.sendSessionRequested(id, text)
      onOverflowed: {
        // Latch expansion for this session. Reflowing into a wider window must
        // not immediately shrink it and oscillate between the two sizes.
        if (root.selectedSession && !root.expanded) {
          const expanded = Object.assign({}, root.expandedSessions)
          expanded[root.selectedSessionId] = true
          root.expandedSessions = expanded
        }
      }
    }

    Text {
      anchors.bottom: parent.bottom
      width: parent.width
      text: root.shortcutLabel
      visible: root.selectedSession === null
      textFormat: Text.PlainText
      horizontalAlignment: Text.AlignHCenter
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }
  }
}
