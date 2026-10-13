import QtQuick
import QtQuick.Controls

// The conversation header's timer control: a compact clock with the number of
// pending timers, which opens a bounded overlay listing the conversation's
// timers. It is hidden while nothing is pending, running or needs attention;
// finished timers stay reachable through the conversation menu (openHistory).
//
// Input: the selected conversation's `wakes` projection (active timers plus
// recent finished ones; see src/desktop/README.md, Native self-wake visibility).
// Output: cancelRequested with the existing conversation and timer IDs.
// Attention comes from current terminal states only (failed, blocked,
// delivery-uncertain); viewing the overlay never clears or acknowledges it.
// Opening, scrolling and closing the overlay never change timers, the draft,
// keyboard focus or the transcript's position.
Item {
  id: root
  property var session: null
  property bool online: true
  required property color background
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  property real unit: 1
  // Narrow headers drop words from the button, never the counts.
  property bool compact: false
  // Overlay geometry, relative to this control, supplied by the host: it
  // prefers to start at `overlayTop` with up to `maximumHeight`, and never
  // extends above `overlayCeiling` (it may cover the header when the panel is
  // too short below it). Its right edge lines up with the conversation area's,
  // `overlayRightInset` beyond this control's.
  property real overlayTop: height + 6 * unit
  property real overlayCeiling: -height
  property real overlayRightInset: 0
  property real maximumWidth: 360 * unit
  property real maximumHeight: 400 * unit
  // A narrow header may fold this button into the conversation menu, which
  // then opens the overlay (open()).
  property bool buttonVisible: true
  readonly property real buttonWidth: button.width
  signal cancelRequested(string id, string timerId)

  readonly property var timers: session && session.wakes ? session.wakes : []
  // Scheduled and waiting timers are the only pending count, as on the tab.
  readonly property var pending: timers.filter(timer => timer.state === "scheduled" || timer.state === "waiting")
  // Dispatching and started timers are cancellable but no longer pending.
  readonly property var running: timers.filter(timer => timer.state === "dispatching" || timer.state === "started")
  readonly property var attention: timers.filter(timer => root.needsAttention(timer.state))
  readonly property var finished: timers.filter(timer => !root.active(timer.state) && !root.needsAttention(timer.state))
  readonly property bool shown: pending.length + running.length + attention.length > 0
  readonly property int historyCount: attention.length + finished.length
  readonly property color overlayColor: Qt.tint(Qt.rgba(background.r, background.g, background.b, 1), selection)
  readonly property color warning: "#f0a35e"
  readonly property string summary: {
    const parts = [root.pending.length + " pending"]
    if (root.running.length > 0) parts.push(root.running.length + " running")
    if (root.attention.length > 0) parts.push(root.attention.length + (root.attention.length === 1 ? " needs" : " need") + " attention")
    return parts.join(" · ")
  }
  readonly property bool opened: overlay.opened

  visible: shown || overlay.opened
  implicitWidth: shown && buttonVisible ? button.width : 0
  implicitHeight: button.height

  function active(state) {
    return state === "scheduled" || state === "waiting" || state === "dispatching" || state === "started"
  }

  function needsAttention(state) {
    return state === "failed" || state === "blocked" || state === "delivery-uncertain"
  }

  function stateLabel(timer) {
    const labels = {scheduled: "Scheduled", waiting: "Waiting", dispatching: "Starting", started: "Running",
      completed: "Completed", failed: "Failed", cancelled: "Cancelled", superseded: "Replaced",
      expired: "Expired", blocked: "Blocked", "delivery-uncertain": "Delivery uncertain"}
    return labels[timer.state] || timer.state
  }

  // "In 18 min · 14:30 CEST": relative first, then the local time and zone;
  // other days include the date.
  function dueLabel(timer, now) {
    const due = new Date(timer.dueAt)
    const sameDay = due.toDateString() === new Date(now).toDateString()
    const clock = Qt.formatDateTime(due, sameDay ? "hh:mm t" : "ddd d MMM hh:mm t")
    if (!root.active(timer.state) || timer.state === "started") return clock
    const minutes = Math.ceil(Math.abs(timer.dueAt - now) / 60000)
    const span = minutes < 60 ? minutes + " min" : Math.floor(minutes / 60) + " h" + (minutes % 60 ? " " + minutes % 60 + " min" : "")
    return (timer.dueAt >= now ? "In " : "Overdue ") + span + " · " + clock
  }

  function toggle() {
    if (overlay.opened) {
      overlay.close()
    } else {
      overlay.historyExpanded = false
      overlay.open()
    }
  }

  function open() {
    overlay.historyExpanded = false
    overlay.open()
  }

  function openHistory() {
    overlay.historyExpanded = true
    overlay.open()
  }

  function close() { overlay.close() }

  // Another conversation's timers never stay open under this one's header.
  onSessionChanged: if (overlay.opened && (!session || session.id !== overlay.ownerId)) overlay.close()

  Rectangle {
    id: button
    objectName: "timerButton"
    visible: root.shown && root.buttonVisible
    width: buttonLabel.implicitWidth + 16 * root.unit
    height: 28 * root.unit
    radius: 4 * root.unit
    color: buttonMouse.containsMouse || overlay.opened ? root.selection : "transparent"
    border.color: root.attention.length > 0 ? root.warning : Qt.rgba(root.muted.r, root.muted.g, root.muted.b, 0.5)
    Text {
      id: buttonLabel
      objectName: "timerButtonLabel"
      anchors.centerIn: parent
      text: root.attention.length > 0 ? (root.compact ? "! " : "! Attention · ") + root.attention.length
        : root.pending.length > 0 ? "◷ " + root.pending.length
        : root.compact ? "◷ ▸" : "◷ Running"
      textFormat: Text.PlainText
      color: root.attention.length > 0 ? root.warning : buttonMouse.containsMouse ? root.accent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: 12 * root.unit
    }
    MouseArea {
      id: buttonMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.toggle()
    }
    ToolTip.visible: buttonMouse.containsMouse && !overlay.opened
    ToolTip.delay: 400
    ToolTip.text: "Timers: " + root.summary
    Accessible.role: Accessible.Button
    Accessible.name: "Timers: " + root.summary
    Accessible.onPressAction: root.toggle()
  }

  // Escape closes the overlay without taking focus from the composer.
  Shortcut {
    sequence: "Escape"
    context: Qt.WindowShortcut
    enabled: overlay.opened
    onActivated: overlay.close()
  }

  Popup {
    id: overlay
    objectName: "timerOverlay"
    property string ownerId: ""
    property bool historyExpanded: false
    property double now: Date.now()
    // Not modal and never focused: the transcript, draft and focus stay as
    // they were. A press outside (other than the button) closes it.
    modal: false
    focus: false
    closePolicy: Popup.CloseOnPressOutsideParent
    padding: 0
    width: Math.min(360 * root.unit, root.maximumWidth)
    // Its content's height within the room below the header, but never less
    // than the fixed header plus a usable strip of list: when the panel is too
    // short for that below the header, the overlay moves up rather than out
    // of the panel. It never exceeds the whole region the host allows.
    readonly property real bottomLimit: root.overlayTop + Math.max(0, root.maximumHeight)
    readonly property real usableHeight: header.height + 48 * root.unit
    height: Math.min(Math.max(usableHeight, Math.min(header.height + list.contentHeight + 12 * root.unit, root.maximumHeight)),
      Math.max(0, bottomLimit - root.overlayCeiling))
    x: root.width + root.overlayRightInset - width
    y: Math.max(root.overlayCeiling, Math.min(root.overlayTop, bottomLimit - height))
    onAboutToShow: {
      ownerId = root.session ? root.session.id : ""
      now = Date.now()
    }
    Timer { interval: 1000; repeat: true; running: overlay.opened; onTriggered: overlay.now = Date.now() }
    background: Rectangle {
      color: root.overlayColor
      radius: 6 * root.unit
      border.color: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.45)
    }

    contentItem: Item {
      // Only the title and close stay fixed, so the list below always keeps
      // room; the summary scrolls with the timers.
      Item {
        id: header
        width: parent.width
        height: Math.max(closeOverlay.y + closeOverlay.height, title.y + title.implicitHeight) + 4 * root.unit
        Text {
          id: title
          x: 14 * root.unit
          y: 10 * root.unit
          text: "Timers"
          textFormat: Text.PlainText
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: 14 * root.unit
          font.bold: true
        }
        Rectangle {
          id: closeOverlay
          objectName: "closeTimerOverlay"
          anchors.right: parent.right
          anchors.rightMargin: 6 * root.unit
          y: 4 * root.unit
          width: 28 * root.unit
          height: width
          radius: 4 * root.unit
          color: closeMouse.containsMouse ? root.selection : "transparent"
          Text {
            anchors.centerIn: parent
            text: "×"
            color: closeMouse.containsMouse ? root.accent : root.muted
            font.family: root.fontFamily
            font.pixelSize: 18 * root.unit
          }
          MouseArea {
            id: closeMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: overlay.close()
          }
          Accessible.role: Accessible.Button
          Accessible.name: "Close timers"
          Accessible.onPressAction: overlay.close()
        }
      }

      Flickable {
        id: list
        objectName: "timerList"
        y: header.height
        width: parent.width
        height: parent.height - header.height
        contentHeight: rows.implicitHeight + 6 * root.unit
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar {
          visible: list.contentHeight > list.height
          contentItem: Rectangle { color: root.muted; radius: 2; implicitWidth: 4 }
        }

        Column {
          id: rows
          x: 14 * root.unit
          width: list.width - 28 * root.unit
          spacing: 10 * root.unit

          Text {
            id: summaryText
            objectName: "timerSummary"
            width: parent.width
            text: root.summary + " · this conversation"
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: 11 * root.unit
          }

          Text {
            visible: root.pending.length + root.running.length + root.attention.length === 0
            width: parent.width
            text: "No pending timers."
            textFormat: Text.PlainText
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: 12 * root.unit
          }

          Repeater {
            model: root.attention.concat(root.running, root.pending)
            delegate: Rectangle {
              id: entry
              required property var modelData
              readonly property bool warn: root.needsAttention(modelData.state)
              readonly property bool cancellable: root.active(modelData.state)
              // In a narrow overlay, Cancel moves below the text so labels
              // keep a readable width.
              readonly property bool stacked: rows.width < 260 * root.unit
              objectName: "timer-" + modelData.id
              width: rows.width
              height: details.implicitHeight + 16 * root.unit + (stacked && cancel.visible ? cancel.height + 6 * root.unit : 0)
              radius: 4 * root.unit
              color: warn ? Qt.rgba(0.94, 0.64, 0.37, 0.12) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
              Rectangle {
                visible: entry.warn
                width: 3 * root.unit
                height: parent.height
                color: root.warning
              }
              Column {
                id: details
                x: 10 * root.unit
                y: 8 * root.unit
                width: parent.width - 20 * root.unit - (cancel.visible && !entry.stacked ? cancel.width + 8 * root.unit : 0)
                spacing: 3 * root.unit
                Text {
                  objectName: "timerLabel"
                  width: parent.width
                  text: (entry.warn ? "! " : "") + entry.modelData.label + " · " + root.stateLabel(entry.modelData)
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  color: entry.warn ? root.warning : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: 12 * root.unit
                  font.bold: true
                }
                Text {
                  width: parent.width
                  text: root.dueLabel(entry.modelData, overlay.now)
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  color: root.accent
                  font.family: root.fontFamily
                  font.pixelSize: 11 * root.unit
                }
                Text {
                  objectName: "timerReason"
                  width: parent.width
                  visible: text !== ""
                  text: [entry.modelData.cancellationRequested ? "Cancellation requested" : "", entry.modelData.reason || ""]
                    .filter(part => part !== "").join(" · ")
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  color: entry.warn ? root.foreground : root.muted
                  font.family: root.fontFamily
                  font.pixelSize: 11 * root.unit
                }
              }
              PanelAction {
                id: cancel
                objectName: "cancelWakeButton"
                visible: entry.cancellable
                enabled: root.online
                anchors.right: parent.right
                anchors.rightMargin: 8 * root.unit
                y: entry.stacked ? details.y + details.implicitHeight + 6 * root.unit : 8 * root.unit
                text: "Cancel"
                foreground: root.foreground
                selection: root.selection
                fontFamily: root.fontFamily
                unit: root.unit
                onTriggered: if (root.online && root.session) root.cancelRequested(root.session.id, entry.modelData.id)
                Accessible.name: "Cancel timer " + entry.modelData.label
              }
            }
          }

          // Finished timers stay secondary: collapsed unless opened from the
          // conversation menu's timer history.
          Text {
            id: historyToggle
            objectName: "timerHistoryToggle"
            visible: root.finished.length > 0
            width: parent.width
            text: (overlay.historyExpanded ? "▾ " : "▸ ") + "Finished timers · " + root.finished.length
            textFormat: Text.PlainText
            color: historyMouse.containsMouse ? root.accent : root.muted
            font.family: root.fontFamily
            font.pixelSize: 12 * root.unit
            MouseArea {
              id: historyMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: overlay.historyExpanded = !overlay.historyExpanded
            }
            Accessible.role: Accessible.Button
            Accessible.name: (overlay.historyExpanded ? "Hide" : "Show") + " finished timers"
            Accessible.onPressAction: overlay.historyExpanded = !overlay.historyExpanded
          }

          Repeater {
            model: overlay.historyExpanded ? root.finished : []
            delegate: Text {
              required property var modelData
              objectName: "finishedTimer-" + modelData.id
              width: rows.width
              text: modelData.label + " · " + root.stateLabel(modelData) + " · "
                + Qt.formatDateTime(new Date(modelData.transitionedAt || modelData.dueAt), "ddd d MMM hh:mm")
                + (modelData.reason ? "\n" + modelData.reason : "")
              textFormat: Text.PlainText
              wrapMode: Text.Wrap
              color: root.muted
              font.family: root.fontFamily
              font.pixelSize: 11 * root.unit
            }
          }
        }
      }
    }
  }
}
