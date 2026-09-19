import QtQuick
import QtQuick.Window
import QtQml.Models

// Reusable panel body. The desktop adapter owns the window, shortcut, monitor
// selection, and theme; this item only renders the selected page and tab rail.
Item {
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
  property color tooltipBackground: selection
  property color tooltipForeground: foreground
  property color tooltipBorder: muted
  property real unit: 1
  property bool animationsEnabled: true
  property string shortcutLabel: ""
  property string focusShortcut: ""
  property var history: []
  property var intents: []
  property var sessions: []
  property var previousSessions: []
  property bool showingPrevious: false
  property string controlError: ""
  property string selectedSessionId: ""
  readonly property var selectedSession: !showingPrevious && sessions.find(entry => entry.id === selectedSessionId) || null
  readonly property string composerFocusId: chat.composerFocusId
  readonly property bool keyboardFocused: root.Window.window !== null && root.Window.window.active

  // Activity needs window focus for tab navigation, but has no text cursor or
  // dictation destination. Clear the hidden composer when leaving a conversation.
  onSelectedSessionChanged: if (selectedSession === null) {
    chat.releaseComposerFocus()
    if (root.keyboardFocused) root.forceActiveFocus(Qt.TabFocusReason)
  }

  signal closeRequested()
  signal intentEnabledRequested(string name, bool enabled)
  signal sessionSelected(string id)
  signal previousRequested()
  signal reopenSessionRequested(string id)
  signal screenshotRequested(url source, string title)
  signal stopSessionRequested(string id)
  signal dismissSessionRequested(string id)
  signal sendSessionRequested(string id, string text)

  function submitted(id, text, error) { chat.submitted(id, text, error) }
  function focusComposer() { chat.focusComposer() }
  function releaseComposerFocus() { chat.releaseComposerFocus() }

  function selectConversation(id) {
    root.sessionSelected(id)
    Qt.callLater(function() {
      if (root.selectedSession && root.selectedSessionId === id && root.keyboardFocused) root.focusComposer()
    })
  }

  // Cycle Activity -> Q1 -> Q2 -> ... -> Activity. Previous sessions joins
  // the sequence at Activity; a missing/closed conversation does the same.
  function nextTab() {
    const index = root.showingPrevious ? -1 : root.sessions.findIndex(entry => entry.id === root.selectedSessionId)
    const next = root.sessions[index + 1]
    if (next) root.selectConversation(next.id)
    else root.sessionSelected("")
  }

  Shortcut {
    sequences: ["Alt+0", "Meta+Alt+0"]
    context: Qt.WindowShortcut
    enabled: root.visible && root.animationsEnabled && root.Window.window !== null && root.Window.window.active
    onActivated: root.sessionSelected("")
  }

  Shortcut {
    sequence: "Meta+Alt+Tab"
    context: Qt.WindowShortcut
    enabled: root.visible && root.animationsEnabled && root.keyboardFocused
    onActivated: root.nextTab()
  }

  // These are local to this focused panel, never desktop-global bindings.
  // Numbers follow the same current order as Q1–Q9 in the tab rail.
  Instantiator {
    model: Math.min(root.sessions.length, 9)
    delegate: Shortcut {
      required property int index
      sequence: "Alt+" + (index + 1)
      context: Qt.WindowShortcut
      enabled: root.visible && root.animationsEnabled && root.Window.window !== null && root.Window.window.active
      onActivated: {
        root.selectConversation(root.sessions[index].id)
      }
    }
  }

  // Activity remains the first tab. Questions get their own vertically stacked
  // tabs, scrollable independently of the conversation itself.
  Rectangle {
    id: rail
    width: 64 * root.unit
    height: parent.height
    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.035)

    Rectangle {
      objectName: "activityTab"
      anchors.top: parent.top
      anchors.topMargin: 20 * root.unit
      anchors.horizontalCenter: parent.horizontalCenter
      width: 48 * root.unit
      height: 64 * root.unit
      color: !root.showingPrevious && root.selectedSession === null ? root.selection : "transparent"

      Rectangle {
        width: 2 * root.unit
        height: parent.height
        color: !root.showingPrevious && root.selectedSession === null ? root.accent : "transparent"
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
      Accessible.selected: !root.showingPrevious && root.selectedSession === null
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
      anchors.bottomMargin: 82 * root.unit
      contentHeight: tabs.height
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      Column {
        id: tabs
        width: parent.width
        spacing: 8 * root.unit
        Repeater {
          model: root.sessions
          SessionTab {
            required property var modelData
            required property int index
            objectName: "tab-" + modelData.id
            anchors.horizontalCenter: parent.horizontalCenter
            title: modelData.title
            number: index + 1
            selected: !root.showingPrevious && root.selectedSessionId === modelData.id
            online: root.online
            foreground: root.foreground
            muted: root.muted
            accent: root.accent
            selection: root.selection
            tooltipBackground: root.tooltipBackground
            tooltipForeground: root.tooltipForeground
            tooltipBorder: root.tooltipBorder
            fontFamily: root.fontFamily
            unit: root.unit
            onSelectedRequested: root.sessionSelected(modelData.id)
            onCloseRequested: root.dismissSessionRequested(modelData.id)
          }
        }
      }
    }
  }

  Rectangle {
    objectName: "previousSessionsButton"
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 12 * root.unit
    x: 8 * root.unit
    width: 48 * root.unit
    height: 60 * root.unit
    radius: 5 * root.unit
    color: root.showingPrevious || previousMouse.containsMouse ? root.selection : "transparent"
    Text {
      anchors.centerIn: parent
      text: "◷\nPrevious\nsessions"
      horizontalAlignment: Text.AlignHCenter
      color: root.showingPrevious ? root.accent : root.muted
      font.family: root.fontFamily
      font.pixelSize: 9 * root.unit
      lineHeight: 1.2
    }
    MouseArea {
      id: previousMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.previousRequested()
    }
    Accessible.role: Accessible.PageTab
    Accessible.name: "Previous sessions"
    Accessible.selected: root.showingPrevious
    Accessible.onPressAction: root.previousRequested()
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
      text: root.showingPrevious ? "Previous sessions" : root.selectedSession ? root.selectedSession.title : "Companion"
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
        color: closeMouse.containsMouse ? root.accent : root.muted
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

    Text {
      id: actionError
      objectName: "sessionControlError"
      y: 38 * root.unit
      width: parent.width
      visible: text !== ""
      text: root.controlError
      textFormat: Text.PlainText
      color: "#ef5350"
      wrapMode: Text.Wrap
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    ActivityStrip {
      id: activityStrip
      objectName: "activityStrip"
      visible: root.selectedSession !== null || root.showingPrevious
      y: 44 * root.unit + (actionError.visible ? actionError.height + 12 * root.unit : 0)
      width: parent.width
      online: root.online
      paused: root.paused
      pauseReason: root.pauseReason
      speaking: root.speaking
      processing: root.processing
      history: root.history
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      animationsEnabled: root.animationsEnabled
    }

    PreviousSessionsView {
      visible: root.showingPrevious
      anchors.fill: parent
      anchors.topMargin: activityStrip.y + activityStrip.height + 12 * root.unit
      sessions: root.previousSessions
      online: root.online
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      onReopenRequested: id => root.reopenSessionRequested(id)
    }

    ActivityView {
      objectName: "fullActivityStatus"
      visible: !root.showingPrevious && root.selectedSession === null
      anchors.fill: parent
      anchors.topMargin: 48 * root.unit + (actionError.visible ? actionError.height + 12 * root.unit : 0)
      online: root.online
      paused: root.paused
      pauseReason: root.pauseReason
      speaking: root.speaking
      processing: root.processing
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      fontFamily: root.fontFamily
      unit: root.unit
      animationsEnabled: root.animationsEnabled && visible
      history: root.history
      intents: root.intents
      selection: root.selection
      shortcutLabel: root.shortcutLabel
      onIntentEnabledRequested: (name, enabled) => root.intentEnabledRequested(name, enabled)
    }

    SessionView {
      id: chat
      objectName: "sessionView"
      visible: root.selectedSession !== null
      anchors.fill: parent
      anchors.topMargin: activityStrip.y + activityStrip.height + 12 * root.unit
      session: root.selectedSession
      online: root.online
      focusShortcut: root.focusShortcut
      foreground: root.foreground
      muted: root.muted
      accent: root.accent
      selection: root.selection
      fontFamily: root.fontFamily
      unit: root.unit
      onScreenshotRequested: (source, title) => root.screenshotRequested(source, title)
      onStopRequested: id => root.stopSessionRequested(id)
      onDismissRequested: id => root.dismissSessionRequested(id)
      onSendRequested: (id, text) => root.sendSessionRequested(id, text)
    }

  }
}
