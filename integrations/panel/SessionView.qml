import QtQuick
import QtQuick.Controls
import QtQuick.Window
import "Markdown.mjs" as Markdown

// Chat rendering is independent of Pi and Omarchy. Stable ListModel rows keep
// selection and expanded tool bubbles intact while text deltas update a row.
Item {
  id: root
  required property var session
  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property string fontFamily
  // Shell chrome may be monospace (Omarchy's default). Conversation text needs
  // its own proportional face so Markdown's native code font stays distinct.
  property string proseFontFamily: {
    const available = Qt.fontFamilies()
    return ["Adwaita Sans", "Inter", "Segoe UI", "Noto Sans"].find(name => available.includes(name)) || "sans-serif"
  }
  property bool online: true
  // The desktop host supplies the shortcut; other hosts can leave it unset.
  property string focusShortcut: ""
  property real unit: 1
  // One zoom level follows the reader between tabs for this panel lifetime.
  property int zoomPercent: 100
  property real scrollSpeed: 3
  readonly property real textScale: root.unit * root.zoomPercent / 100
  readonly property bool zoomEnabled: visible && session !== null && root.Window.window !== null && root.Window.window.active
  property string displayedId: ""
  property bool followEnd: true
  property var drafts: ({})
  property var pendingSubmission: null
  property string inputError: ""
  property var selectedMessage: null
  readonly property bool hasMessageSelection: selectedMessage !== null && selectedMessage.visible && selectedMessage.selectedText !== ""
  readonly property bool running: session && (session.status === "starting" || session.status === "running")
  readonly property int messageCount: messages.count
  readonly property bool canSend: online && session !== null && !running && pendingSubmission === null
    && composer.text.trim().length > 0 && composer.text.length <= 4000
  readonly property string composerFocusId: online && visible && composer.activeFocus
    && root.Window.window && root.Window.window.active ? displayedId : ""
  signal stopRequested(string id)
  signal dismissRequested(string id)
  signal sendRequested(string id, string text)
  signal screenshotRequested(url source, string title)

  function zoomBy(amount) { root.zoomPercent = Math.max(80, Math.min(200, root.zoomPercent + amount)) }

  function clearMessageSelection() {
    const previous = root.selectedMessage
    root.selectedMessage = null
    if (previous) previous.deselect()
  }

  function messageSelectionChanged(item) {
    if (item.selectedText !== "") {
      if (root.selectedMessage !== item) root.clearMessageSelection()
      root.selectedMessage = item
      composer.deselect()
    } else if (root.selectedMessage === item) {
      root.selectedMessage = null
    }
  }

  function copySelectedMessage() {
    if (!root.hasMessageSelection) return false
    root.selectedMessage.copy()
    return true
  }

  // A hidden plain-text buffer copies a whole message without moving keyboard
  // focus or disturbing the reader's selection. Assistant copies keep Markdown.
  TextEdit { id: copyBuffer; visible: false; textFormat: TextEdit.PlainText }
  function copyMessage(text) {
    copyBuffer.text = text
    copyBuffer.selectAll()
    copyBuffer.copy()
    copyBuffer.text = ""
  }

  // Window shortcuts also work while text is selected or the composer owns
  // focus. They never register with the compositor or affect other apps.
  Shortcut {
    sequences: [StandardKey.Copy]
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled && root.hasMessageSelection
    onActivated: root.copySelectedMessage()
  }
  Shortcut {
    sequences: ["Ctrl++", "Ctrl+=", "Ctrl+Shift++"]
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomBy(10)
  }
  Shortcut {
    sequence: "Ctrl+-"
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomBy(-10)
  }
  Shortcut {
    sequence: "Ctrl+0"
    context: Qt.WindowShortcut
    enabled: root.zoomEnabled
    onActivated: root.zoomPercent = 100
  }

  function focusComposer() {
    if (root.online && root.visible && root.session) composer.forceActiveFocus(Qt.ShortcutFocusReason)
  }

  function releaseComposerFocus() { composer.focus = false }

  function submit() {
    if (!root.canSend) return
    root.inputError = ""
    root.pendingSubmission = {id: root.session.id, text: composer.text}
    root.sendRequested(root.session.id, composer.text)
  }

  function submitted(id, text, error) {
    if (!root.pendingSubmission || root.pendingSubmission.id !== id || root.pendingSubmission.text !== text) return
    root.pendingSubmission = null
    root.inputError = error || ""
    if (!error) {
      if (root.drafts[id] === text) delete root.drafts[id]
      if (root.displayedId === id && composer.text === text) composer.text = ""
    }
  }

  function enterPressed(event) {
    event.accepted = true
    if (event.modifiers & Qt.ShiftModifier) {
      composer.insert(composer.cursorPosition, "\n")
    } else {
      root.submit()
    }
  }

  function followLatestMessage() {
    if (root.followEnd) {
      transcript.positionViewAtEnd()
    }
  }

  function synchronize() {
    const id = root.session ? root.session.id : ""
    if (id !== root.displayedId) {
      root.clearMessageSelection()
      if (root.displayedId) root.drafts[root.displayedId] = composer.text
      messages.clear()
      root.displayedId = id
      root.followEnd = true
      composer.text = root.drafts[id] || ""
      root.inputError = ""
    }

    const incoming = root.session ? root.session.messages : []
    for (let index = 0; index < incoming.length; index++) {
      const message = incoming[index]
      const row = {messageId: message.id, kind: message.kind, body: message.text,
        toolName: message.toolName, input: message.input, state: message.state,
        screenshot: message.screenshot, screenshotUrl: message.screenshotUrl || ""}
      if (index < messages.count) {
        messages.set(index, row)
      } else {
        messages.append(row)
      }
    }
    while (messages.count > incoming.length) {
      messages.remove(messages.count - 1)
    }
    Qt.callLater(root.followLatestMessage)
  }

  onSessionChanged: synchronize()
  onVisibleChanged: Qt.callLater(root.followLatestMessage)
  Component.onCompleted: synchronize()
  ListModel { id: messages }

  ListView {
    id: transcript
    objectName: "sessionTranscript"
    anchors.fill: parent
    anchors.bottomMargin: inputSection.height + 12 * root.unit
    clip: true
    spacing: 12 * root.unit
    model: messages
    boundsBehavior: Flickable.StopAtBounds
    onMovementEnded: root.followEnd = atYEnd
    onContentHeightChanged: Qt.callLater(root.followLatestMessage)
    onHeightChanged: Qt.callLater(root.followLatestMessage)

    // Handle the transcript's wheel events before selectable message text.
    // Pixel deltas retain precise touchpad motion; wheel notches use the
    // desktop's line count. Both are faster without changing shell-wide input.
    WheelHandler {
      parent: transcript
      target: null
      acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
      onWheel: event => {
        const pixels = event.pixelDelta.y || event.angleDelta.y / 120 * Qt.styleHints.wheelScrollLines * 24 * root.unit
        if (pixels === 0) {
          event.accepted = false
          return
        }

        transcript.cancelFlick()
        root.followEnd = false
        const beginning = transcript.originY
        const end = beginning + Math.max(0, transcript.contentHeight - transcript.height)
        transcript.contentY = Math.max(beginning, Math.min(end, transcript.contentY - pixels * root.scrollSpeed))
        // Changing contentY directly does not emit movementEnded. Update this
        // now, before a queued streaming update can jump back to the bottom.
        root.followEnd = transcript.atYEnd
        event.accepted = true
      }
    }

    ScrollBar.vertical: ScrollBar {
      visible: transcript.contentHeight > transcript.height
      contentItem: Rectangle { color: root.muted; radius: 2; implicitWidth: 4 }
    }

    delegate: Rectangle {
      id: bubble
      required property string messageId
      required property string kind
      required property string body
      required property string toolName
      required property string input
      required property string state
      required property bool screenshot
      required property string screenshotUrl
      property bool expanded: false
      objectName: "bubble-" + messageId
      width: transcript.width - 8 * root.unit
      height: contents.implicitHeight + 20 * root.unit
      radius: 6 * root.unit
      color: kind === "user" ? root.selection
        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)

      HoverHandler { id: messageHover }

      Column {
        id: contents
        x: 10 * root.unit
        y: 10 * root.unit
        width: parent.width - 20 * root.unit
        spacing: 8 * root.unit

        Text {
          id: heading
          width: parent.width - copyButton.width - 8 * root.unit
          height: Math.max(implicitHeight, copyButton.height)
          verticalAlignment: Text.AlignVCenter
          text: bubble.kind === "tool" ? (bubble.expanded ? "▾ " : "▸ ") + bubble.toolName
            + (bubble.state === "running" ? " · running" : bubble.state === "error" ? " · failed or stopped" : "")
            : bubble.kind === "user" ? "You" + (bubble.screenshot ? (bubble.screenshotUrl ? " · screenshot attached" : " · screenshot unavailable") : "") : "Pi"
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          color: bubble.state === "error" ? "#ef5350" : root.muted
          font.family: root.fontFamily
          font.pixelSize: 10 * root.unit

          MouseArea {
            anchors.fill: parent
            enabled: bubble.kind === "tool"
            cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: bubble.expanded = !bubble.expanded
          }
          Accessible.role: bubble.kind === "tool" ? Accessible.Button : Accessible.StaticText
          Accessible.name: text
          Accessible.onPressAction: if (bubble.kind === "tool") bubble.expanded = !bubble.expanded
        }

        Rectangle {
          objectName: "screenshotThumbnail"
          visible: bubble.kind === "user" && bubble.screenshot && bubble.screenshotUrl !== ""
          width: parent.width
          height: visible ? 132 * root.unit : 0
          radius: 6 * root.unit
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.color: thumbnailHover.containsMouse ? root.accent : "transparent"
          Image {
            id: thumbnail
            anchors.fill: parent
            anchors.margins: 6 * root.unit
            source: parent.visible ? bubble.screenshotUrl : ""
            sourceSize.width: 600
            asynchronous: true
            fillMode: Image.PreserveAspectFit
          }
          Rectangle {
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.margins: 8 * root.unit
            width: zoomLabel.width + 16 * root.unit
            height: 24 * root.unit
            radius: 12 * root.unit
            color: root.selection
            Text {
              id: zoomLabel
              anchors.centerIn: parent
              text: thumbnail.status === Image.Error ? "Screenshot unavailable" : "↗  Enlarge"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: 10 * root.unit
            }
          }
          MouseArea {
            id: thumbnailHover
            anchors.fill: parent
            hoverEnabled: true
            enabled: thumbnail.status === Image.Ready
            cursorShape: Qt.PointingHandCursor
            onClicked: root.screenshotRequested(bubble.screenshotUrl, root.session.title)
          }
          Accessible.role: Accessible.Button
          Accessible.name: "Enlarge attached screenshot"
          Accessible.onPressAction: if (thumbnail.status === Image.Ready) root.screenshotRequested(bubble.screenshotUrl, root.session.title)
        }

        TextEdit {
          id: messageText
          objectName: "messageText"
          width: parent.width
          height: visible ? contentHeight : 0
          visible: bubble.kind !== "tool" || bubble.expanded
          text: bubble.kind === "assistant" ? Markdown.render(bubble.body, root.textScale, root.selection.toString(), root.accent.toString())
            : bubble.kind === "tool" ? bubble.input + (bubble.body ? "\n\n" + bubble.body : "") : bubble.body
          textFormat: bubble.kind === "assistant" ? TextEdit.RichText : TextEdit.PlainText
          readOnly: true
          selectByMouse: true
          activeFocusOnPress: false
          onSelectedTextChanged: root.messageSelectionChanged(messageText)
          Component.onDestruction: if (root.selectedMessage === messageText) root.selectedMessage = null
          onVisibleChanged: if (!visible && root.selectedMessage === messageText) root.clearMessageSelection()
          wrapMode: TextEdit.Wrap
          color: root.foreground
          selectionColor: root.selection
          selectedTextColor: root.foreground
          font.family: bubble.kind === "tool" ? "monospace" : root.proseFontFamily
          font.pixelSize: (bubble.kind === "tool" ? 14 : 16) * root.textScale
          onLinkActivated: link => {
            // Opening a link is an explicit click; commands and file URLs do
            // not become executable UI actions through generated Markdown.
            if (/^https?:\/\//i.test(link)) Qt.openUrlExternally(link)
          }
        }
      }

      Rectangle {
        id: copyButton
        objectName: "copyMessage"
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 10 * root.unit
        width: 58 * root.unit
        height: 24 * root.unit
        radius: 4 * root.unit
        color: root.selection
        opacity: messageHover.hovered || copyMouse.containsMouse || copied.running ? 1 : 0
        visible: messageText.text !== ""
        Behavior on opacity { NumberAnimation { duration: 120 } }
        function activate() {
          const source = bubble.kind === "tool" ? bubble.input + (bubble.body ? "\n\n" + bubble.body : "") : bubble.body
          root.copyMessage(source)
          copied.restart()
        }
        Timer { id: copied; interval: 1400 }
        Text {
          anchors.centerIn: parent
          text: copied.running ? "Copied" : "Copy"
          color: copyMouse.containsMouse || copied.running ? root.accent : root.foreground
          font.family: root.proseFontFamily
          font.pixelSize: 11 * root.unit
        }
        MouseArea {
          id: copyMouse
          anchors.fill: parent
          hoverEnabled: true
          enabled: copyButton.opacity > 0.5
          cursorShape: Qt.PointingHandCursor
          onClicked: copyButton.activate()
        }
        Accessible.role: Accessible.Button
        Accessible.name: "Copy message"
        Accessible.onPressAction: activate()
      }
    }

    footer: Text {
      width: transcript.width - 8 * root.unit
      text: root.session && root.session.error ? root.session.error : ""
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.fontFamily
      font.pixelSize: 12 * root.unit
    }
  }

  Column {
    id: inputSection
    anchors.bottom: parent.bottom
    width: parent.width
    spacing: 8 * root.unit

    ScrollView {
      id: composerScroll
      width: parent.width
      height: 76 * root.textScale
      contentWidth: availableWidth
      clip: true
      TextArea {
        id: composer
        objectName: "sessionComposer"
        width: composerScroll.availableWidth
        placeholderText: !root.composerFocusId && root.focusShortcut
          ? root.focusShortcut + " to focus"
          : root.running ? "Write a follow-up while Pi answers…" : "Ask a follow-up…"
        placeholderTextColor: root.muted
        color: root.foreground
        selectionColor: root.selection
        selectedTextColor: root.foreground
        wrapMode: TextEdit.Wrap
        textFormat: TextEdit.PlainText
        selectByMouse: true
        padding: 8 * root.unit
        font.family: root.proseFontFamily
        font.pixelSize: 16 * root.textScale
        background: Rectangle {
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
          border.color: composer.activeFocus ? root.accent : root.muted
          radius: 4 * root.unit
        }
        onTextChanged: {
          if (root.displayedId) root.drafts[root.displayedId] = text
        }
        onSelectedTextChanged: if (selectedText !== "") root.clearMessageSelection()
        TapHandler { onPressedChanged: if (pressed) root.clearMessageSelection() }
        // TextArea consumes the standard copy key before window shortcuts.
        // When the reader selected a message, route that same key explicitly;
        // otherwise leave ordinary composer copying to TextArea.
        Keys.onPressed: event => {
          if (event.matches(StandardKey.Copy) && root.copySelectedMessage()) event.accepted = true
        }
        Keys.onReturnPressed: event => root.enterPressed(event)
        Keys.onEnterPressed: event => root.enterPressed(event)
        Accessible.name: "Message to the selected agent session"
      }
    }

    Text {
      width: parent.width
      visible: text !== ""
      text: composer.text.length > 4000 ? "Keep messages under 4000 characters." : root.inputError
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: "#ef5350"
      font.family: root.fontFamily
      font.pixelSize: 11 * root.unit
    }

    Row {
      spacing: 8 * root.unit
      PanelAction {
        objectName: "sendSession"
        enabled: root.canSend
        text: "Send"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.submit()
      }
      PanelAction {
        objectName: "stopSession"
        visible: root.running
        enabled: root.online
        text: "Stop"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.stopRequested(root.session.id)
      }
      PanelAction {
        objectName: "dismissSession"
        enabled: root.online && root.session !== null
        text: "Close session"
        foreground: root.foreground
        selection: root.selection
        fontFamily: root.fontFamily
        unit: root.unit
        onTriggered: root.dismissRequested(root.session.id)
      }
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: !root.online ? "Disconnected" : root.running ? "Answering…"
          : root.session && root.session.status === "cancelled" ? "Stopped"
          : root.session && root.session.status === "error" ? "Failed" : "Done"
        textFormat: Text.PlainText
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 10 * root.unit
      }
    }
  }
}
